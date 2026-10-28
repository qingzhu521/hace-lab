import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../src/client/workbench/explain.js', import.meta.url), 'utf8');
const scope = createContext({});
runInContext(source, scope);
const explain = scope as unknown as {
  changeExplanation(file: any, change: any, context?: any): any;
  fileChangeSummary(file: any, context?: any): string;
};

const symbol = {
  id: 'calc.ts::add:1', name: 'add', parameters: 'a: number, b: number', start: 1, end: 3,
  path: 'calc.ts', callers: [{line: 8, expression: 'add(1, 2)'}], calls: [],
};

function modifiedFile() {
  return {
    path: 'calc.ts', kind: '修改', exists: true, baseExists: true,
    before: 'export function add(a: number, b: number) {\n  return a - b;\n}\n',
    after: 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
    addedLines: [2], removedLines: [2], symbols: [symbol],
    changes: [{id: 'change-1', start: 2, end: 2, oldStart: 2, oldEnd: 2, symbolId: symbol.id, title: '系统修改 add。'}],
  };
}

test('修改自述列出行号、增减行、函数和调用者', () => {
  const file = modifiedFile();
  const result = explain.changeExplanation(file, file.changes[0], {request: '修正加法结果。'});
  assert.equal(result.counts.added, 1);
  assert.equal(result.counts.removed, 1);
  assert.equal(result.added[0].line, 2);
  assert.equal(result.removed[0].text, '  return a - b;');
  assert.equal(result.symbol.name, 'add');
  assert.equal(result.callers.length, 1);
  assert.equal(result.callerCount, 1);
  assert.equal(result.range, 'L2–2 → L2–2');
  assert.match(result.summary, /add/);
  assert.match(result.summary, /新增 1 行/);
  assert.ok(result.checkpoints.some((item: string) => item.includes('同文件 1 处调用')));
  assert.equal(result.status, '待对齐');
});

test('修改自述绑定用户预期和任务阶段', () => {
  const file = modifiedFile();
  const result = explain.changeExplanation(file, file.changes[0], {
    request: '修正加法结果。', phase: '需求讨论',
    record: {expectation: '用户得到两个数的和。', status: '已对齐'},
  });
  assert.equal(result.request, '修正加法结果。');
  assert.equal(result.expectation, '用户得到两个数的和。');
  assert.equal(result.status, '已对齐');
  assert.equal(result.phase, '需求讨论');
});

test('新增文件和删除文件都给出可读范围', () => {
  const added = {
    path: 'new.ts', kind: '新增', exists: true, baseExists: false, before: '',
    after: 'export const x = 1;\nexport const y = 2;\n',
    addedLines: [1, 2], removedLines: [], symbols: [],
    changes: [{id: 'change-1', start: 1, end: 2, oldStart: 1, oldEnd: 0, symbolId: null, title: '新增文件。'}],
  };
  const addedResult = explain.changeExplanation(added, added.changes[0]);
  assert.match(addedResult.headline, /新增/);
  assert.match(addedResult.range, /新增文件/);
  assert.equal(addedResult.counts.added, 2);
  const removed = {
    path: 'old.ts', kind: '删除', exists: false, baseExists: true,
    before: 'line one\nline two\n', after: '', addedLines: [], removedLines: [1, 2], symbols: [],
    changes: [{id: 'change-1', start: 0, end: -1, oldStart: 1, oldEnd: 2, symbolId: null, title: '删除文件。'}],
  };
  const removedResult = explain.changeExplanation(removed, removed.changes[0]);
  assert.match(removedResult.headline, /删除/);
  assert.equal(removedResult.counts.removed, 2);
  assert.match(removedResult.range, /移除 2 行/);
});

test('文件汇总统计全部修改并说明预期状态', () => {
  const file = modifiedFile();
  const summary = explain.fileChangeSummary(file, {record: {expectation: '和。'}});
  assert.match(summary, /1 项修改/);
  assert.match(summary, /涉及 add/);
  assert.match(summary, /用户已记录预期/);
  assert.match(explain.fileChangeSummary({...file, changes: []}), /没有可展示的修改/);
});
