'use strict';

const state = {space: 'project', spaceViews: new Map(), projectView: 'files', projectDirectory: '', developmentPage: 'current', page: 'task', data: null, file: null, change: 0, expanded: false, trail: [], panelScroll: {}, returnPoint: null, previewDefinition: null, drafts: {}, demo: 0, mode: 'diff', editing: false, editorBuffers: {}, loading: false, collapsedChanges: {}, changeScroll: {}, directoryOpen: new Map()};
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
  if (state.loading || (quiet && (state.taskSaving || $('#task-dialog').open || state.editing || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || $('#directory-dialog').open))) return;
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
    const taskChanged = state.data && state.data.workflow?.revision !== next.workflow.revision;
    if (quiet && !changed && !taskChanged) return;
    if (changed || !quiet) { state.projectPreview = null; state.reading = null; closeReadingEvidence(); }
    const scroll = $('#main').scrollTop;
    if (state.data && state.page === 'history' && !switched) { state.liveData = next; state.data.token = next.token; return; }
    state.liveData = next;
    state.data = next;
    $('#project-name').textContent = next.project;
    $('#project-name').title = next.root;
    if (switched) { state.projectView = 'files'; state.projectDirectory = ''; state.space = 'project'; state.page = 'task'; state.file = null; state.editing = false; state.change = 0; clearTimeout(state.taskSaveTimer); }
    if (changed) {
      state.trail = [];
      state.returnPoint = null;
      state.previewDefinition = null;
      closeContext();
      $('#reopen-context').classList.add('hidden');
    }
    if ((initial || switched) && state.space === 'development') restoreTaskView();
    renderTree();
    if (state.page !== 'history') renderMain();
    if (state.restoreScroll !== undefined) { $('#main').scrollTop = state.restoreScroll; delete state.restoreScroll; }
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
  let file = state.data?.files.find(item => item.path === state.file);
  if (state.data && state.space !== 'review') {
    file ||= projectFiles().find(item => item.path === state.file);
    const preview = state.projectPreview;
    if (preview?.workspaceId === state.data.workspaceId && preview.path === state.file && preview.file) file = {...file, ...preview.file};
  }
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
  renderSpaceNavigation();
  const tree = $('#tree');
  if (state.space === 'development') return renderFileExplorer();
  if (state.space === 'project') { state.projectView === 'files' ? renderFileExplorer() : renderReadingNavigation(); return; }
  const paneScroll = $('.map-pane').scrollTop;
  tree.querySelectorAll('details[data-tree-key]').forEach(directory => {
    state.directoryOpen.set(directory.dataset.treeKey, directory.open);
  });
  const filter = $('#filter').value.toLowerCase();
  const files = state.data.files.filter(file => `${file.path} ${file.description}`.toLowerCase().includes(filter) && (state.space === 'review' ? file.kind !== '未修改' : file.kind !== '删除')).sort((a, b) => a.path.localeCompare(b.path));
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
  const renderNode = node => Object.entries(node.children).sort(([a, left], [b, right]) => Number(Boolean(left.file)) - Number(Boolean(right.file)) || a.localeCompare(b)).map(([name, child]) => {
    if (child.file) {
      const file = child.file;
      const status = state.space === 'project' ? file.label : fileStatus(file);
      return `<button class="file-button ${state.file === file.path ? 'active' : ''}" data-file="${esc(file.path)}" title="${esc(file.description)} · ${status}" ${state.file === file.path ? 'aria-current="page"' : ''}><span class="status-dot ${status === '已对齐' ? 'done' : status === '待对齐' ? '' : 'pending'}"></span><span class="file-copy"><span class="file-name">${esc(name)}</span><div class="file-desc">${state.space === 'project' ? esc(file.descriptionSource) : esc(file.label) + ' · ' + status}</div></span><span class="file-kind">${file.kind === '新增' ? '+' : file.kind === '删除' ? '−' : '·'}</span></button>`;
    }
    const pending = files.filter(file => file.path.startsWith(child.path + '/')).length;
    const key = `${state.data.workspaceId}:${state.space}:${state.data.review?.id || 'working'}:${child.path}`;
    const open = state.directoryOpen.get(key) ?? Boolean(state.file?.startsWith(child.path + '/'));
    if (state.space === 'project') {
      const selected = !state.file && state.projectDirectory === child.path;
      return `<div class="project-directory" data-tree-key="${esc(key)}" data-tree-path="${esc(child.path)}"><div class="directory-row ${selected ? 'active' : ''}"><button class="directory-toggle" data-folder-toggle="${esc(child.path)}" aria-label="${open ? '收起' : '展开'} ${esc(child.path)}" aria-expanded="${open}">${open ? '▾' : '▸'}</button><button class="directory-name" data-project-directory="${esc(child.path)}" ${selected ? 'aria-current="page"' : ''}><span class="folder-icon">▱</span><span>${esc(name)}</span><span class="count" title="已载入文件">${pending}</span></button></div><div class="children ${open ? '' : 'hidden'}">${renderNode(child)}</div></div>`;
    }
    return `<details class="directory" data-tree-key="${esc(key)}" data-tree-path="${esc(child.path)}" ${open ? 'open' : ''}><summary><span class="folder-icon">▱</span>${esc(name)} <span class="count">${pending}</span></summary><p class="dir-desc">${esc(state.data.directories[child.path] || '')}</p><div class="children">${renderNode(child)}</div></details>`;
  }).join('');
  tree.innerHTML = renderNode(root) || '<p class="muted small">系统未找到匹配文件。</p>';
  tree.querySelectorAll('details[data-tree-key]').forEach(directory => {
    directory.addEventListener('toggle', () => {
      if (directory.isConnected) state.directoryOpen.set(directory.dataset.treeKey, directory.open);
    });
  });
  $('.map-pane').scrollTop = paneScroll;
  $('#file-count').textContent = state.space === 'project' ? state.data.files.length : state.page === 'history' ? state.data.files.length : state.data.git.changes.length;
  $('#overview-button').classList.toggle('active', !state.file && (state.space !== 'project' || !state.projectDirectory));
}

// 页面根据 Git 状态展示当前任务入口。
function renderOverview() {
  if (state.space === 'project') return renderProjectSpace();
  if (state.space === 'development') return renderTaskHome();
  const files = state.data.files.filter(file => file.kind !== '未修改');
  $('#main').innerHTML = `${renderCommitHeader()}<div class="space-intro"><span class="eyebrow">审阅空间</span><h1>${state.data.review ? '本次提交的修改' : '当前修改'}</h1><p>${files.length ? '用户可以从左侧选择文件，开始审阅。' : state.page === 'history' ? '当前提交没有可展示的修改。' : '工作目录当前没有未提交修改。'}</p>${state.page !== 'history' ? '<button data-action="history">审阅历史提交 →</button>' : ''}</div>`;
}

// 页面保留每个修改项的未提交输入。
function rememberDraft() {
  const input = $('#expectation');
  const {file, change} = selection();
  if (input && file && change) state.drafts[`${state.data.workspaceId}:${file.path}:${file.version}:${change.id}${state.data.review ? ':commit:' + state.data.review.id : ''}`] = input.value;
}

// 页面切换文件并恢复目录中的位置。
function selectFile(path, index = 0) {
  if (state.space === 'project') state.projectView = 'files';
  if (state.file !== path) state.projectPreview = null;
  state.page = state.data.review ? 'history' : 'task';
  setWorkspaceTab(state.page);
  state.returnPoint = null;
  state.previewDefinition = null;
  rememberDraft();
  rememberEditor();
  state.editing = false;
  state.file = path;
  if (state.space === 'project') state.projectDirectory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  state.change = index;
  state.expanded = false;
  state.mode = state.space === 'project' ? 'source' : state.data.files.find(file => file.path === path)?.changes.length ? 'diff' : 'source';
  state.demo = 0;
  renderTree();
  renderMain();
  $('#main').scrollTop = 0;
}

// 页面根据当前选择展示概览或修改项。
function renderMain() {
  $('#main').classList.remove('definition-open');
  if (state.space === 'project') return renderProjectSpace();
  if (state.space === 'development') return state.file ? renderDevelopmentFile() : renderTaskHome();
  if (!state.file) return renderOverview();
  const {file} = selection();
  if (!file) { state.file = null; return renderOverview(); }
  state.change = Math.min(state.change, Math.max(0, file.changes.length - 1));
  const change = file.changes[state.change];
  const selectedSymbol = state.data.symbols.find(symbol => symbol.id === change?.symbolId);
  state.reviewToolsOpen ??= false;
  $('#main').innerHTML = `<div class="editor-shell review-shell">${editorTabs(file)}${renderCommitHeader()}
    <div class="editor-toolbar"><code>${esc(file.path)}</code><span class="badge">${file.kind}</span><div class="toolbar-spacer"></div>
    <button data-action="show-source" class="${state.mode==='source'?'active':''}">源码</button><button data-action="show-diff" class="${state.mode==='diff'?'active':''}" ${!change?'disabled':''}>差异</button>
    <button data-action="develop-file" ${!file.editable?'disabled':''}>编辑文件</button><button data-action="toggle-review-tools" aria-pressed="${state.reviewToolsOpen}">对齐面板</button></div>
    ${change&&state.mode==='diff'?renderChangeList(file):''}
    <div class="review-body ${state.reviewToolsOpen&&change&&state.mode==='diff'?'tools-open':''}"><section class="review-code">
    ${state.mode==='source'||!change?renderSource(file):`<div class="code-actions"><button data-action="expand-code">${state.expanded?'仅看修改范围':'查看完整文件'}</button><div class="toolbar-spacer"></div>${selectedSymbol?`<button data-symbol="${esc(selectedSymbol.id)}">调用上下文 · ${esc(selectedSymbol.name)} ↗</button>`:''}</div><div id="diff-target">${renderDiff(file,change)}</div>`}
    </section>${state.reviewToolsOpen&&change&&state.mode==='diff'?reviewTools(file,change,selectedSymbol):''}</div>${editorStatus(file)}</div>`;
  const editor = $('#source-editor');
  if (editor) editor.addEventListener('input', rememberEditor);
  const input = $('#expectation');
  if (input) input.addEventListener('input', rememberDraft);
  const list = $('#change-list');
  if (list) {
    list.scrollTop = state.changeScroll[editorKey(file)] || 0;
    list.addEventListener('scroll', () => { state.changeScroll[editorKey(file)] = list.scrollTop; });
  }
  if (state.previewDefinition) renderDefinitionPreview();
}

// 页面通过可收起列表展示修改范围和对齐状态。
function renderChangeList(file) {
  return `<div class="change-switcher"><label for="change-picker">修改项</label><select id="change-picker" aria-label="选择修改项">${file.changes.map((change,index)=>`<option value="${index}" ${index===state.change?'selected':''}>${index+1}. ${esc(change.title)} · L${change.start}–${change.end}</option>`).join('')}</select><span>${state.change+1} / ${file.changes.length}</span><button data-action="previous-change" aria-label="上一项" ${state.change===0?'disabled':''}>↑</button><button data-action="next-change" aria-label="下一项" ${state.change===file.changes.length-1?'disabled':''}>↓</button></div>`;
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
  if(code) window.CoEditor.reveal(code, file.exists ? change.start : change.oldStart);
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
  return `<div class="diff-grid"><section class="code-pane"><div class="code-title"><span>修改前</span><span>${esc(state.data.baseline)}</span></div><div class="code-scroll" id="before-code">${codeLines(file.before, oldStart, oldEnd, file.removedLines, 'removed')}</div></section><section class="code-pane"><div class="code-title after"><span>修改后</span><span>L${change.start}—${change.end}</span></div><div class="code-scroll" id="after-code">${codeLines(file.after, afterStart, afterEnd, file.addedLines, 'added')}</div></section></div>`;
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
  const draft = state.drafts[`${state.data.workspaceId}:${file.path}:${file.version}:${change.id}${state.data.review ? ':commit:' + state.data.review.id : ''}`] ?? record?.expectation ?? '';
  return `<section class="alignment"><div class="alignment-head"><h2>修改对齐</h2><span class="badge">${record?.status || (history.length ? '待重新对齐' : '待对齐')}</span></div><p class="small muted">我们通过预期效果，确认双方正在解决同一个问题。</p><label for="expectation" class="small">结合上下文，请输入预期修改效果。</label><textarea id="expectation" maxlength="12000" placeholder="请描述你希望这项修改产生的效果。">${esc(draft)}</textarea><div class="alignment-actions"><button class="primary" data-action="save-expectation">提交预期</button><button data-action="confirm-expectation">确认当前预期</button><span>${state.data.review ? '系统将记录绑定到当前提交。' : '系统将记录绑定到当前源文件快照。'}</span></div>${record ? `<div class="saved-record"><strong>${record.status === '已对齐' ? '用户已确认当前预期' : '用户已提交预期'}</strong><br>${esc(record.expectation)}</div>` : ''}<p class="note">当前版本保存预期与人工确认。模型尚未参与对齐；实现效果保留“待验证”状态。</p>${history.length ? `<details><summary class="small">查看此前版本的预期（${history.length}）</summary>${history.map(item => `<div class="saved-record"><small>${esc(item.change)} · ${item.version.slice(0, 8)} · ${esc(item.status)}</small><br>${esc(item.expectation)}</div>`).join('')}</details>` : ''}</section>`;
}

// 浏览器提交绑定版本的用户预期。
async function saveExpectation(status) {
  const workspaceId = state.data.workspaceId;
  const reviewId = state.data.review?.id;
  const {file, change} = selection();
  const expectation = $('#expectation').value.trim();
  if (!expectation) return notify('请先输入预期修改效果。');
  rememberDraft();
  const buttons = [...document.querySelectorAll('.alignment-actions button')];
  buttons.forEach(button => button.disabled = true);
  try {
    const response = await fetch('/api/alignment', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CoHarness-Token': state.data.token}, body: JSON.stringify({workspaceId: state.data.workspaceId, commit: state.data.review?.id, path: file.path, change: change.id, version: file.version, basis: state.data.basis, expectation, status})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '系统未能保存预期。');
    if (state.data.workspaceId !== workspaceId || state.data.review?.id !== reviewId) return notify('系统已保存该版本的预期。');
    if (state.data.review) {
      const scroll = $('#main').scrollTop;
      state.data.records[`alignment:${file.path}:${result.basis}:${result.change}`] = result;
      state.data.events.unshift({time: result.time, kind: status === '已对齐' ? '用户确认预期' : '用户提交预期', data: result});
      renderTree(); renderMain(); $('#main').scrollTop = scroll;
    } else await loadSnapshot();
    notify(status === '已对齐' ? '系统已保存你的确认。实现效果仍待验证。' : '系统已保存你的预期。');
  } catch (error) { notify(error.message); }
  finally { buttons.forEach(button => button.disabled = false); }
}

// 页面只展示本地服务实际记录的操作。
function renderEvents(path = null) {
  const events = state.data.events.filter(event => (!path || event.data.path === path) && (!state.data.review || event.data.commit === state.data.review.id));
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
  coStorage.setItem('coharness.panelWidth', String(bounded));
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
  preview.innerHTML = `<div class="review-return-bar"><button class="primary" data-action="return-review"><span aria-hidden="true">←</span> ${state.space === 'project' ? '返回文件阅读' : '返回修改审阅'}</button><div><span class="return-caption">返回位置</span><strong>${esc(state.returnPoint.label)}</strong></div></div><div class="definition-preview-heading"><span class="eyebrow">正在查看关联代码</span><strong>${esc(symbol.name)}</strong><p>${esc(symbol.path)} · L${symbol.start}–${symbol.end}</p></div><div class="source-view"><div class="code-title"><span>${esc(symbol.name)}(${esc(symbol.parameters)})</span><span>${parameterLabel(symbol)}</span></div><div class="code-scroll" id="definition-code">${codeLines(file.after, 1, file.after.split('\n').length)}</div></div>`;
  $('#main').append(preview);
  $('#main').classList.add('definition-open');
  $('#main').scrollTo({top: 0, behavior: 'instant'});
  const code = $('#definition-code');
  queueMicrotask(() => window.CoEditor.reveal(code, symbol.start));
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
  if (!state.data) return notify('系统正在读取目录，请稍后操作。');
  if (handleReadingClick(button)) return;
  if (button.dataset.projectDirectory !== undefined) return selectProjectDirectory(button.dataset.projectDirectory);
  if (button.dataset.folderToggle !== undefined) return toggleProjectDirectory(button);
  if (button.dataset.space) return switchSpace(button.dataset.space);
  if (button.dataset.commit) return showCommit(button.dataset.commit);
  if (button.dataset.historyPage !== undefined) return showHistory(Number(button.dataset.historyPage));
  if (button.dataset.restoreTask) return showTaskOperation(button.dataset.restoreTask);
  if (button.dataset.closeFile) return closeFileTab(button.dataset.closeFile);
  if (button.dataset.file) return selectFile(button.dataset.file);
  if (button.dataset.change !== undefined) return selectChange(Number(button.dataset.change));
  if (button.dataset.directory) return browseDirectory(button.dataset.directory);
  if (button.dataset.symbol) return openContext(button.dataset.symbol);
  if (button.dataset.definition) return jumpToDefinition(button.dataset.definition);
  if (button.dataset.relation) return changeContextChain(button, false);
  if (button.dataset.expandRelation) return changeContextChain(button, true);
  const actions = {
    'toggle-review-tools': () => { rememberDraft(); state.reviewToolsOpen = !state.reviewToolsOpen; renderMain(); },
    'preview-retry': () => loadProjectPreview(0),
    'preview-next': () => loadProjectPreview(state.projectPreview?.next),
    'preview-previous': () => loadProjectPreview(state.projectPreview?.previous?.at(-1) || 0, true),
    'task-home': () => switchSpace('development'),
    'development-current': () => showDevelopmentPage('current'),
    'development-paused': () => showDevelopmentPage('paused'),
    'review-current': showCurrentReview,
    'develop-file': () => switchSpace('development', {file: state.file}),
    'history': () => showHistory(),
    'save-task': () => saveCurrentTask(),
    'pause-task': () => showTaskOperation(),
    'close-task-dialog': () => $('#task-dialog').close(),
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
    'edit-file': () => { if (state.data.review) return; rememberDraft(); state.editing = true; renderMain(); },
    'save-file': saveEditor,
    'leave-editor': () => showDevelopmentPage('current'),
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
  return `<div class="source-view"><div class="code-title"><span>${file.exists?state.data.review?'提交中的文件':'源代码':'文件已删除'}</span>${outlineSelect(file)}</div><div class="code-scroll" id="after-code">${codeLines(file.after,1,file.after.split('\n').length)}</div></div>`;
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
  return `<section class="editor-wrap"><div class="editor-toolbar"><span>UTF-8 · ${esc(file.path)}</span><div><button data-action="leave-editor">返回当前任务</button> <button data-action="save-file" class="primary">保存工作快照</button></div></div><textarea id="source-editor" aria-label="文件编辑器" spellcheck="false" wrap="off">${esc(buffer.content)}</textarea><p id="editor-feedback">${buffer.version !== file.version ? '磁盘文件已经变化。系统保留你的草稿，保存时会检查冲突。' : 'Ctrl / ⌘ + S 保存文件和工作快照。此操作不会创建 Git 提交。'}</p></section>`;
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
  } finally { state.saving = false; saveEditorDrafts(); }
}

// 页面保存草稿后返回工作区概述。
function showOverview() {
  if (!state.data) return;
  if (state.space === 'project' && state.projectView !== 'files') {
    readingPosition().scene = null;
    closeReadingEvidence(); renderTree(); renderMain(); $('#main').scrollTop = 0;
    return;
  }
  rememberDraft(); rememberEditor();
  state.returnPoint = null; state.previewDefinition = null;
  state.trail = []; closeContext();
  state.editing = false; state.file = null;
  if (state.space === 'project') state.projectDirectory = '';
  renderTree(); renderMain(); $('#main').scrollTop = 0;
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
  rememberSpace();
  rememberTaskLocally();
  clearTimeout(state.taskSaveTimer);
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
  document.addEventListener('click', event => {
    if (!state.data || $('#task-dialog').open || event.target.closest('.task-menu, [data-restore-task], [data-action="pause-task"], [data-action="save-task"], #confirm-task-operation')) return;
    rememberTaskLocally();
    if (state.data.workflow.active && state.space === 'development') scheduleTaskSave();
  });
  window.addEventListener('pagehide', () => { rememberSpace(); rememberTaskLocally(); });
  $('#confirm-task-operation').addEventListener('click', confirmTaskOperation);
  window.addEventListener('message', event => { if(event.source === parent && event.data?.channel === bridgeConfig.channel && event.data.type === 'storage-error') notify('浏览器草稿存储失败。请及时保存文件。'); });
  $('#refresh').addEventListener('click', () => state.data?.review ? showCommit(state.data.review.id) : loadSnapshot());
  document.addEventListener('change', event => { if (event.target.id === 'review-commit') showCommit(event.target.value); });
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
    if (event.key === '/' && !document.activeElement.closest('.cm-editor') && !document.activeElement.isContentEditable && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#filter').focus(); }
  });
  const savedWidth = Number(coStorage.getItem('coharness.panelWidth'));
  if (savedWidth >= 320) setPanelWidth(savedWidth);
  window.addEventListener('beforeunload', event => {
    if (Object.values(state.editorBuffers).some(buffer => buffer.dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
  try { state.editorBuffers = JSON.parse(coStorage.getItem('coharness.editorDrafts') || '{}'); } catch {}
  loadSnapshot(true).then(() => { bridgeReady=true; sendHost({type:'ready'}); });
  document.addEventListener('input', () => { if(state.editing) saveEditorDrafts(); });
  window.addEventListener('pagehide', saveEditorDrafts);
  setInterval(() => { if(hostVisible) loadSnapshot(false, true); }, 15000);
}

// 页面在全部交互函数定义后启动。
initialize();
