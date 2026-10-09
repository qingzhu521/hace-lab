import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const moduleId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const refs = z.array(z.string().max(40)).min(1).max(8);
export const overviewSchema = z.object({
  architectureHtml: z.string().trim().min(100).max(50000).optional(),
  purpose: z.object({ text, sourceIds: refs }).strict(),
  // Optional fields preserve overviews saved before module relationships were introduced.
  modules: z.array(z.object({ id: moduleId.optional(), name: text, responsibility: text, sourceIds: refs }).strict()).min(1).max(8),
  relations: z.array(z.object({ from: moduleId, to: moduleId, description: z.string().trim().min(1).max(500), sourceIds: refs }).strict()).max(24).optional(),
  scenarios: z.array(z.object({ name: text, action: text, expectedResult: text,
    readingSteps: z.array(z.object({ explanation: text, sourceId: z.string().max(40) }).strict()).min(1).max(6),
  }).strict()).max(4),
  unknowns: z.array(text).max(8),
}).strict();
export const sourceSchema = z.object({
  id: z.string(), path: z.string(), hash: z.string(), startLine: z.number().int().positive(),
  endLine: z.number().int().positive(), excerpt: z.string(),
});
export const runSchema = z.object({
  workspaceId: z.string(), root: z.string(), runId: z.string(), sessionId: z.string(),
  provider: z.string(), model: z.string(), createdAt: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  step: z.number().int().nonnegative(), activity: z.string(), error: z.string().optional(),
  sources: z.array(sourceSchema), overview: overviewSchema.optional(),
});
export const snapshotSchema = z.object({
  run: runSchema.nullable(), stalePaths: z.array(z.string()), checkedAt: z.string(),
});
export type Overview = z.infer<typeof overviewSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type OverviewRun = z.infer<typeof runSchema>;
export type OverviewSnapshot = z.infer<typeof snapshotSchema>;

export function validateOverview(value: unknown, sources: Source[]): Overview {
  const result = overviewSchema.parse(value);
  if (!result.architectureHtml) throw new Error('Supply architectureHtml with a self-contained architecture page.');
  if (!result.relations || result.modules.some(module => !module.id)) {
    throw new Error('Each module requires an id. Supply relations; use [] when evidence is insufficient.');
  }
  const moduleIds = new Set(result.modules.map(module => module.id));
  if (moduleIds.size !== result.modules.length) throw new Error('Module ids must be unique.');
  const pairs = new Set<string>();
  for (const relation of result.relations) {
    if (!moduleIds.has(relation.from) || !moduleIds.has(relation.to)) throw new Error('Relation endpoints must reference existing module ids.');
    if (relation.from === relation.to) throw new Error('Only describe relationships between different modules.');
    const pair = `${relation.from}:${relation.to}`;
    if (pairs.has(pair)) throw new Error('Combine repeated relationships into one description per directed pair.');
    pairs.add(pair);
  }
  const known = new Set(sources.map(source => source.id));
  const referenced = [...result.purpose.sourceIds, ...result.modules.flatMap(item => item.sourceIds),
    ...result.relations.flatMap(relation => relation.sourceIds),
    ...result.scenarios.flatMap(item => item.readingSteps.map(step => step.sourceId))];
  if (referenced.some(id => !known.has(id))) throw new Error('Each sourceId must refer to a file excerpt returned by read_project_file.');
  return result;
}
