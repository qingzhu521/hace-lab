import type { Overview } from '../overview/schema.ts';

export const STORY_NODE_WIDTH = 148;
export const STORY_NODE_HEIGHT = 62;

export interface StoryModule {
  id: string;
  name: string;
  responsibility: string;
  sourceIds: string[];
}

export interface StoryRelation {
  from: string;
  to: string;
  description: string;
}

export interface StoryNode extends StoryModule {
  layer: number;
  order: number;
  x: number;
  y: number;
}

export interface StoryEdge {
  id: string;
  from: string;
  to: string;
  description: string;
  path: string;
}

export interface StoryGraph {
  nodes: StoryNode[];
  edges: StoryEdge[];
  width: number;
  height: number;
}

export interface StoryStep {
  key: string;
  kind: 'purpose' | 'modules' | 'scenario';
  title: string;
  detail: string;
  sourceIds: string[];
  moduleIds: string[];
  scenarioIndex?: number;
}

export interface StoryTrack {
  id: string;
  label: string;
  steps: StoryStep[];
}

export interface Story {
  modules: StoryModule[];
  relations: StoryRelation[];
  graph: StoryGraph;
  tracks: StoryTrack[];
}

const MAX_MODULES = 8;
const MAX_RELATIONS = 24;
const MAX_SCENARIOS = 4;
const MAX_STEPS = 6;

export function storyModules(overview: Overview): StoryModule[] {
  const used = new Set<string>();
  return overview.modules.slice(0, MAX_MODULES).map((module, index) => {
    let id = module.id?.trim() || `module-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return { id, name: module.name, responsibility: module.responsibility, sourceIds: module.sourceIds ?? [] };
  });
}

export function storyRelations(overview: Overview, modules: StoryModule[]): StoryRelation[] {
  const known = new Set(modules.map(module => module.id));
  const pairs = new Set<string>();
  const relations: StoryRelation[] = [];
  for (const relation of overview.relations ?? []) {
    if (!known.has(relation.from) || !known.has(relation.to) || relation.from === relation.to) continue;
    const pair = `${relation.from}:${relation.to}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    relations.push({ from: relation.from, to: relation.to, description: relation.description });
    if (relations.length === MAX_RELATIONS) break;
  }
  return relations;
}

export function storyTracks(overview: Overview, modules: StoryModule[], relations: StoryRelation[]): StoryTrack[] {
  const allSources = [...new Set(modules.flatMap(module => module.sourceIds))];
  const overviewSteps: StoryStep[] = [
    { key: 'purpose', kind: 'purpose', title: '项目用途', detail: overview.purpose.text,
      sourceIds: overview.purpose.sourceIds, moduleIds: modules.map(module => module.id) },
    { key: 'modules', kind: 'modules', title: `${modules.length} 个模块的分工`, detail: relations.length
      ? `模型记录了 ${modules.length} 个模块和 ${relations.length} 条依赖关系。用户可以在上方选择场景，观看一次使用流程。`
      : `模型记录了 ${modules.length} 个模块，但没有给出可靠的模块依赖。动画只展示模块组成。`,
      sourceIds: allSources, moduleIds: modules.map(module => module.id) },
  ];
  const tracks: StoryTrack[] = [{ id: 'overview', label: '总览', steps: overviewSteps }];
  for (const [scenarioIndex, scenario] of overview.scenarios.slice(0, MAX_SCENARIOS).entries()) {
    const steps: StoryStep[] = scenario.readingSteps.slice(0, MAX_STEPS).map((reading, stepIndex) => {
      const matched = modules.filter(module => module.sourceIds.includes(reading.sourceId));
      return {
        key: `scenario-${scenarioIndex}-${stepIndex}`,
        kind: 'scenario',
        title: matched.length ? matched.map(module => module.name).join(' / ') : `第 ${stepIndex + 1} 步`,
        detail: reading.explanation,
        sourceIds: [reading.sourceId],
        moduleIds: matched.map(module => module.id),
        scenarioIndex,
      };
    });
    tracks.push({ id: `scenario-${scenarioIndex}`, label: scenario.name, steps });
  }
  return tracks;
}

function gridLayout(modules: StoryModule[]): StoryGraph {
  const count = modules.length;
  const columns = count <= 2 ? Math.max(1, count) : count <= 4 ? 2 : count <= 6 ? 3 : 4;
  const rows = Math.ceil(count / columns);
  const gapX = 24;
  const gapY = 28;
  const width = Math.max(560, columns * STORY_NODE_WIDTH + (columns - 1) * gapX + 48);
  const height = Math.max(220, rows * STORY_NODE_HEIGHT + (rows - 1) * gapY + 48);
  const nodes: StoryNode[] = modules.map((module, index) => {
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, count - row * columns);
    const column = index % columns;
    const offset = (width - (inRow * STORY_NODE_WIDTH + (inRow - 1) * gapX)) / 2;
    return { ...module, layer: 0, order: index,
      x: offset + column * (STORY_NODE_WIDTH + gapX),
      y: 24 + row * (STORY_NODE_HEIGHT + gapY) };
  });
  return { nodes, edges: [], width, height };
}

function edgePath(from: StoryNode, to: StoryNode): string {
  const startX = from.x + STORY_NODE_WIDTH / 2;
  const startY = from.y + STORY_NODE_HEIGHT;
  const endX = to.x + STORY_NODE_WIDTH / 2;
  const endY = to.y;
  const bend = Math.max(42, Math.abs(endY - startY) / 2);
  return `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`;
}

function layeredLayout(modules: StoryModule[], relations: StoryRelation[]): StoryGraph {
  const layers = new Map(modules.map(module => [module.id, 0]));
  for (let pass = 0; pass < modules.length; pass++) {
    let changed = false;
    for (const relation of relations) {
      const from = layers.get(relation.from);
      const to = layers.get(relation.to);
      if (from === undefined || to === undefined) continue;
      const next = Math.min(4, from + 1);
      if (next > to) { layers.set(relation.to, next); changed = true; }
    }
    if (!changed) break;
  }
  const grouped = new Map<number, StoryModule[]>();
  for (const module of modules) {
    const layer = layers.get(module.id) ?? 0;
    if (!grouped.has(layer)) grouped.set(layer, []);
    grouped.get(layer)!.push(module);
  }
  const maxLayer = Math.max(0, ...grouped.keys());
  const gapX = 24;
  const gapY = 52;
  const widest = Math.max(...[...grouped.values()].map(items => items.length), 1);
  const width = Math.max(560, widest * STORY_NODE_WIDTH + (widest - 1) * gapX + 48);
  const height = Math.max(240, (maxLayer + 1) * (STORY_NODE_HEIGHT + gapY) + 32);
  const nodes: StoryNode[] = [];
  let order = 0;
  for (const [layer, items] of [...grouped.entries()].sort(([left], [right]) => left - right)) {
    const rowWidth = items.length * STORY_NODE_WIDTH + (items.length - 1) * gapX;
    const offset = (width - rowWidth) / 2;
    items.forEach((module, column) => {
      nodes.push({ ...module, layer, order: order++,
        x: offset + column * (STORY_NODE_WIDTH + gapX),
        y: 24 + layer * (STORY_NODE_HEIGHT + gapY) });
    });
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const edges = relations.flatMap(relation => {
    const from = byId.get(relation.from);
    const to = byId.get(relation.to);
    if (!from || !to) return [];
    return [{ id: `${relation.from}->${relation.to}`, from: relation.from, to: relation.to,
      description: relation.description, path: edgePath(from, to) }];
  });
  return { nodes, edges, width, height };
}

export function storyGraph(modules: StoryModule[], relations: StoryRelation[]): StoryGraph {
  if (!modules.length) return { nodes: [], edges: [], width: 560, height: 200 };
  return relations.length ? layeredLayout(modules, relations) : gridLayout(modules);
}

export function buildStory(overview: Overview): Story {
  const modules = storyModules(overview);
  const relations = storyRelations(overview, modules);
  return { modules, relations, graph: storyGraph(modules, relations), tracks: storyTracks(overview, modules, relations) };
}
