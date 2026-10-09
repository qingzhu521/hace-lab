import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { LIMITS, ProjectReader } from './reader.ts';
import { runSchema, type OverviewRun, type OverviewSnapshot } from './schema.ts';
import { generateOverview } from './runner.ts';

export const overviewDomain = defineDomain({ name: 'coharness_overview', version: 1,
  tables: { runs: domainTable(runSchema), latest: domainTable(runSchema.pick({ runId: true })) } });

type Job = { run: OverviewRun; controller: AbortController; done: Promise<void> };
export async function createOverviewService(ctx: Context) {
  const domain = await ctx.storageDomain.open(overviewDomain);
  const jobs = new Map<string, Job>();
  let closed = false;
  function workspace(id: string) {
    const result = ctx.workspaceRegistry.get(id as WorkspaceId);
    if (!result) throw new Error('workspace-missing');
    return result;
  }
  async function snapshot(id: string): Promise<OverviewSnapshot> {
    const selected = workspace(id);
    const runId = domain.table('latest').get(id)?.runId;
    const saved = runId ? domain.table('runs').get(runId) : undefined;
    const active = jobs.get(id);
    let run: OverviewRun | null = active?.run ?? (saved ? structuredClone(saved) : null);
    if (run && run.root !== selected.path) run = null;
    if (run?.status === 'running' && !active) run = { ...run, status: 'interrupted', error: 'host-restarted' };
    const stalePaths = run?.status === 'completed'
      ? await (await ProjectReader.create(selected.path)).stalePaths(run.sources) : [];
    return { run: run ? structuredClone(run) : null, stalePaths, checkedAt: new Date().toISOString() };
  }
  async function start(id: string): Promise<OverviewSnapshot> {
    if (closed) throw new Error('service-closed');
    const selected = workspace(id);
    if (jobs.get(id)?.run.status === 'running') return snapshot(id);
    const model = ctx.agentDefaultModel.currentSelection();
    const run: OverviewRun = { workspaceId: id, root: selected.path, runId: randomUUID(),
      sessionId: `coharness-${randomUUID()}`, provider: model.provider, model: model.model,
      createdAt: new Date().toISOString(), status: 'running', step: 0, activity: 'starting', sources: [] };
    const controller = new AbortController();
    const job: Job = { run, controller, done: Promise.resolve() };
    // Reserve synchronously before persistence prevents duplicate model runs.
    jobs.set(id, job);
    try {
      await domain.table('runs').put(run.runId, structuredClone(run));
      await domain.table('latest').put(id, { runId: run.runId });
    } catch (error) { jobs.delete(id); throw error; }
    job.done = (async () => {
      const timeout = setTimeout(() => controller.abort(new Error('timeout')), LIMITS.durationMs);
      try {
        const result = await generateOverview(ctx, run, controller.signal, (step, activity) => {
          run.step = step; run.activity = activity;
        });
        controller.signal.throwIfAborted();
        run.overview = result.overview;
        run.sources = result.reader.sources;
        run.status = 'completed';
        run.activity = 'completed';
      } catch (error) {
        const timedOut = controller.signal.reason instanceof Error && controller.signal.reason.message === 'timeout';
        run.status = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';
        run.error = timedOut ? 'timeout' : error instanceof Error ? error.message : 'generation-failed';
      } finally {
        clearTimeout(timeout);
        try { await domain.table('runs').put(run.runId, structuredClone(run)); }
        catch { run.status = 'failed'; run.error = 'storage-failed'; }
        // Keep failed persistence visible until a subsequent run replaces it.
        if (run.error !== 'storage-failed') jobs.delete(id);
      }
    })();
    return snapshot(id);
  }
  async function cancel(id: string, runId: string) {
    workspace(id);
    const job = jobs.get(id);
    if (job?.run.runId === runId) job.controller.abort();
    return snapshot(id);
  }
  ctx.effect(() => async () => {
    closed = true;
    for (const job of jobs.values()) job.controller.abort();
    await Promise.allSettled([...jobs.values()].map(job => job.done));
    await domain.close();
  });
  return { snapshot, start, cancel };
}
