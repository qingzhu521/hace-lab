import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectFiles, git } from '../src/ide/files.ts';
import { Store } from '../src/ide/store.ts';
import { IdeWorkspace } from '../src/ide/workspace.ts';
import { VerificationRunner } from '../src/ide/verification.ts';

async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'coharness-actions-'));
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
  const ide = new IdeWorkspace(files, store);
  return { root, files, store, ide, rows };
}

test('提交只接受非空说明，并记录提交文件', async t => {
  const { root, ide, store } = await fixture(t);
  await writeFile(join(root, 'app.ts'), 'export const value = 2;\n');
  await assert.rejects(ide.commit({ message: '' }), /提交说明/);
  const result = await ide.commit({ message: '把值改为 2' });
  assert.equal(result.subject, '把值改为 2');
  assert.deepEqual(result.files, ['app.ts']);
  assert.match((await git(root, ['log', '-1', '--format=%s'])).stdout.toString(), /把值改为 2/);
  assert.ok(Object.values(store.values()).some((value: any) => value?.commit === result.commit));
});

test('批注绑定文件版本，并出现在快照中', async t => {
  const { ide } = await fixture(t);
  const snapshot = await ide.snapshot();
  const file = snapshot.files[0]!;
  await assert.rejects(ide.annotation({ path: file.path, text: '' }), /批注内容/);
  const annotation = await ide.annotation({ path: file.path, change: 'change-1', version: file.version, basis: snapshot.basis, text: '请补充边界测试。' });
  assert.equal(annotation.text, '请补充边界测试。');
  const next = await ide.snapshot();
  assert.equal(next.annotations.length, 1);
  assert.equal(next.annotations[0]!.stale, false);
});

test('验证器只列出插件声明的固定脚本', async t => {
  const { root, files, store } = await fixture(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'coharness-dsh', scripts: { test: 'node --test', typecheck: 'tsc', build: 'node build.mjs', deploy: 'rm -rf /' } }));
  const runner = new VerificationRunner(files, store);
  const state = await runner.state();
  assert.deepEqual(state.scripts.map(script => script.name), ['test', 'typecheck', 'build']);
  assert.equal(state.scripts.every(script => script.command.startsWith('pnpm run ')), true);
  await assert.rejects(runner.start('deploy'), /不支持/);
});

test('快照返回模型动机并标记过期文件', async t => {
  const { ide, store } = await fixture(t);
  const snapshot = await ide.snapshot();
  const file = snapshot.files[0]!;
  await store.put('rationale:one', {
    id: 'one', path: 'app.ts', start: 1, end: 1, reason: '初始原因。', expected: '初始结果。',
    postVersion: file.version, time: new Date().toISOString(),
  }, 'test');
  const current = await ide.snapshot();
  assert.equal(current.rationales.length, 1);
  assert.equal(current.rationales[0]!.stale, false);
  await writeFile(join(current.root, 'app.ts'), 'export const value = 3;\n');
  const changed = await ide.snapshot();
  assert.equal(changed.rationales[0]!.stale, true);
});

