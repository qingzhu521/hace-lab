'use strict';

// 页面为当前目录生成本地草稿键。
function workflowKey() { return `coharness.task:${state.data.workspaceId}`; }

// 页面读取尚未同步的需求草稿。
function taskDraft() {
  try { return JSON.parse(coStorage.getItem(workflowKey()) || 'null'); } catch { return null; }
}

// 页面读取当前任务的需求内容。
function taskRequest() {
  const active = state.data.workflow.active;
  const draft = taskDraft();
  return draft && draft.taskId === (active?.id || null) ? draft.request : active?.request || '';
}

// 页面保存任务的阅读位置和预期草稿。
function currentTaskView() {
  if (state.space !== 'development') return taskDraft()?.view || state.data.workflow.active?.view || {};
  rememberDraft();
  return {file: state.file, change: state.change, mode: state.mode, expanded: state.expanded,
    scroll: state.returnPoint?.scroll ?? $('#main').scrollTop, basis: state.data.basis, drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key]) => key.startsWith(state.data.workspaceId + ':')))};
}

// 页面及时保留本地需求和阅读位置。
function rememberTaskLocally() {
  if (!state.data) return;
  const active = state.data.workflow.active;
  const request = $('#task-request')?.value ?? taskRequest();
  try { coStorage.setItem(workflowKey(), JSON.stringify({taskId: active?.id || null, request, view: currentTaskView()})); }
  catch { if ($('#task-save-status')) $('#task-save-status').textContent = '本地草稿空间不足，请点击保存需求。'; }
}

// 页面恢复同目录未完成任务的阅读位置。
function restoreTaskView() {
  const active = state.data.workflow.active;
  if (!active) return;
  const local = taskDraft();
  const view = local?.taskId === active.id ? local.view : active.view;
  if (!view) return;
  if (view.drafts && typeof view.drafts === 'object') state.drafts = {...state.drafts, ...view.drafts};
  if (state.data.files.some(file => file.path === view.file)) {
    state.file = view.file;
    state.change = view.basis === state.data.basis && Number.isInteger(view.change) ? Math.max(0, view.change) : 0;
    state.mode = view.mode === 'source' ? 'source' : 'diff';
    state.expanded = Boolean(view.expanded);
    state.restoreScroll = Number(view.scroll) || 0;
  }
}

// 页面在开发入口直接解释本次修改。
function renderChangeDigest() {
  const files = (state.data.files || []).filter(file => file.kind !== '未修改' && file.changes.length);
  if (!files.length) return '';
  const shown = files.slice(0, 8);
  return `<section class="change-digest" aria-label="本次修改自述"><div class="section-heading"><h2>本次修改 · 系统自述</h2><span>${files.length} 个文件</span></div><p class="note">系统根据实际差异生成说明。用户可以从这里进入审阅，或继续编辑同一文件。</p>${shown.map(file => {
    const record = recordFor(file, file.changes[0]);
    return `<article class="digest-item"><div class="digest-heading"><code>${esc(file.path)}</code><span class="badge">${esc(file.kind)}</span></div><p>${esc(fileChangeSummary(file, {record}))}</p><div class="digest-actions"><button data-review-file="${esc(file.path)}" data-review-change="0">审阅自述 →</button><button data-file="${esc(file.path)}">在开发空间打开</button></div></article>`;
  }).join('')}${files.length > shown.length ? `<p class="note">其余 ${files.length - shown.length} 个文件在审阅空间查看。</p>` : ''}</section>`;
}

// 页面展示当前任务与真实 Git 状态。
function renderTaskHome() {
  const {git, workflow} = state.data;
  const active = workflow.active;
  if (state.developmentPage === 'paused') {
    $('#main').innerHTML = `<div class="task-page"><div class="space-intro"><span class="eyebrow">开发空间</span><h1>暂存任务</h1><p>用户恢复任务后，可以继续开发。</p></div><section class="paused-tasks">${workflow.paused.map(task => `<article><div><strong>${esc(task.request.slice(0, 100) || '未命名任务')}</strong><p>${task.stash ? `代码暂存 ${esc(task.stash.slice(0, 12))}` : '任务记录 · 没有代码暂存'}</p></div><button data-restore-task="${esc(task.id)}" ${active || !git.clean ? 'disabled title="请先暂存当前任务，并清空未提交修改"' : ''}>恢复任务</button></article>`).join('') || '<p class="note">当前项目没有暂存任务。</p>'}</section></div>`;
    return;
  }
  $('#main').innerHTML = `<div class="task-page"><div class="development-heading"><div><span class="eyebrow">开发空间</span><h1>${active ? '当前任务' : '提出开发需求'}</h1></div><button data-action="pause-task" ${!active && git.clean && !taskRequest().trim() ? 'disabled' : ''}>暂存当前任务</button></div>${active?.error ? `<p class="error-box">${esc(active.error)}</p>` : ''}<section class="task-request-card"><label for="task-request">${active ? '当前任务的预期效果' : '请输入你希望实现的功能'}</label><textarea id="task-request" maxlength="12000" placeholder="描述你希望实现的功能和预期效果。">${esc(taskRequest())}</textarea><div class="task-form-footer"><button class="primary" data-action="save-task">保存需求</button><span id="task-save-status">${active ? '系统已保存当前任务。' : '系统将按项目保存需求。'}</span></div></section><p class="note development-note">模型修改方案、运行验证和提交都保留用户确认步骤。</p>${renderChangeDigest()}${renderAgentPanel()}${renderVerificationPanel()}${!git.clean ? `<div class="space-link"><span>工作目录包含 ${git.changes.length} 个变动文件。</span><button data-action="review-current">进入审阅空间 →</button></div>` : ''}${renderEvents()}</div>`;
  $('#task-request').addEventListener('input', () => { rememberTaskLocally(); scheduleTaskSave(); });
  if (developmentState()?.run?.status === 'running' && !state.developmentTimer) pollDevelopment();
  if (verificationSnapshot().run?.status === 'running' && !state.verificationTimer) pollVerification();
}

// 页面同步三个空间的选中状态。
function setWorkspaceTab() { renderSpaceNavigation(); }

// 页面延迟保存输入，避免每次按键都写入数据库。
function scheduleTaskSave() {
  clearTimeout(state.taskSaveTimer);
  if (!state.data.workflow.active && !taskRequest().trim()) return;
  state.taskSaveTimer = setTimeout(() => saveCurrentTask(true), 900);
}

// 浏览器保存需求与阅读状态。
async function saveCurrentTask(quiet = false) {
  if (state.taskSaving) return false;
  rememberTaskLocally();
  const workspaceId = state.data.workspaceId;
  const request = taskRequest();
  const view = currentTaskView();
  const signature = JSON.stringify([workspaceId, request, view]);
  if (quiet && signature === state.lastTaskSave) return true;
  state.taskSaving = true;
  try {
    const workflow = await postLocal('/api/task/save', {workspaceId, revision: state.data.workflow.revision, request, view});
    if (state.data.workspaceId !== workspaceId) return false;
    state.data.workflow = workflow;
    state.lastTaskSave = signature;
    const latest = $('#task-request')?.value ?? request;
    coStorage.setItem(workflowKey(), JSON.stringify({taskId: workflow.active.id, request: latest, view}));
    if (latest !== request) scheduleTaskSave();
    if ($('#task-save-status')) $('#task-save-status').textContent = '需求与阅读位置已保存。';
    const pause = $('#main [data-action="pause-task"]');
    if (pause) pause.disabled = false;
    if (!quiet) notify('当前任务已保存。');
    return true;
  } catch (error) {
    if ($('#task-save-status')) $('#task-save-status').textContent = error.message + ' 本地草稿仍然保留。';
    if (!quiet) notify(error.message);
    return false;
  } finally { state.taskSaving = false; }
}

// 页面展示暂存或恢复前的具体范围。
async function showTaskOperation(taskId = null) {
  try {
    rememberEditor();
    rememberTaskLocally();
    clearTimeout(state.taskSaveTimer);
    if (state.taskSaving) return notify('需求正在保存，请稍后操作。');
    if (Object.entries(state.editorBuffers).some(([key, buffer]) => key.startsWith(state.data.workspaceId + ':') && buffer.dirty)) return notify('请先保存文件编辑，再暂存或恢复任务。');
    if (!taskId && taskRequest().trim() && !await saveCurrentTask()) return;
    const workspaceId = state.data.workspaceId;
    const response = await fetch('/api/snapshot');
    const next = await response.json();
    if (!response.ok) return notify(next.error);
    if (next.workspaceId !== workspaceId) return notify('工作区已切换，请刷新页面。');
    state.data.git = next.git;
    state.data.workflow = next.workflow;
    const git = next.git;
    if (!taskId && git.clean && !next.workflow.active) return notify('当前没有需要暂存的任务或修改。');
    if (!taskId && !git.clean && !git.canStash) return notify('请打开已有提交的仓库根目录，再暂存代码。');
    if (taskId && (next.workflow.active || !git.clean)) return notify('请先暂存当前任务，再恢复其他任务。');
    state.taskOperation = {workspaceId, revision: next.workflow.revision, gitToken: git.token, taskId, view: currentTaskView()};
    const restoreTarget = next.workflow.paused.find(task => task.id === taskId);
    if ($('.task-menu')) $('.task-menu').open = false;
    $('#task-dialog-title').textContent = taskId ? '恢复暂存任务' : '暂存当前任务';
    $('#task-dialog-body').innerHTML = taskId ? restoreTarget?.stash ? '<p>系统将恢复任务及其代码修改。恢复可能产生冲突，Git 暂存备份会继续保留。</p>' : '<p>系统将恢复需求和阅读位置。该任务没有代码暂存。</p>' : `<p>${git.clean ? '系统将保存任务记录。工作区干净，无需创建 Git stash。' : `系统将暂存仓库中的 ${git.changes.length} 个变动文件，包括新建文件。暂存后，工作区将恢复干净。`}</p><ul>${git.changes.slice(0, 8).map(item => `<li>${esc(item.path)} · ${esc(item.kind)}</li>`).join('')}</ul>${git.changes.length > 8 ? '<p>其余变动文件也会包含在本次暂存中。</p>' : ''}<p class="note">忽略文件不进入 stash。暂存不表示修改已对齐。</p>`;
    $('#task-dialog-error').textContent = '';
    $('#confirm-task-operation').textContent = taskId ? '恢复任务' : '暂存当前任务';
    $('#confirm-task-operation').disabled = false;
    $('#task-dialog').showModal();
  } catch (error) { notify(error.message); }
}

// 浏览器执行已经展示范围的任务操作。
async function confirmTaskOperation() {
  const operation = state.taskOperation;
  if (!operation || state.taskOperating) return;
  state.taskOperating = true;
  $('#confirm-task-operation').disabled = true;
  try {
    const result = await postLocal(operation.taskId ? '/api/task/restore' : '/api/task/pause', operation);
    state.data.workflow = result.workflow || result;
    coStorage.removeItem(workflowKey());
    for (const buffers of [state.editorBuffers, state.drafts]) {
      for (const key of Object.keys(buffers)) if (key.startsWith(operation.workspaceId + ':')) delete buffers[key];
    }
    state.file = null;
    state.space = 'development';
    state.developmentPage = operation.taskId ? 'current' : 'paused';
    state.page = 'task';
    state.lastTaskSave = null;
    $('#task-dialog').close();
    await loadSnapshot();
    if (operation.taskId) { restoreTaskView(); renderMain(); $('#main').scrollTop = state.restoreScroll || 0; }
    notify(result.warning || (operation.taskId ? result.workflow.active.stash ? '任务已恢复。Git 暂存备份仍然保留。' : '任务已恢复。' : '当前任务已暂存，可以开始下一项任务。'));
  } catch (error) {
    $('#task-dialog-error').textContent = error.message;
    state.taskOperation = null;
    await loadSnapshot();
  } finally { state.taskOperating = false; $('#confirm-task-operation').disabled = !state.taskOperation; }
}

// 页面将提交记录渲染为只读入口。
function historyRows(commits) {
  return commits.map(commit => `<button class="commit-row" data-commit="${esc(commit.id)}"><code>${commit.id.slice(0, 10)}</code><span><strong>${esc(commit.subject)}</strong><small>${esc(commit.author)} · ${esc(commit.date.slice(0, 10))}</small></span><span>查看 →</span></button>`).join('') || '<p class="note">当前目录尚无提交记录。</p>';
}

// 页面读取首页的最近提交。
async function loadRecentCommits() {
  const target = $('#recent-commits');
  try {
    const result = await postLocal('/api/history', {workspaceId: state.data.workspaceId});
    if (target.isConnected) target.innerHTML = historyRows(result.commits.slice(0, 3));
  } catch (error) { if (target.isConnected) target.textContent = error.message; }
}

// 页面进入提交审阅，并提供分页选择。
async function showHistory(skip = 0) {
  if (state.space !== 'review') { rememberSpace(); state.space = 'review'; }
  rememberTaskLocally();
  rememberEditor();
  rememberDraft();
  clearTimeout(state.taskSaveTimer);
  if (state.page !== 'history') state.liveData = state.data;
  state.page = 'history';
  state.editing = false;
  state.previewDefinition = null;
  state.returnPoint = null;
  state.trail = [];
  closeContext();
  setWorkspaceTab('history');
  $('#main').classList.remove('definition-open');
  const workspaceId = state.data.workspaceId;
  const ticket = state.historyTicket = (state.historyTicket || 0) + 1;
  $('#main').innerHTML = '<p>系统正在读取提交历史。</p>';
  try {
    const result = await postLocal('/api/history', {workspaceId, skip});
    if (state.page !== 'history' || state.data.workspaceId !== workspaceId || state.historyTicket !== ticket) return;
    state.historyList = {...result, skip};
    if (result.commits.length) return showCommit(result.commits[0].id);
    state.data = {...state.liveData, files: [], symbols: [], directories: {}, review: null};
    state.file = null;
    renderTree();
    $('#main').innerHTML = '<div class="space-intro"><span class="eyebrow">审阅空间</span><h1>提交历史</h1><p>当前目录尚无提交记录。</p></div>';
  } catch (error) { if (state.historyTicket === ticket) $('#main').textContent = error.message; }
}

// 页面使用已有审阅组件展示指定提交。
async function showCommit(oid) {
  if (state.space !== 'review') { rememberSpace(); state.space = 'review'; }
  rememberTaskLocally();
  rememberEditor();
  rememberDraft();
  clearTimeout(state.taskSaveTimer);
  if (state.page !== 'history') { state.liveData = state.data; state.historyList = null; }
  const previous = state.data.review;
  const oldFile = state.file;
  const oldChange = state.change;
  const workspaceId = state.data.workspaceId;
  state.page = 'history';
  state.editing = false;
  state.previewDefinition = null;
  state.returnPoint = null;
  state.trail = [];
  closeContext();
  setWorkspaceTab('history');
  $('#main').classList.remove('definition-open');
  const ticket = state.historyTicket = (state.historyTicket || 0) + 1;
  $('#main').innerHTML = '<p>系统正在读取提交修改。</p>';
  try {
    const result = await postLocal('/api/history/detail', {workspaceId, commit: oid});
    if (state.page !== 'history' || state.data.workspaceId !== workspaceId || state.historyTicket !== ticket) return;
    state.data = {...state.liveData, ...result, token: state.data.token};
    state.file = previous?.id === oid && result.files.some(file => file.path === oldFile) ? oldFile : result.files[0]?.path || null;
    state.change = previous?.id === oid ? oldChange : 0;
    state.mode = 'diff';
    state.expanded = false;
    renderTree();
    renderMain();
    $('#main').scrollTop = 0;
  } catch (error) { if (state.historyTicket === ticket) $('#main').textContent = error.message; }
}

// 页面标明提交身份，并提供其他提交的入口。
function renderCommitHeader() {
  const review = state.data.review;
  if (!review) return '';
  return `<div class="review-baseline"><span>提交 <code>${esc(review.id.slice(0, 10))}</code></span><span>${esc(review.subject)}</span><small>比较基准：${esc(state.data.baseline)}${review.merge ? ' · 第一父提交' : ''}</small></div>`;
}
