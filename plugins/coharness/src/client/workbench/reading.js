'use strict';

// 页面按项目保存阅读路线的位置。
function readingPosition() {
  state.readingPositions ||= new Map();
  if (!state.readingPositions.has(state.data.workspaceId)) state.readingPositions.set(state.data.workspaceId, {scene: null, step: 0, tab: 'expectations'});
  return state.readingPositions.get(state.data.workspaceId);
}

// 页面读取带文件版本依据的路线。
async function loadReadingGuide() {
  const reading = {workspaceId: state.data.workspaceId, loading: true};
  state.reading = reading;
  try {
    const result = await postLocal('/api/reading', {workspaceId: reading.workspaceId});
    if (state.reading !== reading || state.data.workspaceId !== reading.workspaceId) return;
    Object.assign(reading, result, {loading: false});
  } catch (error) {
    if (state.reading !== reading) return;
    Object.assign(reading, {loading: false, error: error.message});
  }
  if (state.space === 'project' && state.projectView !== 'files') { renderTree(); renderMain(); }
}

// 页面读取当前场景和步骤。
function readingSelection() {
  const position = readingPosition();
  const guide = state.reading?.workspaceId === state.data.workspaceId ? state.reading.guide : null;
  const scene = guide?.scenes.find(item => item.id === position.scene);
  const step = scene?.steps[position.step] || scene?.steps[0];
  return {position, guide, scene, step};
}

// 页面切换项目阅读和文件浏览。
function setProjectView(view) {
  if(view !== 'files') { sendHost({type:'overview'}); return; }
  closeReadingEvidence();
  state.projectView = view;
  closeContext();
  renderTree(); renderMain();
  $('#main').scrollTop = 0;
}

// 左栏只展示当前场景的阅读步骤。
function renderReadingNavigation() {
  const {guide, scene, step} = readingSelection();
  $('#map-title').textContent = scene ? '阅读流程' : '项目阅读';
  $('#file-count').textContent = scene ? scene.steps.length : guide?.scenes.length || '—';
  $('#map-description').textContent = scene ? '流程来自静态依据，尚未通过运行核实。' : '用户从使用场景进入模块实现。';
  $('#overview-button span').textContent = '项目首页';
  $('#overview-button').classList.toggle('active', !scene);
  $('#tree').innerHTML = scene ? `<p class="reading-nav-caption">${esc(scene.title)}</p><ol class="reading-steps">${scene.steps.map((item, index) => `<li><button data-reading-step="${index}" class="${item === step ? 'active' : ''}" ${item === step ? 'aria-current="step"' : ''}><span>${index + 1}</span><div><strong>${esc(item.title)}</strong><small>${esc(item.module)}</small></div></button></li>`).join('')}</ol>` : '<div class="reading-nav-intro"><span>01 · 理解用途</span><span>02 · 选择场景</span><span>03 · 逐步阅读</span><p>每项解释都保留依据。运行结论需要实际证据。</p></div>';
}

// 页面用来源按钮打开独立的代码依据面板。
function readingSourceButtons(ids) {
  const {guide} = readingSelection();
  return ids.map(id => {
    const source = guide.sources.find(item => item.id === id);
    if (!source) return '';
    return `<button class="reading-source-link" data-reading-source="${esc(id)}">${esc(source.label || source.path)} <span>${source.status === 'current' ? '↗' : '· 待核对'}</span></button>`;
  }).join('');
}

// 项目首页提供有依据的场景入口。
function renderReadingHome() {
  if (!state.reading || state.reading.workspaceId !== state.data.workspaceId) {
    $('#main').innerHTML = '<p class="loading" role="status">系统正在读取项目路线。</p>';
    loadReadingGuide();
    return;
  }
  const reading = state.reading;
  if (reading.loading) { $('#main').innerHTML = '<p class="loading" role="status">系统正在读取项目路线。</p>'; return; }
  if (reading.error) {
    $('#main').innerHTML = `<p class="intro-banner" role="alert">${esc(reading.error)}</p><button data-reading-action="retry">重新读取路线</button>`;
    return;
  }
  const {guide, scene} = readingSelection();
  if (scene) return renderReadingScene();
  $('#main').innerHTML = `<div class="reading-home"><span class="eyebrow">项目阅读</span><h1>${esc(state.data.project)}</h1>${guide ? `<p class="reading-lead">${esc(guide.description)}</p><div class="reading-provenance">${esc(guide.author)} · ${esc(guide.coverage)}<br>说明来自静态依据。当前尚无运行验证。</div><section class="reading-scenarios"><div class="section-heading"><h2>从一个使用场景开始</h2><span>${guide.scenes.length} 条阅读路线</span></div>${guide.scenes.map((item, index) => `<button class="reading-scene-card" data-reading-scene="${esc(item.id)}"><span class="reading-scene-number">${String(index + 1).padStart(2, '0')}</span><div><span class="reading-status">未运行</span><h3>${esc(item.title)}</h3><p>${esc(item.action)}</p><small>预期结果 · ${esc(item.outcome)}</small><strong class="reading-enter">开始阅读 →</strong></div></button>`).join('')}</section>` : '<div class="reading-empty"><h2>当前项目尚未建立阅读路线</h2><p>路线需要项目用途、使用场景和对应的代码依据。</p><p>模型生成路线尚未接入。用户可以先阅读真实文件。</p></div>'}<button class="reading-files-link" data-reading-action="files">浏览项目文件 →</button></div>`;
}

// 场景页面分别展示预期、证据和实现依据。
function renderReadingScene() {
  const {position, guide, scene, step} = readingSelection();
  const count = scene.steps.reduce((sum, item) => sum + item.expectations.length, 0);
  const sources = [...new Set(step.expectations.flatMap(item => item.sources))];
  const stale = sources.some(id => guide.sources.find(item => item.id === id)?.status !== 'current');
  const tabs = {expectations: '预期行为', evidence: '运行证据', implementation: '实现依据'};
  let content;
  if (position.tab === 'evidence') {
    content = '<div class="reading-empty"><span class="reading-status">未运行</span><h2>当前步骤暂无运行证据</h2><p>实际输入、输出和错误尚未采集。</p><p>系统尚未核实这一步是否实际执行。</p><button data-reading-action="prepare">查看运行准备</button></div>';
  } else if (position.tab === 'implementation') {
    content = `<h2 class="reading-section-title">当前步骤的静态依据</h2><p class="note">这些位置支持阅读解释。实际执行路径仍待运行核实。</p><div class="reading-source-list">${readingSourceButtons(sources)}</div>`;
  } else {
    content = `<div class="reading-io"><div><span>预期输入</span><p>${esc(step.input)}</p></div><span aria-hidden="true">→</span><div><span>预期交付</span><p>${esc(step.output)}</p></div></div><h2 class="reading-section-title">本步骤的预期行为</h2>${step.expectations.map((item, index) => `<article class="reading-expectation"><div><span class="reading-expectation-number">${index + 1}</span><p>${esc(item.text)}</p><span class="reading-status">未验证</span></div><div class="reading-expectation-sources">${readingSourceButtons(item.sources)}</div></article>`).join('')}`;
  }
  $('#main').innerHTML = `<div class="reading-scene"><nav class="breadcrumbs" aria-label="场景阅读路径"><button data-reading-action="home">${esc(state.data.project)}</button><span>/</span><span>${esc(scene.title)}</span></nav><header class="reading-scene-header"><div><span class="eyebrow">场景阅读</span><h1>${esc(scene.title)}</h1><p>${esc(scene.action)}</p><p class="reading-outcome">预期结果 · ${esc(scene.outcome)}</p></div><button data-reading-action="prepare">查看运行准备</button></header><div class="reading-verification"><span class="reading-status">未运行</span><span>运行证据支持 0 项 · 存在差异 0 项 · 尚未验证 ${count} 项</span><span>当前 HEAD · ${esc(state.data.head?.slice(0, 10) || '尚无提交')}</span></div>${stale ? '<p class="reading-stale" role="status">当前步骤的部分依据已经变化或无法读取。解释需要重新核对。</p>' : ''}<section class="reading-step-body"><div class="reading-step-heading"><span class="reading-step-index">${String(scene.steps.indexOf(step) + 1).padStart(2, '0')}</span><div><span class="eyebrow">${esc(step.module)}</span><h2>${esc(step.title)}</h2><p>${esc(step.role)}</p></div></div><nav class="reading-tabs" aria-label="步骤内容">${Object.entries(tabs).map(([id, label]) => `<button data-reading-tab="${id}" aria-pressed="${position.tab === id}">${label}</button>`).join('')}</nav><div class="reading-tab-body">${content}</div></section><footer class="reading-step-footer"><button data-reading-step="${Math.max(0, position.step - 1)}" ${position.step === 0 ? 'disabled' : ''}>← 上一步</button><span>${position.step + 1} / ${scene.steps.length}</span>${position.step + 1 < scene.steps.length ? `<button data-reading-step="${position.step + 1}">下一步 →</button>` : '<button data-reading-action="home">返回项目首页 →</button>'}</footer></div>`;
}

// 面板显示已核对版本的源码片段。
function openReadingEvidence(id) {
  const {guide} = readingSelection();
  const source = guide?.sources.find(item => item.id === id);
  if (!source) return;
  state.readingFocus = document.activeElement;
  const panel = $('#reading-evidence');
  panel.innerHTML = `<header><strong>阅读依据</strong><div><button data-reading-action="zoom-source" aria-label="切换依据全屏">⤢</button><button data-reading-action="close-source" aria-label="关闭阅读依据">×</button></div></header><div class="reading-evidence-heading"><span class="eyebrow">${source.kind === 'document' ? '文档依据' : source.kind === 'test' ? '测试定义 · 尚未运行' : '实现依据 · 静态阅读'}</span><h2>${esc(source.label)}</h2><p>${esc(source.path)} · L${source.start}–${source.end}</p><small>依据版本 ${esc(source.version.slice(0, 12))}</small></div>${source.status === 'current' ? `<div class="reading-code">${source.excerpt.split('\n').map((line, index) => `<div><span>${source.start + index}</span><code>${esc(line)}</code></div>`).join('')}</div>` : `<p class="reading-stale">${esc(source.notice)}</p>`}`;
  panel.classList.remove('hidden');
  const handle = document.createElement('div');
  handle.className = 'reading-resize-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', '调整阅读依据宽度');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.tabIndex = 0;
  panel.prepend(handle);
  const resize = width => {
    const bounded = Math.max(Math.min(330, innerWidth), Math.min(innerWidth, width));
    panel.style.width = `${bounded}px`;
    handle.setAttribute('aria-valuenow', String(Math.round(bounded)));
  };
  handle.setAttribute('aria-valuemin', String(Math.min(330, innerWidth)));
  handle.setAttribute('aria-valuemax', String(innerWidth));
  handle.setAttribute('aria-valuenow', String(Math.round(panel.getBoundingClientRect().width)));
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    resize(panel.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 40 : -40));
  });
  handle.addEventListener('pointerdown', event => {
    const start = event.clientX, width = panel.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    const move = current => resize(width + start - current.clientX);
    const end = () => { handle.removeEventListener('pointermove', move); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end, {once: true});
    handle.addEventListener('pointercancel', end, {once: true});
  });
  panel.querySelector('[data-reading-action="close-source"]').focus();
}

// 页面关闭依据面板，并恢复原入口焦点。
function closeReadingEvidence() {
  $('#reading-evidence')?.classList.add('hidden');
  $('#reading-evidence')?.classList.remove('fullscreen');
  if (state.readingFocus?.isConnected) state.readingFocus.focus({preventScroll: true});
}

// 页面展示运行条件，并明确执行器的接入状态。
function showReadingPreparation() {
  const {scene} = readingSelection();
  if (!scene) return;
  const preparation = scene.preparation;
  $('#reading-preparation').innerHTML = `<div class="dialog-heading"><h2 id="reading-preparation-title">运行准备</h2><button data-reading-action="close-preparation" aria-label="关闭运行准备">×</button></div><p>${esc(scene.title)}</p><label>待核对命令</label><pre>${esc(preparation.command)}</pre><p class="note">工作目录：${esc(state.data.root)}</p><h3>环境要求</h3><ul>${preparation.requirements.map(item => `<li>${esc(item)}</li>`).join('')}</ul><h3>可能产生的影响</h3><ul>${preparation.effects.map(item => `<li>${esc(item)}</li>`).join('')}</ul><p class="reading-stale">场景执行器尚未接入。当前没有运行结果。</p><div class="dialog-footer"><button data-reading-action="close-preparation">返回阅读</button><button disabled>执行器待接入</button></div>`;
  $('#reading-preparation').showModal();
}

// 页面集中处理阅读路线的局部切换。
function handleReadingClick(button) {
  if (!Object.keys(button.dataset).some(key => key.startsWith('reading'))) return false;
  const position = readingPosition();
  if (button.dataset.readingSource) { openReadingEvidence(button.dataset.readingSource); return true; }
  if (button.dataset.readingScene) { position.scene = button.dataset.readingScene; position.step = 0; position.tab = 'expectations'; }
  else if (button.dataset.readingStep !== undefined) {
    const {scene} = readingSelection();
    const index = Number(button.dataset.readingStep);
    if (!scene || !scene.steps[index]) return true;
    position.step = index; position.tab = 'expectations';
  } else if (button.dataset.readingTab) position.tab = button.dataset.readingTab;
  else if (button.dataset.readingAction) {
    const action = button.dataset.readingAction;
    if (action === 'files') { setProjectView('files'); return true; }
    if (action === 'read') { setProjectView('reading'); return true; }
    if (action === 'prepare') { showReadingPreparation(); return true; }
    if (action === 'close-preparation') { $('#reading-preparation').close(); return true; }
    if (action === 'close-source') { closeReadingEvidence(); return true; }
    if (action === 'zoom-source') { $('#reading-evidence').classList.toggle('fullscreen'); return true; }
    if (action === 'retry') { state.reading = null; }
    if (action === 'home') { position.scene = null; position.step = 0; }
  } else return false;
  closeReadingEvidence();
  renderTree(); renderMain(); $('#main').scrollTop = 0;
  return true;
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeReadingEvidence();
});
