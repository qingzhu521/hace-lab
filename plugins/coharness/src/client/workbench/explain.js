'use strict';

// 系统把一块差异整理成可核对的自述。自述只使用源码和已有记录。
function uniqueNumbers(values) {
  return [...new Set(values.filter(value => Number.isInteger(value) && value > 0))].sort((left, right) => left - right);
}

function lineBounds(start, end, total) {
  const empty = !Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start;
  const from = empty ? 1 : start;
  const to = empty ? 0 : Math.min(end, Math.max(total, start));
  return {start: from, end: to, empty, count: empty ? 0 : to - from + 1};
}

function lineRange(lines, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return [];
  return lines.slice(from - 1, to).map((text, index) => ({line: from + index, text}));
}

function sampleLines(lines, numbers, limit = 8) {
  return numbers.slice(0, limit).map(line => ({line, text: lines[line - 1] ?? ''}));
}

function truncate(value, length) {
  const text = String(value ?? '').trim();
  return text.length > length ? text.slice(0, length - 1) + '…' : text;
}

// 系统读取一块修改的行号、代码和函数位置。
function changeFacts(file, change) {
  const after = String(file?.after ?? '').split('\n');
  const before = String(file?.before ?? '').split('\n');
  const afterBounds = lineBounds(change?.start, change?.end, after.length);
  const beforeBounds = lineBounds(change?.oldStart, change?.oldEnd, before.length);
  const addedNumbers = afterBounds.empty ? [] : uniqueNumbers(file?.addedLines || []).filter(line => line >= afterBounds.start && line <= afterBounds.end);
  const removedNumbers = beforeBounds.empty ? [] : uniqueNumbers(file?.removedLines || []).filter(line => line >= beforeBounds.start && line <= beforeBounds.end);
  const symbols = Array.isArray(file?.symbols) ? file.symbols : [];
  const symbol = (change?.symbolId && symbols.find(item => item.id === change.symbolId))
    || symbols.find(item => item.start <= afterBounds.start && item.end >= afterBounds.start)
    || symbols.find(item => afterBounds.empty && item.start <= 1 && item.end >= 1)
    || null;
  const definitions = symbols.filter(item => item.start >= afterBounds.start && item.start <= afterBounds.end);
  const allCallers = symbol?.callers || [];
  const allCalls = symbol?.calls || [];
  const callers = allCallers.slice(0, 6).map(item => ({line: item.line, expression: item.expression}));
  const calls = allCalls.slice(0, 6).map(item => ({line: item.line, expression: item.expression}));
  return {
    addedCount: addedNumbers.length,
    removedCount: removedNumbers.length,
    added: sampleLines(after, addedNumbers),
    removed: sampleLines(before, removedNumbers),
    afterBounds,
    beforeBounds,
    symbol,
    definitions,
    callers,
    calls,
    callerCount: allCallers.length,
    callCount: allCalls.length,
  };
}

function changeHeadline(file, facts, position) {
  if (file?.kind === '新增') return '系统新增 ' + file.path + '。';
  if (file?.kind === '删除') return '系统删除 ' + file.path + '。';
  if (facts.afterBounds.empty && !facts.removedCount) return '系统修改 ' + file.path + '。';
  return '系统修改 ' + file.path + ' 的第 ' + position + ' 处内容。';
}

function changeRangeLabel(file, change, facts) {
  if (file?.kind === '新增') return '新增文件 · 当前 ' + facts.afterBounds.count + ' 行';
  if (file?.kind === '删除') return '删除文件 · 移除 ' + facts.removedCount + ' 行';
  const before = facts.beforeBounds.empty ? '无旧行' : 'L' + facts.beforeBounds.start + '–' + facts.beforeBounds.end;
  const after = facts.afterBounds.empty ? '无新行' : 'L' + facts.afterBounds.start + '–' + facts.afterBounds.end;
  return before + ' → ' + after;
}

// 系统解释这次修改做了什么，并指出继续开发的核对点。
function changeExplanation(file, change, context = {}) {
  const facts = changeFacts(file, change);
  const found = (file?.changes || []).findIndex(item => item === change || item.id === change?.id);
  const position = found >= 0 ? found + 1 : 1;
  const record = context.record || null;
  const request = truncate(context.request, 160);
  const expectation = truncate(record?.expectation, 160);
  const commit = truncate(context.commit, 160);
  const status = record?.status === '已对齐' ? '已对齐' : record ? '讨论中' : '待对齐';
  const symbol = facts.symbol;
  const headline = changeHeadline(file, facts, position);
  const place = symbol ? '改动位于 ' + symbol.name + '(' + (symbol.parameters || '') + ') 内。' : '改动位于文件内容中。';
  const counts = '本次范围新增 ' + facts.addedCount + ' 行，删除 ' + facts.removedCount + ' 行。';
  const callers = facts.callerCount ? '同文件识别到 ' + facts.callerCount + ' 处调用 ' + (symbol?.name || '') + '。' : '系统没有识别到同文件调用者。';
  const checkpoints = [];
  if (facts.callerCount) checkpoints.push('核对同文件 ' + facts.callerCount + ' 处调用是否适应新的行为。');
  if (symbol && facts.callCount) checkpoints.push('核对 ' + symbol.name + ' 调用其他函数的参数与返回值。');
  if (!request) checkpoints.push('补写当前需求，让修改与开发目标建立对应关系。');
  if (!record) checkpoints.push('记录预期效果，之后可以对照验证。');
  if (file?.kind === '新增') checkpoints.push('为新文件补充调用入口或使用说明。');
  if (context.review) checkpoints.push('这是历史提交，文件只读。用户可以在开发空间继续当前修改。');
  if (!checkpoints.length) checkpoints.push('逐项对照差异，确认文件行为没有意外变化。');
  return {
    headline,
    summary: headline + place + counts + callers,
    counts: {added: facts.addedCount, removed: facts.removedCount},
    range: changeRangeLabel(file, change, facts),
    added: facts.added,
    removed: facts.removed,
    symbol,
    definitions: facts.definitions,
    callers: facts.callers,
    calls: facts.calls,
    callerCount: facts.callerCount,
    callCount: facts.callCount,
    position,
    total: (file?.changes || []).length,
    status,
    request,
    expectation,
    commit,
    rationale: context.rationale || null,
    annotations: Array.isArray(context.annotations) ? context.annotations : [],
    verification: context.verification || null,
    phase: context.phase || '',
    checkpoints,
    note: '自述来自实际差异和已有记录。系统没有运行项目，也不推断修改动机。',
  };
}

// 系统为文件汇总全部修改，供开发空间直接阅读。
function fileChangeSummary(file, context = {}) {
  const changes = Array.isArray(file?.changes) ? file.changes : [];
  if (!changes.length) return '该文件没有可展示的修改。';
  let added = 0;
  let removed = 0;
  const names = new Set();
  for (const change of changes) {
    const facts = changeFacts(file, change);
    added += facts.addedCount;
    removed += facts.removedCount;
    if (facts.symbol?.name) names.add(facts.symbol.name);
  }
  const parts = [changes.length + ' 项修改'];
  if (added) parts.push('新增 ' + added + ' 行');
  if (removed) parts.push('删除 ' + removed + ' 行');
  if (names.size) parts.push('涉及 ' + [...names].slice(0, 3).join('、'));
  const expectation = context.record?.expectation ? '用户已记录预期。' : '用户尚未记录预期。';
  return parts.join('，') + '。' + expectation;
}
