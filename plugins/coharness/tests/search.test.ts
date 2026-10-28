import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectReader } from '../src/overview/reader.ts';

test('项目搜索返回行号并跳过隐藏、依赖和符号链接', async t => {
  const root = await mkdtemp(join(tmpdir(), 'coharness-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'app.ts'), 'const alpha = 1;\nconst beta = 2;\nconst alphabet = 3;\n');
  await writeFile(join(root, '.env'), 'alpha secret');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'dep.js'), 'alpha dependency');
  await symlink(join(root, 'src'), join(root, 'linked'));
  const reader = await ProjectReader.create(root);
  const result = await reader.search('alpha', 10);
  assert.deepEqual(result.matches.map(match => [match.path, match.line]), [['src/app.ts', 1], ['src/app.ts', 3]]);
  assert.equal(result.matches.some(match => match.path.startsWith('.env') || match.path.startsWith('node_modules') || match.path.startsWith('linked')), false);
  assert.equal(result.truncated, false);
  await assert.rejects(reader.search('a'), /2 到 200/);
  await assert.rejects(reader.search('alpha', 100), /1 到 60/);
});
