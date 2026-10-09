export const CHANNEL = '/api';
export const OVERVIEW_ENDPOINT = 'coharness/overview';
export const ENDPOINT = 'coharness/workspace';

export interface WorkspaceInfo {
  workspaceId: string;
  title: string;
  path: string;
  sessionCount: number;
}

export function isWorkspaceInfo(value: unknown): value is WorkspaceInfo {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.workspaceId === 'string'
    && typeof row.title === 'string'
    && typeof row.path === 'string'
    && Number.isSafeInteger(row.sessionCount)
    && (row.sessionCount as number) >= 0;
}
