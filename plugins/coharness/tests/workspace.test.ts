import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client';
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client';
import { createWorkspaceHandler } from '../src/index.ts';
import { registerRpc } from '../src/rpc.ts';
import { ENDPOINT, isWorkspaceInfo } from '../src/protocol.ts';
import { selectWorkspace } from '../src/client/selection.ts';

const workspaceId = 'workspace-a' as WorkspaceId;
const sessionId = 'session-a' as WorkspaceView['sessionIds'][number];
const view: WorkspaceView = { workspaceId, title: 'Arbitrary project', path: '/projects/任意目录',
  sessionIds: [sessionId], createdAt: '', updatedAt: '' };
const workspace = { id: workspaceId, title: view.title, path: view.path, sessionIds: [sessionId] };
const handler = createWorkspaceHandler({ get: id => id === workspaceId ? workspace : undefined });
const peer = {} as Context['connection']['operator'];
const request = (payload: unknown, endpoint = ENDPOINT) => handler(endpoint, payload, new AbortController().signal, peer);

test('host resolves only registered workspace IDs', async () => {
  assert.deepEqual(await request({ workspaceId }), { ok: true, value: {
    workspaceId, title: view.title, path: view.path, sessionCount: 1,
  } });
  assert.equal((await request({ workspaceId: '/etc' })).ok, false);
  assert.equal((await request({ workspaceId: 'removed' })).ok, false);
});

test('host rejects malformed payloads and unknown operations', async () => {
  for (const payload of [null, [], {}, { path: '/tmp' }, { workspaceId: 123 }, { workspaceId: '' }]) {
    assert.equal((await request(payload)).ok, false);
  }
  assert.equal((await request({ workspaceId }, 'modify')).ok, false);
});

test('wire validation rejects invalid workspace information', () => {
  assert.ok(isWorkspaceInfo({ workspaceId, title: 'A', path: '/a', sessionCount: 0 }));
  assert.equal(isWorkspaceInfo({ workspaceId, title: 'A', path: '/a', sessionCount: -1 }), false);
  assert.equal(isWorkspaceInfo(null), false);
});

function catalogs(active = true): { sessions: SessionListState; workspaces: WorkspaceSnapshot } {
  return {
    sessions: { ids: [sessionId], phase: 'ready', projectionsBySession: {}, byId: {
      [sessionId]: { id: sessionId, displayTitle: 'A', running: false, blank: true,
        retainedBy: active ? { mainView: 1 } : {}, updatedAt: 0 },
    } },
    workspaces: { items: [view], archivedSessionIds: [], pinnedSessionIds: [],
      state: 'idle', phase: 'ready', error: null },
  };
}

test('panel follows the retained main session instead of choosing the first directory', () => {
  const { sessions, workspaces } = catalogs();
  const reordered = { ...workspaces, items: [{ ...view, workspaceId: 'other' as WorkspaceId, path: '/other', sessionIds: [] }, view] };
  assert.deepEqual(selectWorkspace(sessions, reordered), { kind: 'selected', workspace: view });
  assert.deepEqual(selectWorkspace(catalogs(false).sessions, reordered), { kind: 'empty' });
});

test('panel distinguishes loading, failed lookup, and removed workspace', () => {
  const { sessions, workspaces } = catalogs();
  assert.deepEqual(selectWorkspace({ ...sessions, phase: 'pending' }, workspaces), { kind: 'loading' });
  assert.deepEqual(selectWorkspace(sessions, { ...workspaces, items: [] }), { kind: 'missing' });
  assert.deepEqual(selectWorkspace(sessions, { ...workspaces, state: 'error' }), { kind: 'unavailable' });
});

test('registered fetch handler preserves RPC correlation and validates envelopes', async () => {
  let route: Parameters<Context['connection']['fetch']['register']>[0] | undefined;
  registerRpc({ connection: { operator: peer, fetch: { register: (value: typeof route) => { route = value; } } },
    workspaceRegistry: { get: () => workspace } } as unknown as Context, ENDPOINT, handler);
  assert.ok(route);
  assert.equal(route.path, '/api/coharness/workspace');
  assert.deepEqual(route.methods, ['POST']);
  const response = await route.fetch(new Request('http://localhost/api/coharness/workspace', { method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'test-1', method: ENDPOINT, payload: { workspaceId } }),
  }));
  const body = await response.json();
  assert.equal(body.rpcId, 'test-1');
  assert.equal(body.result.value.path, view.path);
  for (const body of ['{', '{}', JSON.stringify({ type: 'client-request', rpcId: '1', method: 'other', payload: {} })]) {
    const response = await route.fetch(new Request('http://localhost/api/coharness/workspace', { method: 'POST', body }));
    assert.equal(response.status, 400);
  }
});
