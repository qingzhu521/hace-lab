'use strict';

const state = {data: null, file: null, change: 0, expanded: false, trail: [], panelScroll: {}, returnPoint: null, previewDefinition: null, drafts: {}, demo: 0, mode: 'diff', editing: false, editorBuffers: {}, loading: false, collapsedChanges: {}, changeScroll: {}};
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));

// 页面短暂显示操作反馈。
function notify(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500);
}

// 浏览器读取实际源文件快照。
async function loadSnapshot(initial = false, quiet = false) {
  if (state.loading || (quiet && (state.editing || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || $('#directory-dialog').open))) return;
  state.loading = true;
  const button = $('#refresh');
  button.disabled = true;
  try {
    rememberDraft();
    rememberEditor();
    const response = await fetch('/api/snapshot');
    const next = await response.json();
    if (!response.ok) throw new Error(next.error || '系统暂时无法读取源文件。');
    const changed = state.data && state.data.basis !== next.basis;
    const switched = state.data && state.data.workspaceId !== next.workspaceId;
    if (quiet && !changed) return;
    const scroll = $('#main').scrollTop;
    state.data = next;
    $('#project-name').textContent = next.project;
    $('#project-name').title = next.root;
    if (switched) { state.file = null; state.editing = false; state.change = 0; }
    if (changed) {
      state.trail = [];
      state.returnPoint = null;
      state.previewDefinition = null;
      closeContext();
      $('#reopen-context').classList.add('hidden');
    }
    renderTree();
    renderMain();
    if (quiet) $('#main').scrollTop = scroll;
    $('#sync-status').textContent = '系统已同步目录';
    if (!initial && !quiet) notify(changed ? '工作区已更新。历史预期与编辑草稿仍然保留。' : '修改地图已与目录同步。');
  } catch (error) {
    if (!state.data) $('#main').innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
    $('#sync-status').textContent = '目录同步待重试';
    if (!quiet) notify(error.message);
  } finally {
    button.disabled = false;
    state.loading = false;
  }
}

// 页面读取当前文件和修改项。
function selection() {
  const file = state.data?.files.find(item => item.path === state.file);
  const change = file?.changes[state.change];
  return {file, change};
}

// 系统查找绑定当前项目快照的对齐记录。
function recordFor(file, change) {
  return state.data.records[`alignment:${file.path}:${state.data.basis}:${change.id}`];
}

// 页面汇总当前文件的对齐状态。
function fileStatus(file) {
  if (!file.previewable) return '待查看';
  if (!file.changes.length) return '未修改';
  const records = file.changes.map(change => recordFor(file, change));
  if (records.every(record => record?.status === '已对齐')) return '已对齐';
  if (records.some(Boolean)) return '讨论中';
  if (Object.values(state.data.records).some(record => record.path === file.path)) return '待重新对齐';
  return '待对齐';
}

// 页面按照真实路径组织修改地图。
function renderTree() {
  if (!state.data) return;
  const filter = $('#filter').value.toLowerCase();
  const files = state.data.files.filter(file => `${file.path} ${file.description}`.toLowerCase().includes(filter) && (!$('#changes-only').checked || file.kind !== '未修改'));
  const root = {children: Object.create(null)};
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    parts.forEach((part, index) => {
      node.children[part] ??= {children: Object.create(null), path: parts.slice(0, index + 1).join('/')};
      node = node.children[part];
      if (index === parts.length - 1) node.file = file;
    });
  }
  const renderNode = node => Object.entries(node.children).map(([name, child]) => {
    if (child.file) {
      const file = child.file;
      const status = fileStatus(file);
      return `<button class="file-button ${state.file === file.path ? 'active' : ''}" data-file="${esc(file.path)}" title="${esc(file.description)} · ${status}" ${state.file === file.path ? 'aria-current="page"' : ''}><span class="status-dot ${status === '已对齐' ? 'done' : status === '待对齐' ? '' : 'pending'}"></span><span class="file-copy"><span class="file-name">${esc(name)}</span><div class="file-desc">${esc(file.label)} · ${status}</div></span><span class="file-kind">${file.kind === '新增' ? '+' : file.kind === '删除' ? '−' : '·'}</span></button>`;
    }
    const pending = files.filter(file => file.path.startsWith(child.path + '/') && fileStatus(file) !== '已对齐' && fileStatus(file) !== '未修改').length;
    return `<details class="directory" open><summary><span class="folder-icon">▱</span>${esc(name)} <span class="count">${pending}</span></summary><p class="dir-desc">${esc(state.data.directories[child.path] || '')}</p><div class="children">${renderNode(child)}</div></details>`;
  }).join('');
  $('#tree').innerHTML = renderNode(root) || '<p class="muted small">系统未找到匹配文件。</p>';
  $('#file-count').textContent = state.data.files.filter(file => file.changes.length).length;
  $('#overview-button').classList.toggle('active', !state.file);
}

// 页面展示本轮源码修改的整体结构。
function renderOverview() {
  const files = state.data.files;
  const changed = files.filter(file => file.kind !== '未修改');
  const aligned = files.flatMap(file => file.changes.map(change => recordFor(file, change))).filter(record => record?.status === '已对齐').length;
  const cards = [...changed, ...files.filter(file => file.kind === '未修改')].slice(0, 12);
  $('#main').innerHTML = `<div class="breadcrumbs"><span>${esc(state.data.project)}</span><span>/</span><span class="current">工作区概述</span></div>
    <div class="hero"><div><span class="eyebrow">WORKSPACE / 当前工作区</span><h1>${esc(state.data.project)}</h1><p class="workspace-path">${esc(state.data.root)}</p><p>目录展示项目结构。你可以阅读和编辑实际文件，再通过修改地图逐项对齐。</p></div><span class="version-tag">快照 ${state.data.basis.slice(0, 8)}</span></div>
    <div class="stats"><div class="stat"><strong>${files.length}</strong><span>工作区文件</span></div><div class="stat"><strong>${changed.length}</strong><span>存在变化的文件</span></div><div class="stat"><strong>${aligned}</strong><span>用户已经确认的修改项</span></div></div>
    <div class="section-heading"><h2>${changed.length ? '目录中的文件发生了变化' : '工作区已与保存的 Git 基准一致'}</h2><span>文件清单来自当前目录</span></div>
    <div class="module-grid">${cards.map(file => `<button class="module-card" data-file="${esc(file.path)}"><div class="module-icon">${file.kind === '未修改' ? '▤' : '↗'}</div><h3>${esc(file.path)}</h3><p>${esc(file.description)}</p><footer><span>${esc(file.label)} · ${esc(file.kind)}</span><span>打开文件 ↗</span></footer></button>`).join('') || '<p class="intro-banner">当前目录没有可展示的文件。系统会持续检查后续变化。</p>'}</div>
    <div class="intro-banner">比较基准：${esc(state.data.baseline)}${state.data.head ? ' · ' + state.data.head.slice(0, 8) : '。文件将在完成对齐后进入 Git 提交'}。保存工作快照会保存文件内容，并保留编辑前后的本地快照；它不会创建 Git 提交。</div>
    ${state.data.notices.map(notice => `<p class="note">${esc(notice)}</p>`).join('')}
    <p class="note">系统遵循 Git 忽略规则。职责说明来自文件首部注释或文档标题，模型生成说明尚未接入。二进制和大文件仅展示信息。</p>
    ${renderEvents()}`;
}

// 页面保留每个修改项的未提交输入。
function rememberDraft() {
  const input = $('#expectation');
  const {file, change} = selection();
  if (input && file && change) state.drafts[`${state.data.workspaceId}:${file.path}:${file.version}:${change.id}`] = input.value;
}

// 页面切换文件并恢复目录中的位置。
function selectFile(path, index = 0) {
  state.returnPoint = null;
  state.previewDefinition = null;
  rememberDraft();
  rememberEditor();
  state.editing = false;
  state.file = path;
  state.change = index;
  state.expanded = false;
  state.mode = state.data.files.find(file => file.path === path)?.changes.length ? 'diff' : 'source';
  state.demo = 0;
  renderTree();
  renderMain();
  $('#main').scrollTop = 0;
}

// 页面根据当前选择展示概览或修改项。
function renderMain() {
  $('#main').classList.remove('definition-open');
  if (!state.file) return renderOverview();
  const {file} = selection();
  if (!file) { state.file = null; return renderOverview(); }
  state.change = Math.min(state.change, Math.max(0, file.changes.length - 1));
  const change = file.changes[state.change];
  const selectedSymbol = state.data.symbols.find(symbol => symbol.id === change?.symbolId);
  $('#main').innerHTML = `<div class="breadcrumbs"><button data-action="overview">修改地图</button><span>/</span><span class="current">${esc(file.path)}</span></div>
    <div class="hero"><div><span class="eyebrow">FILE REVIEW / 文件概览</span><h1 class="file-heading">${esc(file.path.split('/').at(-1))}</h1><span class="badge">${file.kind} · ${fileStatus(file)}</span></div><span class="version-tag">SHA ${file.version.slice(0, 8)}</span></div>
    <details class="file-summary"><summary>文件职责与修改目的</summary><div class="summary-grid"><div class="summary-block"><h3>文件说明 · ${esc(file.descriptionSource)}</h3><p>${esc(file.description)}</p></div><div class="summary-block"><h3>本次修改目的</h3><p>${esc(file.purpose)}</p></div></div></details>
    <div class="file-actions"><button data-action="show-source" class="${state.mode === 'source' ? 'active' : ''}">文件内容</button><button data-action="show-diff" class="${state.mode === 'diff' ? 'active' : ''}" ${!change ? 'disabled' : ''}>修改对比</button><button data-action="edit-file" ${!file.editable ? 'disabled' : ''}>编辑文件</button></div>
    ${state.editing ? renderEditor(file) : state.mode === 'source' || !change ? renderSource(file) : `${renderChangeList(file)}
    <div class="change-toolbar"><button data-action="expand-code">${state.expanded ? '收起周边代码' : '展开周边代码'}</button>${selectedSymbol ? `<button data-symbol="${esc(selectedSymbol.id)}" class="primary">调用上下文 · ${esc(selectedSymbol.name)} ↗</button>` : ''}</div>
    <div id="diff-target">${renderDiff(file, change)}</div>
    ${file.baseExists && file.exists ? '<p class="note">绿色标记新增代码，红色标记移除代码。</p>' : ''}
    ${renderBehavior(file, change, selectedSymbol)}
    ${renderAlignment(file, change)}`}
    ${renderEvents(file.path)}`;
  const editor = $('#source-editor');
  if (editor) editor.addEventListener('input', rememberEditor);
  const input = $('#expectation');
  if (input) input.addEventListener('input', rememberDraft);
  const list = $('#change-list');
  if (list) {
    list.scrollTop = state.changeScroll[editorKey(file)] || 0;
    list.addEventListener('scroll', () => { state.changeScroll[editorKey(file)] = list.scrollTop; });
  }
  const summary = $('.file-summary');
  summary.open = Boolean(state.summaryOpen);
  summary.addEventListener('toggle', () => {
    if (summary.isConnected) state.summaryOpen = summary.open;
  });
  if (state.previewDefinition) renderDefinitionPreview();
}

// 页面通过可收起列表展示修改范围和对齐状态。
function renderChangeList(file) {
  const collapsed = Boolean(state.collapsedChanges[editorKey(file)]);
  const current = file.changes[state.change];
  const range = change => change.end >= change.start ? `L${change.start}–${change.end}` : change.oldEnd >= change.oldStart ? `原 L${change.oldStart}–${change.oldEnd}` : '文件状态';
  const rows = file.changes.map((change, index) => {
    const record = recordFor(file, change);
    const previous = Object.values(state.data.records).some(item => item.path === file.path && item.change === change.id && item.basis !== state.data.basis);
    const status = record?.status || (previous ? '待重新对齐' : '待对齐');
    return `<li><button class="change-row ${index === state.change ? 'active' : ''}" data-change="${index}" aria-current="${index === state.change ? 'true' : 'false'}"><span class="change-index">${String(index + 1).padStart(2, '0')}</span><span class="change-title">${esc(change.title)}</span><span class="change-range">${range(change)}</span><span class="change-status">${esc(status)}</span></button></li>`;
  }).join('');
  return `<section class="change-browser" aria-label="修改项"><header class="change-browser-header"><strong>修改项 <span class="count">${file.changes.length}</span></strong><div class="change-navigation"><span>${state.change + 1} / ${file.changes.length}</span><button data-action="previous-change" aria-label="上一项" ${state.change === 0 ? 'disabled' : ''}>↑</button><button data-action="next-change" aria-label="下一项" ${state.change === file.changes.length - 1 ? 'disabled' : ''}>↓</button><button data-action="toggle-changes" aria-expanded="${!collapsed}" aria-controls="change-list">${collapsed ? '展开列表' : '收起列表'}</button></div></header>${collapsed ? `<div class="current-change"><span class="change-index">${String(state.change + 1).padStart(2, '0')}</span><span>${esc(current.title)}</span><span class="change-range">${range(current)}</span></div>` : ''}<ol id="change-list" ${collapsed ? 'hidden' : ''}>${rows}</ol></section>`;
}

// 页面切换修改项并定位对应代码。
function selectChange(index) {
  const {file} = selection();
  if (!file || index < 0 || index >= file.changes.length) return;
  rememberDraft();
  const scroll = $('#main').scrollTop;
  state.change = index;
  state.demo = 0;
  renderMain();
  $('#main').scrollTop = scroll;
  const active = $('#change-list .active');
  const list = $('#change-list');
  if (active && list && !list.hidden) {
    const offset = active.getBoundingClientRect().top - list.getBoundingClientRect().top;
    if (offset < 0) list.scrollTop += offset;
    else if (offset + active.offsetHeight > list.clientHeight) list.scrollTop += offset + active.offsetHeight - list.clientHeight;
    active.focus({preventScroll: true});
  }
  const change = file.changes[index];
  const code = $('#after-code') || $('#before-code');
  const line = code?.querySelector(`[data-line="${file.exists ? change.start : change.oldStart}"]`);
  if (line) {
    line.classList.add('selected');
    code.scrollTop += line.getBoundingClientRect().top - code.getBoundingClientRect().top - 12;
  }
}

// 页面使用转义文本展示源代码与行号。
function codeLines(source, start, end, highlightedLines = [], className = '') {
  if (!source || end < start) return '<div class="empty-code">该版本没有对应代码。</div>';
  return source.split('\n').slice(start - 1, end).map((line, index) => {
    const number = start + index;
    const highlight = highlightedLines.includes(number);
    return `<div class="code-line ${highlight ? className : ''}" data-line="${number}"><span class="line-number">${number}</span><span>${esc(line) || ' '}</span></div>`;
  }).join('');
}

// 页面根据文件状态展示选中范围的代码。
function renderDiff(file, change) {
  const afterStart = state.expanded ? 1 : Math.max(1, change.start - 3);
  const afterEnd = state.expanded ? file.after.split('\n').length : change.end + 3;
  const oldStart = state.expanded ? 1 : change.oldStart;
  const oldEnd = state.expanded ? file.before.split('\n').length : change.oldEnd;
  if (!file.baseExists) {
    return `<div class="diff-grid single-column"><section class="code-pane"><div class="code-title after"><span>新增文件</span><span>L${change.start}–${Math.max(change.start, change.end)}</span></div><div class="code-scroll" id="after-code">${codeLines(file.after, afterStart, afterEnd, file.addedLines, 'added')}</div></section></div>`;
  }
  if (!file.exists) {
    return `<div class="diff-grid single-column"><section class="code-pane"><div class="code-title"><span>已删除文件 · 原始代码</span></div><div class="code-scroll" id="before-code">${codeLines(file.before, oldStart, oldEnd, file.removedLines, 'removed')}</div></section></div>`;
  }
  return `<div class="diff-grid"><section class="code-pane"><div class="code-title"><span>修改前</span><span>Git HEAD</span></div><div class="code-scroll" id="before-code">${codeLines(file.before, oldStart, oldEnd, file.removedLines, 'removed')}</div></section><section class="code-pane"><div class="code-title after"><span>修改后</span><span>L${change.start}—${change.end}</span></div><div class="code-scroll" id="after-code">${codeLines(file.after, afterStart, afterEnd, file.addedLines, 'added')}</div></section></div>`;
}

// 页面展示函数声明的参数个数。
function parameterLabel(symbol) {
  return Number.isInteger(symbol.parameterCount) ? `声明 ${symbol.parameterCount} 个参数` : '声明参数个数待解析';
}

// 页面保留阅读主角并向两侧展开调用链。
function renderCalls(symbol) {
  const frame = state.trail.at(-1);
  const name = item => item.id === symbol.id ? `<strong class="root-reference">${esc(item.name)}</strong>` : esc(item.name);
  const group = (owner, direction, depth = 0, visited = [symbol.id]) => {
    const calls = direction === 'in' ? owner.callers : owner.calls;
    const groups = new Map();
    calls.forEach(call => {
      if (!groups.has(call.target)) groups.set(call.target, []);
      groups.get(call.target).push(call);
    });
    const entries = [...groups.entries()];
    const choice = frame.chains[direction][depth];
    const selected = entries.find(([id]) => id === choice?.id) || entries[0];
    const options = entries.map(([id]) => {
      const target = state.data.symbols.find(item => item.id === id);
      return `<button data-relation="${esc(id)}" data-depth="${depth}" data-direction="${direction}" aria-pressed="${id === selected?.[0]}">${esc(target?.name)}</button>`;
    }).join('');
    let pair = '';
    if (selected) {
      const [id, sites] = selected;
      const target = state.data.symbols.find(item => item.id === id);
      const caller = direction === 'in' ? target : owner;
      const callee = direction === 'in' ? owner : target;
      const cycle = visited.includes(id);
      const expanded = !cycle && choice?.id === id && choice.expanded;
      const further = direction === 'in' ? '调用者' : '被调用者';
      const detailKey = `${direction}-${depth}-${id}`;
      const node = `<div class="relation-node ${cycle ? 'cycle-node' : ''}"><strong class="relation-name">${name(target)}</strong><span class="badge">${parameterLabel(target)}</span><p>${esc(target.description)}</p><code>${esc(target.parameters || '无参数')}</code><footer class="relation-code-link"><span>${esc(target.path)}:${target.start}</span><button data-definition="${esc(target.id)}" aria-label="查看 ${esc(target.name)} 的代码">查看代码 ↗</button></footer>${cycle ? `<span class="cycle-note">${id === symbol.id ? '调用链回到阅读主角。' : '调用链回到已展示的函数。'}</span>` : `<button class="expand-relation" data-expand-relation="${esc(id)}" data-direction="${direction}" data-depth="${depth}" aria-expanded="${Boolean(expanded)}">${expanded ? '收起' : '展开'} ${esc(target.name)} 的${further} ${direction === 'in' ? '↑' : '↓'}</button>`}</div>`;
      const site = call => `<div class="relation-site"><span>${esc(caller.path)}:${call.line}</span><code>${esc(call.expression)}</code></div>`;
      const connection = `<div class="relation-connection"><span class="relation-statement">${name(caller)} 调用 ${name(callee)}</span>${site(sites[0])}${sites.length > 1 ? `<details data-context-detail="${esc(detailKey)}"><summary>其余 ${sites.length - 1} 处调用</summary>${sites.slice(1).map(site).join('')}</details>` : ''}<span class="relation-receiver">${name(callee)} 接收：${esc(callee.parameters || '无参数')}</span></div>`;
      const extension = expanded ? group(target, direction, depth + 1, [...visited, id]) : '';
      pair = `<div class="relation-chain">${direction === 'in' ? extension : ''}<article class="relation-pair ${direction === 'in' ? 'incoming' : 'outgoing'}" aria-label="${esc(caller.name)} 调用 ${esc(callee.name)}">${direction === 'in' ? node + connection : connection + node}</article>${direction === 'out' ? extension : ''}</div>`;
    }
    const title = direction === 'in' ? '调用者' : '被调用者';
    const label = depth ? `${owner.name} 的${title}` : title;
    return `<section class="relation-group ${depth ? 'extended-relation' : ''}" data-chain-depth="${depth}" data-chain-direction="${direction}" aria-label="${esc(label)}"><h3>${esc(label)}<span>${entries.length} · 第 ${depth + 1} 层</span></h3>${entries.length > 1 ? `<div class="relation-options" role="group" aria-label="选择${esc(label)}">${options}</div>` : ''}<div class="relation-list">${pair || `<p class="call-empty">系统尚未识别到同文件${title}。</p>`}</div></section>`;
  };
  return `<div class="call-flow">${group(symbol, 'in')}<section class="call-current" aria-label="阅读主角" tabindex="-1"><span class="eyebrow">阅读主角 · 展开时保持固定</span><div class="call-function"><h2>${esc(symbol.name)}</h2><span class="badge">${parameterLabel(symbol)}</span></div><code>${esc(symbol.name)}(${esc(symbol.parameters)})</code><p>${esc(symbol.description)}</p><footer><span>${esc(symbol.path)}:${symbol.start}</span><button data-action="jump-definition">查看代码 ↗</button></footer></section>${group(symbol, 'out')}</div>`;
}

// 页面记录调用链的展开状态。
function changeContextChain(button, expand) {
  const current = state.trail.at(-1);
  if (!current) return;
  rememberContextScroll();
  const previousPosition = state.panelScroll[state.trail.length - 1];
  const next = structuredClone(current);
  const direction = button.dataset.direction;
  const depth = Number(button.dataset.depth);
  const id = expand ? button.dataset.expandRelation : button.dataset.relation;
  const chain = next.chains[direction];
  const expanded = expand && !(chain[depth]?.id === id && chain[depth].expanded);
  chain.splice(depth, chain.length - depth, {id, expanded});
  state.trail.push(next);
  state.panelScroll[state.trail.length - 1] = structuredClone(previousPosition);
  renderContext();
}

// 页面组织当前代码的逐步阅读演示。
function renderBehavior(file, change, symbol) {
  if (!symbol) return '';
  const lines = symbol.code.split('\n');
  const steps = [{line: symbol.start, text: `入口：${symbol.name} 接收 ${symbol.parameters || '零个显式参数'}。`}];
  if (symbol.calls.length) {
    const call = symbol.calls[0];
    steps.push({line: call.line, text: `相关调用：${call.expression}`});
  }
  const returnIndex = lines.findIndex((line, index) => index > 0 && /\breturn\b/.test(line));
  steps.push(returnIndex > 0 ? {line: symbol.start + returnIndex, text: `返回位置：${lines[returnIndex].trim()}`} : {line: symbol.end, text: '请结合函数末尾与调用位置，确认状态变化或副作用。'});
  const step = steps[state.demo % steps.length];
  state.demoLine = step.line;
  return `<section class="behavior"><h3>页面逐步定位相关代码</h3><p class="note">源码阅读示意 · 系统没有执行这段代码，也不推断运行时参数值。</p><div class="step">${esc(step.text)}</div><footer><span>${state.demo % steps.length + 1} / ${steps.length} · L${step.line}</span><button data-action="demo-next">下一步 →</button></footer></section>`;
}

// 页面邀请用户表达预期修改效果。
function renderAlignment(file, change) {
  const record = recordFor(file, change);
  const history = Object.values(state.data.records).filter(item => item.path === file.path && item.basis !== state.data.basis);
  const draft = state.drafts[`${state.data.workspaceId}:${file.path}:${file.version}:${change.id}`] ?? record?.expectation ?? '';
  return `<section class="alignment"><div class="alignment-head"><h2>修改对齐</h2><span class="badge">${record?.status || (history.length ? '待重新对齐' : '待对齐')}</span></div><p class="small muted">我们通过预期效果，确认双方正在解决同一个问题。</p><label for="expectation" class="small">结合上下文，请输入预期修改效果。</label><textarea id="expectation" maxlength="12000" placeholder="请描述你希望这项修改产生的效果。">${esc(draft)}</textarea><div class="alignment-actions"><button class="primary" data-action="save-expectation">提交预期</button><button data-action="confirm-expectation">确认当前预期</button><span>系统将记录绑定到当前源文件快照。</span></div>${record ? `<div class="saved-record"><strong>${record.status === '已对齐' ? '用户已确认当前预期' : '用户已提交预期'}</strong><br>${esc(record.expectation)}</div>` : ''}<p class="note">当前版本保存预期与人工确认。模型尚未参与对齐；实现效果保留“待验证”状态。</p>${history.length ? `<details><summary class="small">查看此前版本的预期（${history.length}）</summary>${history.map(item => `<div class="saved-record"><small>${esc(item.change)} · ${item.version.slice(0, 8)} · ${esc(item.status)}</small><br>${esc(item.expectation)}</div>`).join('')}</details>` : ''}</section>`;
}

// 浏览器提交绑定版本的用户预期。
async function saveExpectation(status) {
  const {file, change} = selection();
  const expectation = $('#expectation').value.trim();
  if (!expectation) return notify('请先输入预期修改效果。');
  rememberDraft();
  const buttons = [...document.querySelectorAll('.alignment-actions button')];
  buttons.forEach(button => button.disabled = true);
  try {
    const response = await fetch('/api/alignment', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CoHarness-Token': state.data.token}, body: JSON.stringify({workspaceId: state.data.workspaceId, path: file.path, change: change.id, version: file.version, basis: state.data.basis, expectation, status})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '系统未能保存预期。');
    await loadSnapshot();
    notify(status === '已对齐' ? '系统已保存你的确认。实现效果仍待验证。' : '系统已保存你的预期。');
  } catch (error) { notify(error.message); }
  finally { buttons.forEach(button => button.disabled = false); }
}

// 页面只展示本地服务实际记录的操作。
function renderEvents(path = null) {
  const events = state.data.events.filter(event => !path || event.data.path === path);
  return `<details class="records"><summary>操作记录 <span class="muted">· ${events.length} 条已记录事件</span></summary><p class="note">记录从本地服务首次观察文件时开始。服务没有捕获此前编辑工具的操作，因此页面不推断修改来源。</p>${events.map(event => `<div class="event"><time>${esc(new Date(event.time).toLocaleString('zh-CN'))}</time><strong>${esc(event.kind)}</strong><br><code>${esc(event.data.path)} · ${(event.data.version || '').slice(0, 10)}</code>${event.data.previousVersion ? `<br>此前版本 ${event.data.previousVersion.slice(0, 10)}` : ''}${event.data.expectation ? `<p>${esc(event.data.expectation)}</p>` : ''}</div>`).join('')}</details>`;
}

// 页面在调用面板中打开目标函数。
function openContext(id) {
  const symbol = state.data.symbols.find(item => item.id === id);
  if (!symbol) return notify('当前快照中没有这个定义。');
  state.trail = [{id, chains: {in: [], out: []}}];
  state.panelScroll = {};
  $('#context').classList.remove('hidden');
  $('#workspace').classList.add('context-open');
  $('#reopen-context').classList.add('hidden');
  renderContext();
}

// 页面保存当前调用层的阅读位置。
function rememberContextScroll() {
  if (state.trail.length) state.panelScroll[state.trail.length - 1] = {
    body: $('#context-content').scrollTop,
    code: $('#context-content .code-scroll')?.scrollTop || 0,
    horizontal: $('#context-content .code-scroll')?.scrollLeft || 0,
    expanded: [...document.querySelectorAll('#context-content details[open]')].map(item => item.dataset.contextDetail),
  };
}

// 页面展示实际调用表达式和目标定义。
function renderContext() {
  const current = state.trail.at(-1);
  const symbol = state.data.symbols.find(item => item.id === current?.id);
  if (!symbol) return;
  $('#context-trail').innerHTML = `<button data-action="context-back" ${state.trail.length < 2 ? 'disabled' : ''}>← 返回上一步</button><button class="context-root" data-action="locate-context-root" aria-label="定位阅读主角 ${esc(symbol.name)}"><span>阅读主角</span><strong>${esc(symbol.name)}</strong><span aria-hidden="true">◎</span></button>`;
  const returns = symbol.code.split('\n').map((line, index) => ({line, number: symbol.start + index})).filter(item => /\b(return|throw|raise)\b/.test(item.line));
  $('#context-content').innerHTML = `${renderCalls(symbol)}<details class="definition-details" data-context-detail="definition"><summary>函数代码与返回位置</summary><h3>返回与异常位置</h3><div class="parameter-box">${returns.length ? returns.map(item => `L${item.number}　${esc(item.line.trim())}`).join('\n') : '系统没有识别到显式返回或异常语句。'}</div><h3>函数代码</h3><div class="code-scroll">${codeLines(state.data.files.find(file => file.path === symbol.path).after, symbol.start, symbol.end)}</div></details><p class="note relation-note">系统展示同文件静态调用候选。参数名称和个数来自声明，可变参数计为一项。实参对应与返回值流向待解析。</p>`;
  const position = state.panelScroll[state.trail.length - 1];
  document.querySelectorAll('#context-content details').forEach(item => { item.open = position?.expanded?.includes(item.dataset.contextDetail) || false; });
  $('#context-content').scrollTop = position?.body || 0;
  $('#context-content .code-scroll').scrollTop = position?.code || 0;
  $('#context-content .code-scroll').scrollLeft = position?.horizontal || 0;
}

// 页面收起调用面板并保留阅读路径。
function closeContext() {
  rememberContextScroll();
  $('#context').classList.add('hidden');
  $('#context').classList.remove('fullscreen');
  $('#workspace').classList.remove('context-open');
  $('#reopen-context').classList.toggle('hidden', !state.trail.length);
  $('#zoom-context').textContent = '⤢';
  $('#zoom-context').setAttribute('aria-label', '全屏展开');
}

// 页面切换调用面板的全屏状态。
function toggleContextZoom() {
  const scroll = $('#context-content').scrollTop;
  const fullscreen = $('#context').classList.toggle('fullscreen');
  $('#zoom-context').textContent = fullscreen ? '⤡' : '⤢';
  $('#zoom-context').setAttribute('aria-label', fullscreen ? '还原面板' : '全屏展开');
  $('#zoom-context').title = fullscreen ? '还原面板' : '全屏展开';
  $('#context-content').scrollTop = scroll;
}

// 页面约束面板宽度并保存用户尺寸。
function setPanelWidth(width) {
  const maximum = window.innerWidth >= 1000 ? window.innerWidth - 556 : window.innerWidth * .92;
  const bounded = Math.max(320, Math.min(maximum, width));
  document.documentElement.style.setProperty('--context-width', `${bounded}px`);
  $('#resize-handle').setAttribute('aria-valuenow', Math.round(bounded));
  $('#resize-handle').setAttribute('aria-valuemax', Math.round(maximum));
  localStorage.setItem('coharness.panelWidth', String(bounded));
}

// 页面临时展示关联代码并保留审阅标签。
function jumpToDefinition(id = state.trail.at(-1)?.id) {
  const symbol = state.data.symbols.find(item => item.id === id);
  if (!symbol) return;
  rememberDraft();
  rememberEditor();
  if (!state.returnPoint) {
    const {file, change} = selection();
    const origin = state.data.symbols.find(item => item.id === change?.symbolId);
    state.returnPoint = {
      scroll: $('#main').scrollTop,
      label: file ? `${file.path} · ${state.editing ? '编辑文件' : state.mode === 'source' ? '文件内容' : origin?.name || `修改项 ${state.change + 1}`}` : '工作区概述',
    };
  }
  state.previewDefinition = symbol.id;
  if ($('#context').classList.contains('fullscreen')) toggleContextZoom();
  renderDefinitionPreview();
}

// 页面在独立查看层展示代码与返回目标。
function renderDefinitionPreview() {
  const symbol = state.data.symbols.find(item => item.id === state.previewDefinition);
  const file = state.data.files.find(item => item.path === symbol?.path);
  if (!symbol || !file || !state.returnPoint) return;
  $('#definition-preview')?.remove();
  const preview = document.createElement('section');
  preview.id = 'definition-preview';
  preview.setAttribute('aria-label', '关联代码查看');
  preview.innerHTML = `<div class="review-return-bar"><button class="primary" data-action="return-review"><span aria-hidden="true">←</span> 返回修改审阅</button><div><span class="return-caption">返回位置</span><strong>${esc(state.returnPoint.label)}</strong></div></div><div class="definition-preview-heading"><span class="eyebrow">正在查看关联代码</span><h1>${esc(symbol.name)}</h1><p>${esc(symbol.path)} · L${symbol.start}–${symbol.end}</p></div><div class="source-view"><div class="code-title"><span>${esc(symbol.name)}(${esc(symbol.parameters)})</span><span>${parameterLabel(symbol)}</span></div><div class="code-scroll" id="definition-code">${codeLines(file.after, 1, file.after.split('\n').length)}</div></div>`;
  $('#main').append(preview);
  $('#main').classList.add('definition-open');
  $('#main').scrollTo({top: 0, behavior: 'instant'});
  const code = $('#definition-code');
  const line = code.querySelector(`[data-line="${symbol.start}"]`);
  if (line) {
    line.classList.add('selected');
    code.scrollTo({top: code.scrollTop + line.getBoundingClientRect().top - code.getBoundingClientRect().top - 16, behavior: 'instant'});
  }
}

// 页面关闭临时查看层并恢复审阅位置。
function returnToReview() {
  const point = state.returnPoint;
  if (!point) return;
  state.previewDefinition = null;
  state.returnPoint = null;
  $('#definition-preview')?.remove();
  $('#main').classList.remove('definition-open');
  $('#main').scrollTo({top: point.scroll, behavior: 'instant'});
  $('#main').focus({preventScroll: true});
}

// 页面将按钮事件连接到相应交互。
function handleClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.file) return selectFile(button.dataset.file);
  if (button.dataset.change !== undefined) return selectChange(Number(button.dataset.change));
  if (button.dataset.directory) return browseDirectory(button.dataset.directory);
  if (button.dataset.symbol) return openContext(button.dataset.symbol);
  if (button.dataset.definition) return jumpToDefinition(button.dataset.definition);
  if (button.dataset.relation) return changeContextChain(button, false);
  if (button.dataset.expandRelation) return changeContextChain(button, true);
  const actions = {
    'locate-context-root': () => {
      const root = $('#context-content .call-current');
      const content = $('#context-content');
      content.scrollTop += root.getBoundingClientRect().top - content.getBoundingClientRect().top - 16;
      root.focus({preventScroll: true});
    },
    'context-back': () => {
      if (state.trail.length < 2) return;
      rememberContextScroll();
      state.trail.pop();
      renderContext();
    },
    'previous-change': () => selectChange(state.change - 1),
    'next-change': () => selectChange(state.change + 1),
    'toggle-changes': () => {
      const {file} = selection();
      rememberDraft();
      const scroll = $('#main').scrollTop;
      const key = editorKey(file);
      state.collapsedChanges[key] = !state.collapsedChanges[key];
      renderMain();
      $('#main').scrollTop = scroll;
      $('[data-action="toggle-changes"]').focus({preventScroll: true});
    },
    'overview': showOverview,
    'show-source': () => { rememberDraft(); rememberEditor(); state.editing = false; state.mode = 'source'; renderMain(); },
    'show-diff': () => { rememberEditor(); state.editing = false; state.mode = 'diff'; renderMain(); },
    'edit-file': () => { rememberDraft(); state.editing = true; renderMain(); },
    'save-file': saveEditor,
    'leave-editor': () => { rememberEditor(); state.editing = false; renderMain(); },
    'expand-code': () => { rememberDraft(); state.expanded = !state.expanded; renderMain(); },
    'demo-next': () => {
      rememberDraft();
      const scroll = $('#main').scrollTop;
      state.demo += 1;
      renderMain();
      const line = document.querySelector(`#after-code [data-line="${state.demoLine}"]`);
      if (line) { line.classList.add('selected'); $('#after-code').scrollTop = line.offsetTop - $('#after-code').offsetTop - 30; }
      $('#main').scrollTop = scroll;
    },
    'save-expectation': () => saveExpectation('讨论中'),
    'confirm-expectation': () => saveExpectation('已对齐'),
    'close-panel': closeContext,
    'jump-definition': jumpToDefinition,
    'return-review': returnToReview,
  };
  actions[button.dataset.action]?.();
}

// 页面展示任意文本文件及其定义入口。
function renderSource(file) {
  if (!file.previewable) return `<p class="intro-banner">${esc(file.notice)}</p>`;
  return `<div class="source-view"><div class="code-title"><span>${esc(file.path)}</span><span>${file.exists ? '当前文件' : '文件已删除'}</span></div><div class="code-scroll" id="after-code">${codeLines(file.after, 1, file.after.split('\n').length)}</div></div><div class="call-buttons" style="margin-top:15px">${file.symbols.map(symbol => `<button data-symbol="${esc(symbol.id)}">${esc(symbol.name)} ↗</button>`).join('')}</div>`;
}

// 页面按工作区和文件保留独立编辑缓冲区。
function editorKey(file) {
  return `${state.data.workspaceId}:${file.path}`;
}

// 页面保留尚未保存到磁盘的编辑内容。
function rememberEditor() {
  const editor = $('#source-editor');
  const {file} = selection();
  if (editor && file) {
    const key = editorKey(file);
    state.editorBuffers[key] ??= {content: file.after, version: file.version, dirty: false};
    state.editorBuffers[key].content = editor.value;
    state.editorBuffers[key].dirty = editor.value !== file.after;
  }
}

// 页面为当前文件提供真实文本编辑器。
function renderEditor(file) {
  if (!file.editable) return `<p class="intro-banner">${esc(file.notice || '当前文件无法编辑。')}</p>`;
  const buffer = state.editorBuffers[editorKey(file)] ?? {content: file.after, version: file.version};
  state.editorBuffers[editorKey(file)] = buffer;
  return `<section class="editor-wrap"><div class="editor-toolbar"><span>UTF-8 · ${esc(file.path)}</span><div><button data-action="leave-editor">返回阅读</button> <button data-action="save-file" class="primary">保存工作快照</button></div></div><textarea id="source-editor" aria-label="文件编辑器" spellcheck="false" wrap="off">${esc(buffer.content)}</textarea><p id="editor-feedback">${buffer.version !== file.version ? '磁盘文件已经变化。系统保留你的草稿，保存时会检查冲突。' : 'Ctrl / ⌘ + S 保存文件和工作快照。此操作不会创建 Git 提交。'}</p></section>`;
}

// 浏览器发送带工作区标识的本地请求。
async function postLocal(route, payload) {
  const response = await fetch(route, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CoHarness-Token': state.data.token}, body: JSON.stringify(payload)});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '系统未能完成操作。');
  return value;
}

// 浏览器保存文件并重新读取磁盘状态。
async function saveEditor() {
  const {file} = selection();
  if (!file || !state.editing || state.saving) return;
  rememberEditor();
  const key = editorKey(file);
  const buffer = state.editorBuffers[key];
  state.saving = true;
  try {
    const saved = await postLocal('/api/file/save', {workspaceId: state.data.workspaceId, path: file.path, version: buffer.version, content: buffer.content});
    state.editorBuffers[key] = {content: buffer.content, version: saved.version, dirty: false};
    await loadSnapshot();
    notify('文件与工作快照已保存。系统没有创建 Git 提交。');
  } catch (error) {
    if ($('#editor-feedback')) $('#editor-feedback').textContent = error.message;
    notify(error.message);
  } finally { state.saving = false; }
}

// 页面保存草稿后返回工作区概述。
function showOverview() {
  state.returnPoint = null;
  state.previewDefinition = null;
  rememberDraft();
  rememberEditor();
  state.editing = false;
  state.file = null;
  renderTree();
  renderMain();
}

// 页面打开本地目录选择面板。
async function showDirectoryDialog() {
  if (!state.data) return;
  $('#directory-dialog').showModal();
  await browseDirectory(state.data.root);
}

// 页面列出所选路径下的实际子目录。
async function browseDirectory(path) {
  $('#directory-error').textContent = '';
  try {
    const result = await postLocal('/api/directories', {path});
    $('#directory-path').value = result.path;
    $('#directory-list').innerHTML = `<button data-directory="${esc(result.parent)}">↑ 上一级目录</button>` + result.directories.map(directory => `<button data-directory="${esc(directory.path)}">▱ ${esc(directory.name)}</button>`).join('');
  } catch (error) { $('#directory-error').textContent = error.message; }
}

// 页面切换工作区并保留其他目录的编辑草稿。
async function openWorkspace() {
  rememberDraft();
  rememberEditor();
  const button = $('#choose-directory');
  button.disabled = true;
  try {
    await postLocal('/api/workspace/open', {path: $('#directory-path').value});
    state.editing = false;
    state.file = null;
    $('#filter').value = '';
    $('#changes-only').checked = false;
    $('#directory-dialog').close();
    await loadSnapshot();
  } catch (error) { $('#directory-error').textContent = error.message; }
  finally { button.disabled = false; }
}

// 页面注册拖动、键盘导航与首次读取。
function initialize() {
  document.addEventListener('click', handleClick);
  $('#refresh').addEventListener('click', () => loadSnapshot());
  $('#filter').addEventListener('input', renderTree);
  $('#overview-button').addEventListener('click', showOverview);
  $('#changes-only').addEventListener('change', renderTree);
  $('#open-workspace').addEventListener('click', showDirectoryDialog);
  $('#close-directory').addEventListener('click', () => $('#directory-dialog').close());
  $('#browse-directory').addEventListener('click', () => browseDirectory($('#directory-path').value));
  $('#choose-directory').addEventListener('click', openWorkspace);
  $('#directory-path').addEventListener('keydown', event => { if (event.key === 'Enter') browseDirectory(event.target.value); });
  $('#zoom-context').addEventListener('click', toggleContextZoom);
  $('#close-context').addEventListener('click', closeContext);
  $('#reopen-context').addEventListener('click', () => {
    $('#context').classList.remove('hidden'); $('#workspace').classList.add('context-open'); $('#reopen-context').classList.add('hidden');
  });
  const handle = $('#resize-handle');
  handle.addEventListener('pointerdown', event => {
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (handle.hasPointerCapture(event.pointerId)) setPanelWidth(window.innerWidth - event.clientX);
  });
  handle.addEventListener('pointerup', event => handle.releasePointerCapture(event.pointerId));
  handle.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      setPanelWidth($('#context').getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 32 : -32));
    }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's' && state.editing) { event.preventDefault(); saveEditor(); }
    if (event.key === 'Escape' && !$('#directory-dialog').open) closeContext();
    if (event.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#filter').focus(); }
  });
  const savedWidth = Number(localStorage.getItem('coharness.panelWidth'));
  if (savedWidth >= 320) setPanelWidth(savedWidth);
  window.addEventListener('beforeunload', event => {
    if (Object.values(state.editorBuffers).some(buffer => buffer.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
  loadSnapshot(true);
  setInterval(() => loadSnapshot(false, true), 4000);
}

// 页面在全部交互函数定义后启动。
initialize();
