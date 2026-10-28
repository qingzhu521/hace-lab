import test from 'node:test';
import assert from 'node:assert/strict';
import { planEdits, type FileState } from '../src/ide/patch.ts';

function state(content: string): Map<string, FileState> {
  return new Map([['app.ts', { exists: true, content }]]);
}

function edit(find: string, replace: string, extra: any = {}) {
  return { path: 'app.ts', find, replace, reason: '原因。', expected: '预期。', sourceIds: ['source-1'], ...extra };
}

test('单处替换绑定最终行号和文件内容', () => {
  const content = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const [write] = planEdits(state(content), [edit('const b = 2;', 'const b = 20;')]);
  assert.equal(write!.content, 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
  assert.deepEqual(write!.edits.map(item => [item.start, item.end]), [[2, 2]]);
});

test('多处替换按位置累计行号', () => {
  const content = 'one\ntwo\nthree\nfour\n';
  const [write] = planEdits(state(content), [
    edit('one', 'one\nextra'),
    edit('four', 'FOUR'),
  ]);
  assert.equal(write!.content, 'one\nextra\ntwo\nthree\nFOUR\n');
  assert.deepEqual(write!.edits.map(item => [item.start, item.end]), [[1, 2], [5, 5]]);
});

test('歧义、重叠和不存在的目标都会阻止整批修改', () => {
  assert.throws(() => planEdits(state('a\na\n'), [edit('a', 'b')]), /出现多次/);
  assert.throws(() => planEdits(state('abcdef\n'), [edit('abc', 'x'), edit('cde', 'y')]), /重叠/);
  assert.throws(() => planEdits(state('abc\n'), [edit('zzz', 'x')]), /没有找到/);
  assert.throws(() => planEdits(new Map([['app.ts', { exists: false, content: '' }]]), [edit('a', 'b')]), /不存在/);
});

test('创建文件要求文件不存在且只提交一条创建修改', () => {
  const files = new Map([['new.ts', { exists: false, content: '' }]]);
  const [write] = planEdits(files, [{ ...edit('', 'export const x = 1;\n'), path: 'new.ts', create: true }]);
  assert.equal(write!.content, 'export const x = 1;\n');
  assert.deepEqual(write!.edits.map(item => [item.start, item.end]), [[1, 2]]);
  assert.throws(() => planEdits(new Map([['new.ts', { exists: true, content: 'x' }]]), [{ ...edit('', 'y'), path: 'new.ts', create: true }]), /已经存在/);
  assert.throws(() => planEdits(files, [{ ...edit('', 'y'), path: 'new.ts', create: true }, { ...edit('', 'z'), path: 'new.ts', create: true }]), /只能提交一条/);
});

test('空替换允许删除目标范围并记录空范围', () => {
  const [write] = planEdits(state('a\nremove\nb\n'), [edit('remove\n', '')]);
  assert.equal(write!.content, 'a\nb\n');
  assert.deepEqual(write!.edits.map(item => [item.start, item.end]), [[2, 1]]);
});
