import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client';

export type Selection =
  | { kind: 'loading' | 'empty' | 'missing' | 'unavailable' }
  | { kind: 'selected'; workspace: WorkspaceView };

export function selectWorkspace(sessions: SessionListState, workspaces: WorkspaceSnapshot): Selection {
  if (workspaces.state === 'error') return { kind: 'unavailable' };
  if (sessions.phase === 'pending' || workspaces.phase === 'pending') return { kind: 'loading' };
  const current = Object.values(sessions.byId).find(session => (session.retainedBy.mainView ?? 0) > 0);
  if (!current) return { kind: 'empty' };
  const workspace = workspaces.items.find(item => item.sessionIds.includes(current.id));
  return workspace ? { kind: 'selected', workspace } : { kind: 'missing' };
}
