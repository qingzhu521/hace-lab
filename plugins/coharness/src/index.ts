import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-workspace';
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace/types';
import { ENDPOINT, OVERVIEW_ENDPOINT, type WorkspaceInfo } from './protocol.ts';

import { createIdeService } from './ide/service.ts';
import { registerRpc } from './rpc.ts';
import { createOverviewService } from './overview/service.ts';

export const name = 'coharness';
export const inject = ['connection', 'workspaceRegistry', 'agents', 'agentDefaultModel', 'tools', 'storageDomain', 'sessionPersistence'];

export function createWorkspaceHandler(registry: {
  get(id: WorkspaceId): Pick<Workspace, 'id' | 'title' | 'path' | 'sessionIds'> | undefined;
}): ConnectionRpcHandler {
  return async (endpoint, payload) => {
    if (endpoint !== ENDPOINT) {
      return { ok: false, error: { code: 'coharness/unknown-endpoint', message: 'Unknown endpoint', details: {} } };
    }
    if (typeof payload !== 'object' || payload === null
      || !('workspaceId' in payload) || typeof payload.workspaceId !== 'string'
      || payload.workspaceId.length === 0) {
      return { ok: false, error: { code: 'coharness/invalid-request', message: 'workspaceId is required', details: {} } };
    }
    const workspace = registry.get(payload.workspaceId as WorkspaceId);
    if (!workspace) {
      return { ok: false, error: { code: 'coharness/workspace-missing', message: 'Workspace is no longer registered', details: {} } };
    }
    const value: WorkspaceInfo = {
      workspaceId: workspace.id,
      title: workspace.title,
      path: workspace.path,
      sessionCount: workspace.sessionIds.length,
    };
    return { ok: true, value };
  };
}

export async function apply(ctx: Context): Promise<void> {
  registerRpc(ctx, ENDPOINT, createWorkspaceHandler(ctx.workspaceRegistry));
  const ide = await createIdeService(ctx);
  registerRpc(ctx, 'coharness/ide', async (_endpoint, payload) => {
    try { return { ok: true, value: await ide(payload) }; }
    catch (error) { return { ok: false, error: { code: 'coharness/ide-error', message: error instanceof Error ? error.message : '操作失败。', details: {} } }; }
  });
  const overview = await createOverviewService(ctx);
  registerRpc(ctx, OVERVIEW_ENDPOINT, async (_endpoint, payload) => {
    if (typeof payload !== 'object' || payload === null
      || !('workspaceId' in payload) || typeof payload.workspaceId !== 'string' || !payload.workspaceId
      || !('operation' in payload) || !['get', 'start', 'cancel'].includes(String(payload.operation))
      || (payload.operation === 'cancel' && (!('runId' in payload) || typeof payload.runId !== 'string' || !payload.runId))) {
      return { ok: false, error: { code: 'coharness/invalid-request', message: 'Invalid overview request', details: {} } };
    }
    try {
      const id = payload.workspaceId;
      const value = payload.operation === 'start' ? await overview.start(id)
        : payload.operation === 'cancel' && 'runId' in payload && typeof payload.runId === 'string'
          ? await overview.cancel(id, payload.runId) : await overview.snapshot(id);
      return { ok: true, value };
    } catch {
      return { ok: false, error: { code: 'coharness/overview-unavailable', message: 'Project overview is unavailable', details: {} } };
    }
  });
}
