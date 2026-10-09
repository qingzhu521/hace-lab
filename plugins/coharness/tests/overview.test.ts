import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { CreateAgentOptions } from '@deepseek-ai/dsh-agent';
import { LIMITS, ProjectReader } from '../src/overview/reader.ts';
import { validateOverview, type OverviewRun } from '../src/overview/schema.ts';
import { generateOverview } from '../src/overview/runner.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'coharness-test-'));
  await writeFile(join(root, 'README.md'), 'A test calculator.\nUsers add two numbers.\nImplementation: src/add.ts');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/add.ts'), 'export const add = (a: number, b: number) => a + b;');
  return root;
}
function content(sourceId = 'source-1') {
  return { architectureHtml: '<article><h1>Calculator architecture</h1><details><summary>Calculator</summary><p>The calculator adds two numbers.</p></details></article>', purpose: { text: 'A test calculator.', sourceIds: [sourceId] },
    modules: [{ id: 'calculator', name: 'Calculator', responsibility: 'Adds numbers.', sourceIds: [sourceId] }],
    relations: [],
    scenarios: [{ name: 'Add', action: 'Enter numbers.', expectedResult: 'Receive a sum.',
      readingSteps: [{ explanation: 'Read the usage contract.', sourceId }] }], unknowns: ['Runtime behavior is unverified.'] };
}

test('reader binds excerpts to exact file versions and detects edits and deletion', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true }));
  const reader = await ProjectReader.create(root);
  const source = await reader.read('README.md', 2);
  assert.equal(source.startLine, 2); assert.equal(source.endLine, 3);
  assert.match(source.excerpt, /Users add/);
  assert.deepEqual(await reader.stalePaths(reader.sources), []);
  await writeFile(join(root, 'README.md'), 'changed');
  assert.deepEqual(await reader.stalePaths(reader.sources), ['README.md']);
  await rm(join(root, 'README.md'));
  assert.deepEqual(await reader.stalePaths(reader.sources), ['README.md']);
});

test('reader rejects escapes, symlinks, credentials, binary and oversized files', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true }));
  await writeFile(join(root, '.env'), 'secret');
  await writeFile(join(root, 'credentials.json'), 'secret');
  await writeFile(join(root, 'binary'), Buffer.from([0, 1]));
  await writeFile(join(root, 'large'), Buffer.alloc(LIMITS.fileBytes + 1, 'a'));
  await symlink('/etc', join(root, 'outside'));
  await symlink(join(root, 'src'), join(root, 'inside'));
  const reader = await ProjectReader.create(root);
  for (const path of ['/etc/passwd', '../outside', '.env', 'credentials.json', 'outside/passwd', 'inside/add.ts', 'binary', 'large']) {
    await assert.rejects(reader.read(path), path);
  }
  const names = (await reader.list()).entries.map(entry => entry.name);
  assert.equal(names.includes('.env'), false); assert.equal(names.includes('outside'), false);
});

test('reader paginates directories and bounds excerpts and total reads', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true }));
  for (let i = 0; i < LIMITS.entries + 4; i++) await writeFile(join(root, `file-${i}`), 'text');
  await writeFile(join(root, 'lines'), Array.from({ length: 240 }, (_, i) => `line ${i}`).join('\n'));
  const reader = await ProjectReader.create(root);
  const first = await reader.list();
  assert.equal(first.entries.length, LIMITS.entries);
  const second = await reader.list('.', first.nextOffset!);
  assert.equal(new Set([...first.entries, ...second.entries].map(item => item.name)).size, LIMITS.entries + 7);
  const excerpt = await reader.read('lines');
  assert.equal(excerpt.endLine, 120);
  for (let i = 1; i < LIMITS.reads; i++) await reader.read('README.md');
  await assert.rejects(reader.read('README.md'), /budget/);
  await assert.rejects(reader.list('.', 0, AbortSignal.abort()));
});

test('overview rejects fabricated citations and unknown model fields', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true }));
  const reader = await ProjectReader.create(root); await reader.read('README.md');
  assert.equal(validateOverview(content(), reader.sources).modules.length, 1);
  assert.throws(() => validateOverview(content('invented'), reader.sources), /sourceId/);
  assert.throws(() => validateOverview({ ...content(), verified: true }, reader.sources));
});

// This controlled agent drives plugin boundaries; it never contacts a provider.
function harness(root: string, mode: 'success' | 'missing' | 'cancel' = 'success') {
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>();
  const listeners = new Map<string, (...args: any[]) => any>();
  let guard: (value: { name: string }) => string | undefined;
  let disposed = false; let concluded = false; let resolveIdle: () => void;
  let task: Promise<void>;
  const controller = new AbortController();
  const scope = { tools: {
    restrict: (value: unknown) => assert.deepEqual(value, { allow: [] }),
    presentAs: (value: unknown) => assert.equal(value, 'native'),
    guard: (value: typeof guard) => { guard = value; },
    register: (definition: any) => { definitions.set(definition.name, definition); },
  }, on: (name: string, value: any) => listeners.set(name, value) };
  const invoke = async (name: string, args: unknown) => {
    assert.equal(guard({ name }), undefined);
    return definitions.get(name)!.execute(args, { signal: controller.signal, concludeTurn: () => { concluded = true; } });
  };
  const agent = {
    followup: (message: any) => {
      assert.equal(message.role, 'user'); assert.ok(message.id);
      task = (async () => {
        await listeners.get('agent/pre-step')!({ step: 1 }, async () => ({ kind: 'enter' }));
        if (mode === 'cancel') return new Promise<void>(resolve => { resolveIdle = resolve; });
        if (mode === 'missing') return;
        assert.ok(guard({ name: 'bash' })); assert.ok(guard({ name: 'run_code' }));
        const list = JSON.parse(await invoke('list_project_directory', { path: '.' }));
        assert.ok(list.entries.find((entry: any) => entry.name === 'README.md'));
        const source = JSON.parse(await invoke('read_project_file', { path: 'README.md' }));
        await assert.rejects(invoke('submit_project_overview', { overview: content('fabricated') }));
        assert.equal(concluded, false);
        await invoke('submit_project_overview', { overview: content(source.id) });
      })();
    },
    whenIdle: () => task,
    cancel: () => { controller.abort(); resolveIdle?.(); },
  };
  const ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: { create: async (options: CreateAgentOptions) => {
      await options.setup!(scope as unknown as Context, agent as any);
      return { agent, dispose: async () => { disposed = true; } };
    } } } as unknown as Context;
  const run: OverviewRun = { workspaceId: 'test', root, runId: 'test-run', sessionId: 'test-session',
    provider: 'test', model: 'test', createdAt: '', status: 'running', step: 0, activity: '', sources: [] };
  return { ctx, run, listeners, disposed: () => disposed, concluded: () => concluded };
}

test('overview runner reads evidence before accepting output and closes its agent', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true }));
  const mock = harness(root);
  const result = await generateOverview(mock.ctx, mock.run, new AbortController().signal, () => {});
  assert.equal(result.reader.sources.length, 1);
  assert.equal(result.overview.purpose.text, 'A test calculator.');
  assert.ok(mock.concluded()); assert.ok(mock.disposed());
});

test('overview runner rejects incomplete output and enforces the step limit', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true }));
  const mock = harness(root, 'missing');
  await assert.rejects(generateOverview(mock.ctx, mock.run, new AbortController().signal, () => {}), /missing-overview/);
  assert.ok(mock.disposed());
  assert.deepEqual(await mock.listeners.get('agent/pre-step')!({ step: LIMITS.steps + 1 }, () => assert.fail('limit ignored')), { kind: 'reject' });
});

test('overview cancellation stops the active agent and disposes its scope', async t => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true }));
  const mock = harness(root, 'cancel'); const controller = new AbortController();
  const promise = generateOverview(mock.ctx, mock.run, controller.signal, () => { setImmediate(() => controller.abort()); });
  await assert.rejects(promise); assert.ok(mock.disposed());
});

test('service serializes duplicate starts and restores saved output without another model call', async t => {
  const { createOverviewService } = await import('../src/overview/service.ts');
  const root = await fixture(); t.after(() => rm(root, { recursive: true }));
  const mock = harness(root);
  const tables = new Map<string, Map<string, unknown>>();
  const disposers: (() => Promise<void>)[] = [];
  const domain = { table: (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    const records = tables.get(name)!;
    return { get: (id: string) => records.get(id), put: async (id: string, value: unknown) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      records.set(id, structuredClone(value));
    } };
  }, close: async () => {} };
  Object.assign(mock.ctx, {
    storageDomain: { open: async () => domain },
    workspaceRegistry: { get: (id: string) => id === 'workspace' ? { id, path: root } : undefined },
    effect: (setup: () => () => Promise<void>) => { disposers.push(setup()); },
  });
  const service = await createOverviewService(mock.ctx);
  const starts = await Promise.all([service.start('workspace'), service.start('workspace')]);
  assert.equal(starts[0].run?.runId, starts[1].run?.runId);
  let state = await service.snapshot('workspace');
  for (let i = 0; i < 100 && state.run?.status === 'running'; i++) {
    await new Promise<void>(resolve => setImmediate(resolve)); state = await service.snapshot('workspace');
  }
  assert.equal(state.run?.status, 'completed');
  assert.equal(tables.get('runs')?.size, 1);
  await disposers.shift()!();
  const restored = await createOverviewService(mock.ctx);
  assert.equal((await restored.snapshot('workspace')).run?.overview?.modules.length, 1);
  await writeFile(join(root, 'README.md'), 'The project has changed.');
  assert.deepEqual((await restored.snapshot('workspace')).stalePaths, ['README.md']);
  await assert.rejects(restored.start('unknown'), /workspace-missing/);
  await disposers.shift()!();
});

test('service reports interrupted persisted runs after restart', async () => {
  const { createOverviewService } = await import('../src/overview/service.ts');
  const run: OverviewRun = { workspaceId: 'workspace', root: '/tmp', runId: 'old', sessionId: 'old-session',
    provider: 'test', model: 'test', createdAt: '', status: 'running', step: 2, activity: 'model', sources: [] };
  let close: () => Promise<void>;
  const ctx = { workspaceRegistry: { get: () => ({ path: '/tmp' }) },
    storageDomain: { open: async () => ({ table: (name: string) => ({ get: () => name === 'latest' ? { runId: 'old' } : run }), close: async () => {} }) },
    effect: (setup: () => () => Promise<void>) => { close = setup(); } } as unknown as Context;
  const service = await createOverviewService(ctx);
  assert.equal((await service.snapshot('workspace')).run?.status, 'interrupted');
  assert.equal(run.status, 'running');
  await close!();
});
