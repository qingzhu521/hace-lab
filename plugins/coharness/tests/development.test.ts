import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { ProjectFiles, git } from '../src/ide/files.ts';
import { Store } from '../src/ide/store.ts';
import { DevelopmentRunner } from '../src/ide/development.ts';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'coharness-dev-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-q']);
  await git(root, ['config', 'user.name', 'Test']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(root, 'app.ts'), 'export const value = 1;\n');
  await git(root, ['add', '.']);
  await git(root, ['commit', '-qm', 'fixture']);
  const files = new ProjectFiles(root, 'test');
  await files.initialize();
  const rows = new Map<string, any>();
  const store = new Store('test', { entries: () => rows.entries(), put: async (key, value) => { rows.set(key, value); } });
  return { root, files, store, rows };
}

function harness(root: string) {
  const definitions = new Map<string, any>();
  const listeners = new Map<string, any>();
  const controller = new AbortController();
  let task: Promise<void>;
  const scope = {
    tools: {
      restrict() {}, presentAs() {}, guard() {}, register(definition: any) { definitions.set(definition.name, definition); },
    },
    on(name: string, listener: any) { listeners.set(name, listener); },
  };
  const agent = {
    followup() {
      task = (async () => {
        await listeners.get('agent/pre-step')!({ step: 1 }, async () => ({ kind: 'enter' }));
        const read = await definitions.get('read_project_file')!.execute({ path: 'app.ts' }, { signal: controller.signal });
        const source = JSON.parse(read);
        await definitions.get('submit_development_proposal')!.execute({
          proposal: {
            summary: '把值改为 2。',
            edits: [{ path: 'app.ts', find: 'export const value = 1;', replace: 'export const value = 2;',
              reason: '需求要求值改为 2。', expected: '导出值等于 2。', sourceIds: [source.id] }],
          },
        }, { signal: controller.signal, concludeTurn() {} });
      })();
    },
    whenIdle: () => task,
    cancel() {},
  };
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: {
      create: async (options: any) => {
        await options.setup(scope, agent);
        return { agent, dispose: async () => {} };
      },
    },
  } as unknown as Context;
  return { ctx, definitions, listeners };
}

test('模型方案经过读取和校验后保存，应用写入文件并记录动机', async t => {
  const { root, files, store } = await fixture(t);
  const { ctx, definitions } = harness(root);
  const runner = new DevelopmentRunner(ctx, files, store);
  await runner.start('把导出值改为 2。');
  for (let index = 0; index < 100 && runner.state().run?.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 10));
  const state = runner.state();
  assert.equal(state.run?.status, 'completed');
  assert.ok(definitions.has('submit_development_proposal'));
  assert.equal(state.proposal?.edits.length, 1);
  assert.equal(state.proposal?.edits[0]!.evidence.length, 1);
  const applied = await runner.apply(state.proposal!.id);
  assert.equal(applied.proposal.status, 'applied');
  assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), 'export const value = 2;\n');
  const rationales = Object.values(store.values()).filter((value: any) => value?.reason === '需求要求值改为 2。');
  assert.equal(rationales.length, 1);
  assert.equal(rationales[0]!.evidence[0].path, 'app.ts');
});

test('改动被其他进程修改后，应用会拒绝写入', async t => {
  const { root, files, store } = await fixture(t);
  const { ctx } = harness(root);
  const runner = new DevelopmentRunner(ctx, files, store);
  await runner.start('把导出值改为 2。');
  for (let index = 0; index < 100 && runner.state().run?.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 10));
  const proposal = runner.state().proposal!;
  await writeFile(join(root, 'app.ts'), 'export const value = 3;\n');
  await assert.rejects(runner.apply(proposal.id), /没有找到 find 内容/);
  assert.equal(await readFile(join(root, 'app.ts'), 'utf8'), 'export const value = 3;\n');
});
