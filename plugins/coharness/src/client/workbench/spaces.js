'use strict';

// 页面为每个项目保存独立的空间位置。
function spaceKey(space = state.space) { return `${state.data.workspaceId}:${space}`; }

// 页面保存当前空间的选择、草稿和滚动位置。
function rememberSpace() {
  if (!state.data) return;
  rememberDraft();
  rememberEditor();
  if (state.space === 'development') rememberTaskLocally();
  rememberContextScroll();
  state.spaceViews.set(spaceKey(), {
    projectView: state.projectView, projectDirectory: state.projectDirectory, file: state.file, change: state.change, mode: state.mode, expanded: state.expanded,
    page: state.page, data: state.data, historyList: state.historyList,
    editing: state.editing, developmentPage: state.developmentPage,
    trail: structuredClone(state.trail), panelScroll: structuredClone(state.panelScroll),
    previewDefinition: state.previewDefinition, returnPoint: state.returnPoint,
    contextOpen: !$('#context').classList.contains('hidden'),
    contextFullscreen: $('#context').classList.contains('fullscreen'),
    codeScroll: Object.fromEntries(['after-code', 'before-code', 'definition-code'].map(id => [id, {top: $('#' + id)?.scrollTop || 0, left: $('#' + id)?.scrollLeft || 0}])),
    scroll: $('#main').scrollTop, mapScroll: $('.map-pane').scrollTop, treeScroll: $('#tree').scrollTop,
    filter: $('#filter').value, changesOnly: $('#changes-only').checked,
  });
}

// 页面切换空间，并恢复对应空间的阅读位置。
function switchSpace(space, options = {}) {
  if (!state.data || !['project', 'development', 'review'].includes(space)) return;
  if (state.space === space && !options.reset && !options.file) return;
  rememberSpace();
  closeReadingEvidence();
  closeContext();
  clearTimeout(state.taskSaveTimer);
  state.historyTicket = (state.historyTicket || 0) + 1;
  const saved = options.reset ? null : state.spaceViews.get(spaceKey(space));
  state.space = space;
  state.data = saved?.page === 'history' ? {...saved.data, token: state.liveData.token, workflow: state.liveData.workflow} : state.liveData;
  const valid = saved?.data.basis === state.data.basis;
  state.page = saved?.page || 'task';
  state.file = options.file || saved?.file || null;
  state.projectDirectory = saved?.projectDirectory || '';
  if (space === 'project') state.projectView = 'files';
  state.change = valid ? saved.change : 0;
  state.mode = space === 'project' ? 'source' : saved?.mode || 'diff';
  state.expanded = valid && saved.expanded;
  state.editing = space === 'development' && Boolean(options.file || saved?.editing);
  state.developmentPage = saved?.developmentPage || 'current';
  state.historyList = saved?.historyList || null;
  state.trail = valid ? structuredClone(saved.trail) : [];
  state.panelScroll = valid ? structuredClone(saved.panelScroll) : {};
  state.previewDefinition = valid ? saved.previewDefinition : null;
  state.returnPoint = valid ? saved.returnPoint : null;
  $('#reopen-context').classList.toggle('hidden', !state.trail.length);
  $('#filter').value = saved?.filter || '';
  $('#changes-only').checked = saved?.changesOnly || false;
  if (space === 'review' && !saved && !options.current) {
    if (state.liveData.git.clean && state.liveData.git.head) return showHistory();
    state.file = state.data.files.find(file => file.kind !== '未修改')?.path || null;
  }
  if (space === 'review' && options.current) {
    state.page = 'task'; state.data = state.liveData;
    state.file = state.data.files.find(file => file.kind !== '未修改')?.path || null;
  }
  renderTree(); renderMain();
  if (saved?.contextOpen && state.trail.length) {
    $('#context').classList.remove('hidden'); $('#workspace').classList.add('context-open'); $('#reopen-context').classList.add('hidden');
    renderContext();
    if (saved.contextFullscreen) toggleContextZoom();
  }
  for (const [id, position] of Object.entries(saved?.codeScroll || {})) {
    const element = $('#' + id);
    if (element) { element.scrollTop = position.top; element.scrollLeft = position.left; }
  }
  $('#main').scrollTop = options.file ? 0 : saved?.scroll || 0;
  $('.map-pane').scrollTop = saved?.mapScroll || 0;
  $('#tree').scrollTop = saved?.treeScroll || 0;
}

// 页面仅展示当前空间的导航工具。
function renderSpaceNavigation() {
  const labels = {project: '项目空间', development: '开发空间', review: '审阅空间'};
  if(bridgeReady)sendHost({type:'space', space:state.space});
  document.body.dataset.space = state.space;
  document.body.dataset.projectView = state.projectView || 'reading';
  document.querySelectorAll('[data-space]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.space === state.space)));
  $('#space-label').textContent = labels[state.space];
  $('#map-title').textContent = state.space === 'review' ? '源代码管理' : '资源管理器';
  $('#map-description').textContent = state.space === 'project' ? '用户逐层进入目录。' : '用户通过文件逐项审阅修改。';
  $('#overview-button span').textContent = state.space === 'project' ? '项目概览' : '修改概览';
  $('.map-pane').setAttribute('aria-label', labels[state.space] + '导航');
  const nav = $('#space-navigation');
  if (state.space === 'development') {
    nav.innerHTML = `<button data-action="development-current" class="${state.developmentPage !== 'paused' ? 'active' : ''}">当前任务</button><button data-action="development-paused" class="${state.developmentPage === 'paused' ? 'active' : ''}">暂存任务 <span>${state.data.workflow.paused.length}</span></button>`;
  } else if (state.space === 'review') {
    nav.innerHTML = `<div class="review-sources"><button data-action="review-current" class="${state.page !== 'history' ? 'active' : ''}">当前修改 <span>${state.liveData.git.changes.length}</span></button><button data-action="history" class="${state.page === 'history' ? 'active' : ''}">提交历史</button></div>${renderCommitPicker()}`;
  } else nav.innerHTML = `<div class="project-view-switch"><button data-reading-action="read" aria-pressed="${state.projectView !== 'files'}">项目阅读</button><button data-reading-action="files" aria-pressed="${state.projectView === 'files'}">文件浏览</button></div>`;
}

// 页面将提交选择放入审阅空间的对象导航。
function renderCommitPicker() {
  const review = state.data.review;
  if (state.page !== 'history' || !review) return '';
  const history = state.historyList;
  const commits = history?.commits || [{id: review.id, subject: review.subject}];
  return `<label class="commit-picker-label" for="review-commit">审阅提交</label><select id="review-commit" aria-label="选择审阅提交">${commits.map(commit => `<option value="${esc(commit.id)}" ${commit.id === review.id ? 'selected' : ''}>${esc(commit.id.slice(0, 10))} · ${esc(commit.subject)}</option>`).join('')}</select><div class="history-paging"><button data-history-page="${Math.max(0, (history?.skip || 0) - 30)}" ${history?.skip ? '' : 'disabled'}>较新</button>${history ? `<button data-history-page="${history.next || 0}" ${history.next === null ? 'disabled' : ''}>更早</button>` : '<button data-action="history">其他提交</button>'}</div>`;
}

// 页面通过面包屑连接项目、目录与文件。
function projectBreadcrumbs(path, isFile = false) {
  const parts = path ? path.split('/') : [];
  return `<nav class="breadcrumbs" aria-label="项目阅读路径"><button data-project-directory="">${esc(state.data.project)}</button>${parts.map((part, index) => `<span>/</span>${index === parts.length - 1 && isFile ? `<span aria-current="page">${esc(part)}</span>` : `<button data-project-directory="${esc(parts.slice(0, index + 1).join('/'))}" ${index === parts.length - 1 ? 'aria-current="page"' : ''}>${esc(part)}</button>`}`).join('')}</nav>`;
}

// 页面只统计当前目录下已载入且未删除的文件。
function directoryContents(files, path) {
  const prefix = path ? path + '/' : '';
  const members = files.filter(file => file.kind !== '删除' && file.path.startsWith(prefix));
  const directories = new Map();
  const direct = [];
  for (const file of members) {
    const remainder = file.path.slice(prefix.length);
    if (!remainder.includes('/')) direct.push(file);
    else {
      const name = remainder.split('/')[0];
      directories.set(name, (directories.get(name) || 0) + 1);
    }
  }
  return {members, files: direct.sort((a, b) => a.path.localeCompare(b.path)),
    directories: [...directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({name, path: prefix + name, count}))};
}

// 页面合并完整路径索引和已预载的正文。
function projectFiles() {
  const loaded = new Map(state.data.files.map(file => [file.path, file]));
  return (state.data.index || state.data.files).map(item => loaded.get(item.path) || {
    ...item, after: '', before: '', previewable: false, editable: false, changes: [], symbols: [],
    description: '', descriptionSource: '尚未生成职责说明', notice: '文件正文按需读取。', label: '文件',
  });
}

// 左栏只展示当前目录的直接子项。
function renderProjectNavigation() {
  const path = state.projectDirectory || '';
  const query = $('#filter').value.trim().toLowerCase();
  const contents = directoryContents(projectFiles(), path);
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const match = file => `${file.path} ${file.description}`.toLowerCase().includes(query);
  const files = query ? projectFiles().filter(file => file.kind !== '删除' && match(file)) : contents.files;
  const shown = files.slice(0, 100);
  const directories = query ? [] : contents.directories;
  $('#tree').innerHTML = `<div class="directory-location"><strong title="${esc(path || state.data.project)}">${esc(path || state.data.project)}</strong>${path ? `<button data-project-directory="${esc(parent)}">← 返回上级</button>` : ''}</div>${query ? `<p class="note">项目搜索 · ${files.length} 个结果</p>` : ''}${directories.map(item => `<button class="level-entry" data-project-directory="${esc(item.path)}" title="${esc(item.path)}"><span>▱</span><span class="level-name">${esc(item.name)}</span><span class="count">${item.count}</span><span>›</span></button>`).join('')}${shown.map(file => `<button class="level-entry ${file.path === state.file ? 'active' : ''}" data-file="${esc(file.path)}" title="${esc(file.path)}" ${file.path === state.file ? 'aria-current="page"' : ''}><span>▤</span><span class="level-name">${esc(query ? file.path : file.path.split('/').at(-1))}</span></button>`).join('')}${files.length > shown.length ? '<p class="note">左栏显示前 100 项。用户可通过搜索缩小范围。</p>' : ''}${!directories.length && !files.length ? '<p class="note">当前没有匹配项。</p>' : ''}`;
  $('#file-count').textContent = contents.directories.length + contents.files.length;
  $('#overview-button').classList.toggle('active', !state.file && !path);
}

// 页面只保留当前文件的一段正文。
async function loadProjectPreview(offset = 0, backwards = false) {
  if (offset == null || !state.file) return;
  const prior = state.projectPreview;
  const request = {workspaceId: state.data.workspaceId, path: state.file, offset,
    revision: offset ? prior?.revision : undefined};
  const preview = {...request, loading: true, previous: offset ? (backwards ? prior.previous.slice(0, -1) : [...(prior?.previous || []), prior?.offset || 0]) : []};
  state.projectPreview = preview;
  renderMain();
  try {
    const result = await postLocal('/api/file/read', request);
    if (state.projectPreview !== preview || state.data.workspaceId !== request.workspaceId) return;
    Object.assign(preview, result, {loading: false});
  } catch (error) {
    if (state.projectPreview !== preview) return;
    Object.assign(preview, {loading: false, error: error.message});
  }
  if (state.file === request.path && state.space !== 'review') renderMain();
}

// 页面显示文本读取状态和分段入口。
function projectSource(file) {
  const preview = state.projectPreview;
  const current = preview?.path === file.path && preview.workspaceId === state.data.workspaceId;
  if (current && preview.loading) return '<p class="intro-banner" role="status">系统正在读取当前文件。</p>';
  if (current && preview.error) return `<p class="intro-banner" role="alert">${esc(preview.error)}</p><button data-action="preview-retry">重新读取首段</button>`;
  if (!file.previewable && !current) {
    state.projectPreview = null;
    // 页面在本轮渲染后读取正文。
    queueMicrotask(() => { if (state.file === file.path && state.space !== 'review' && !state.projectPreview) loadProjectPreview(); });
    return '<p class="intro-banner" role="status">系统正在准备文件正文。</p>';
  }
  const paging = current && file.partial ? `<div class="preview-paging"><span>文本片段 · 字节 ${preview.offset + 1}–${preview.end} / ${preview.size} · 行号从本段起算</span><div><button data-action="preview-previous" ${preview.offset ? '' : 'disabled'}>上一段</button><button data-action="preview-next" ${preview.next === null ? 'disabled' : ''}>下一段</button></div></div><p class="note">大文本采用分段阅读。当前编辑器仅支持不超过 512 KiB 的完整文本。</p>` : '';
  return paging + renderSource(file);
}

// 页面引用当前目录 README 中的首段正文。
function directoryDescription(files, path) {
  const candidates = directoryContents(files, path).files.filter(file => /^readme(?:\.(?:md|markdown|txt|rst))?$/i.test(file.path.split('/').at(-1)));
  const readme = candidates.find(file => file.previewable) || candidates[0];
  if (!readme) return {text: '', source: null, notice: '当前目录没有 README 说明文件。'};
  if (!readme.previewable) return {text: '', source: readme, notice: readme.notice || '目录说明尚未载入文本。'};
  let fenced = false, comment = false;
  const lines = [];
  for (const line of readme.after.split('\n')) {
    if (/^\s*```|^\s*~~~/.test(line)) { fenced = !fenced; lines.push(''); continue; }
    if (line.includes('<!--')) comment = true;
    const skip = fenced || comment || /^\s*(#|<|!\[|\[!\[|\[[^\]]+\]:|[-=]{3,}\s*$)/.test(line) || /^\s*(English|中文|简体中文|繁體中文)\s*\|/i.test(line);
    if (line.includes('-->')) comment = false;
    lines.push(skip ? '' : line);
  }
  const paragraph = lines.join('\n').split(/\n\s*\n/).find(value => value.trim())?.trim() || '';
  return {text: paragraph.slice(0, 600), truncated: paragraph.length > 600, source: readme,
    notice: paragraph ? '' : '该说明文件尚无可引用的正文。'};
}

// 页面将目录职责和直接组成放在同一阅读层。
function renderProjectDirectory() {
  const path = state.projectDirectory || '';
  const files = projectFiles();
  const contents = directoryContents(files, path);
  const description = directoryDescription(files, path);
  const summary = description.text ? `<blockquote>${esc(description.text)}${description.truncated ? '…' : ''}</blockquote>` : `<p class="muted">职责待补充</p><p class="note">${esc(description.notice)}</p>`;
  const source = description.source ? `<button class="description-source" data-file="${esc(description.source.path)}">查看说明来源 · ${esc(description.source.path)} →</button>` : '';
  const rows = contents.directories.map(directory => {
    const description = directoryDescription(files, directory.path);
    return `<button class="directory-entry" data-project-directory="${esc(directory.path)}"><span class="entry-icon">▱</span><span><strong>${esc(directory.name)}/</strong><small>${esc(description.text || '职责待补充')}</small></span><span class="entry-count">${directory.count} 个文件</span><span aria-hidden="true">→</span></button>`;
  });
  const fileRows = contents.files.map(file => `<button class="directory-entry" data-file="${esc(file.path)}"><span class="entry-icon">▤</span><span><strong>${esc(file.path.split('/').at(-1))}</strong><small>${esc(file.descriptionSource === '尚未生成职责说明' ? '职责待补充' : file.description)}</small></span><span class="entry-count">${esc(file.descriptionSource)}</span><span aria-hidden="true">→</span></button>`);
  $('#main').innerHTML = `${projectBreadcrumbs(path)}<div class="directory-heading"><span class="eyebrow">${path ? '目录阅读' : '项目概览'}</span><h1>${esc(path ? path.split('/').at(-1) : state.data.project)}</h1><p class="workspace-path">${esc(path || state.data.root)}</p><p class="directory-counts">当前层级：${contents.directories.length} 个直接子目录 · ${contents.files.length} 个直属文件</p>${state.data.notices.map(note => `<p class="note">${esc(note)}</p>`).join('')}</div><section class="directory-purpose"><h2>${path ? '目录职责' : '项目说明'}</h2>${description.text ? '<p class="note">以下内容引用现有 README 正文。</p>' : ''}${summary}${source}</section><section class="directory-composition"><div class="section-heading"><h2>${path ? '目录组成' : '项目组成'}</h2><span>当前层级</span></div>${rows.join('')}${fileRows.length ? `<details class="directory-files" ${fileRows.length <= 10 ? 'open' : ''}><summary>直属文件 · ${fileRows.length}</summary>${fileRows.join('')}</details>` : ''}${!rows.length && !fileRows.length ? '<p class="note">当前目录没有可见文件。</p>' : ''}</section><p class="note directory-evidence">文件说明来自源码。目录说明随文件快照更新，目录关联待分析。</p>`;
}

// 页面选择目录时保留目录树的展开状态。
function selectProjectDirectory(path) {
  if (state.space !== 'project') return;
  state.projectView = 'files';
  rememberDraft(); rememberEditor();
  state.file = null; state.projectDirectory = path;
  state.projectPreview = null;
  $('#filter').value = '';
  state.previewDefinition = null; state.returnPoint = null;
  state.trail = []; closeContext();
  renderTree(); renderMain(); $('#main').scrollTop = 0;
  $('#tree').scrollTop = 0;
}

// 页面只在用户点击箭头时展开目录。
function toggleProjectDirectory(button) {
  const directory=button.closest('.project-directory');
  if(!directory)return;
  const open=button.getAttribute('aria-expanded')!=='true';
  state.directoryOpen.set(directory.dataset.treeKey,open);
  const scroll=$('#tree').scrollTop;
  renderFileExplorer();
  $('#tree').scrollTop=scroll;
}

// 项目空间分别展示目录说明和文件内容。
function renderProjectSpace() {
  if(state.projectView!=='files')return renderReadingHome();
  const {file}=selection();
  if(!file)return renderEditorWelcome();
  $('#main').innerHTML=`<div class="editor-shell">${editorTabs(file)}<div class="editor-toolbar"><code>${esc(file.path)}</code><div class="toolbar-spacer"></div><span class="muted">只读</span><button data-action="develop-file" ${!file.editable?'disabled':''}>编辑文件</button></div><div class="editor-body">${projectSource(file)}</div>${editorStatus(file)}</div>`;
  if(state.previewDefinition)renderDefinitionPreview();
}

// 开发空间使用完整高度展示文件编辑器。
function renderDevelopmentFile() {
  const {file}=selection();
  if(!file){state.file=null;renderTaskHome();return;}
  state.editing=Boolean(file.editable);
  $('#main').innerHTML=`<div class="editor-shell">${editorTabs(file)}<div class="editor-toolbar"><code>${esc(file.path)}</code><div class="toolbar-spacer"></div><button data-action="development-current">当前需求</button><button data-action="review-current">审阅修改</button></div><div class="editor-body">${file.editable?renderEditor(file):projectSource(file)}</div>${editorStatus(file,file.editable)}</div>`;
  $('#source-editor')?.addEventListener('input',rememberEditor);
}

// 页面在开发空间切换任务对象。
function showDevelopmentPage(page) {
  if (state.space !== 'development') switchSpace('development');
  rememberEditor();
  state.file = null; state.editing = false; state.developmentPage = page;
  renderTree(); renderMain(); $('#main').scrollTop = 0;
}

// 页面打开工作目录的修改集合。
function showCurrentReview() {
  switchSpace('review', {reset: true, current: true});
}
