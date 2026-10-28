'use strict';

// 页面读取最近一次开发方案和验证状态。
function developmentState() { return state.data?.development || null; }
function verificationSnapshot() { return state.data?.verification || {scripts: [], run: null}; }
function developmentHostReady() { return Boolean(state.data && Object.prototype.hasOwnProperty.call(state.data, 'development') && Object.prototype.hasOwnProperty.call(state.data, 'verification')); }
function hostRestartPanel() {
  return `<section class="agent-panel" aria-label="模型修改方案"><div class="section-heading"><h2>模型修改方案</h2><span class="badge">等待宿主更新</span></div><p class="error-box" role="status">当前页面已经加载新界面，但宿主仍运行旧插件。请重启 dsh web 后再使用模型修改、验证和提交。源码和审阅仍可继续使用。</p></section>`;
}
function verifyLabel(name) { return ({test: '运行测试', typecheck: '类型检查', build: '构建插件'})[name] || name; }
function verifyStatus(status) {
  return ({running: '运行中', passed: '通过', failed: '失败', cancelled: '已取消', timeout: '超时', error: '错误'})[status] || status;
}
function runStatus(status) {
  return ({running: '生成中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断'})[status] || status;
}
function activityLabel(activity) {
  if (!activity) return '模型正在准备。';
  if (activity.startsWith('read:')) return '模型读取 ' + activity.slice(5);
  if (activity.startsWith('list:')) return '模型查看 ' + activity.slice(5);
  if (activity.startsWith('search:')) return '模型搜索 ' + activity.slice(7);
  if (activity === 'model') return '模型正在整理修改方案。';
  return activity;
}
function refreshDevelopmentHome() {
  if (state.space === 'development' && !state.file) renderTaskHome();
}
function evidenceText(edit) {
  const items = (edit.evidence || []).slice(0, 6);
  return items.length ? items.map(item => `<code>${esc(item.path)}:${item.startLine}–${item.endLine}</code>`).join(' ') : '<span class="muted">依据待补充</span>';
}

// 页面展示模型修改方案入口和当前运行状态。
function renderAgentPanel() {
  if (!developmentHostReady()) return hostRestartPanel();
  const development = developmentState();
  const run = development?.run;
  const proposal = development?.proposal;
  const busy = run?.status === 'running';
  const request = taskRequest().trim();
  const failed = run && run.status !== 'running' && run.status !== 'completed';
  return `<section class="agent-panel" aria-label="模型修改方案">
    <div class="section-heading"><h2>模型修改方案</h2><span class="badge">用户确认后写入</span></div>
    <p class="note">模型读取相关文件并说明每处修改动机。系统不会自动写入文件。</p>
    ${busy ? `<div class="agent-run" role="status"><div class="agent-run-head"><span class="agent-pulse" aria-hidden="true"></span><strong>模型正在生成修改方案</strong><span>请求 ${run.step} 次</span><button data-action="dev-cancel" data-run-id="${esc(run.id)}">停止</button></div><p>${esc(activityLabel(run.activity))}</p></div>` : ''}
    ${failed ? `<div class="agent-error" role="alert"><strong>${esc(run.error === 'timeout' ? '模型生成超时。' : run.error === 'cancelled' ? '用户停止了生成。' : '模型没有完成修改方案。')}</strong><button data-action="dev-start">重新生成</button></div>` : ''}
    ${proposal ? renderProposal(proposal) : ''}
    ${!busy && !proposal ? `<div class="agent-start"><button class="primary" data-action="dev-start" ${request && !state.developmentStarting ? '' : 'disabled'}>${state.developmentStarting ? '系统正在提交需求' : '生成修改方案'}</button><span>${request ? '系统会调用 dsh 默认模型。' : '请先填写需求。'}</span></div>` : ''}
    ${!busy && proposal && proposal.status !== 'proposed' ? `<div class="agent-start"><button data-action="dev-start" ${request ? '' : 'disabled'}>生成新的方案</button><span>旧方案保留在操作记录中。</span></div>` : ''}
  </section>`;
}

function renderProposalEdit(edit) {
  const find = String(edit.find || '');
  const replace = String(edit.replace || '');
  return `<article class="proposal-edit">
    <header><code>${esc(edit.path)}</code><span class="badge">${edit.create ? '新建' : '替换'}</span></header>
    <p><span class="explanation-label">动机</span>${esc(edit.reason)}</p>
    <p><span class="explanation-label">预期</span>${esc(edit.expected)}</p>
    <details class="proposal-code"><summary>查看替换内容</summary>${find ? `<div><span>查找</span><pre>${esc(find)}</pre></div>` : ''}<div><span>写入</span><pre>${esc(replace)}</pre></div></details>
    <footer class="proposal-evidence">${evidenceText(edit)}</footer>
  </article>`;
}

function renderProposal(proposal) {
  const applied = proposal.status === 'applied';
  return `<div class="proposal">
    <div class="proposal-head"><div><span class="eyebrow">${applied ? '已应用' : proposal.status === 'discarded' ? '已丢弃' : '待确认'}</span><h3>${esc(proposal.summary)}</h3></div><span class="badge">${proposal.edits.length} 处修改</span></div>
    <p class="note">模型：${esc(proposal.provider)} / ${esc(proposal.model)} · ${new Date(proposal.createdAt).toLocaleString()}</p>
    <div class="proposal-edits">${proposal.edits.map(renderProposalEdit).join('')}</div>
    <div class="proposal-actions">
      ${proposal.status === 'proposed' ? `<button class="primary" data-action="dev-apply" data-proposal-id="${esc(proposal.id)}" ${state.proposalApplying ? 'disabled' : ''}>${state.proposalApplying ? '系统正在写入' : '应用方案并写入文件'}</button><button data-action="dev-discard" data-proposal-id="${esc(proposal.id)}">丢弃方案</button>` : ''}
      ${applied ? '<button class="primary" data-action="review-current">进入审阅修改 →</button>' : ''}
    </div>
    <p class="note">应用会写入文件并记录模型动机。应用不会创建 Git 提交。</p>
  </div>`;
}

// 页面启动模型开发循环，并轮询运行状态。
async function startDevelopment() {
  if (!state.data || state.developmentStarting) return;
  const request = taskRequest().trim();
  if (!request) return notify('请先填写需求。');
  if (!await saveCurrentTask()) return;
  state.developmentStarting = true;
  refreshDevelopmentHome();
  try {
    const result = await postLocal('/api/dev/start', {workspaceId: state.data.workspaceId, requirement: request});
    if (!state.data) return;
    state.data.development = result;
    refreshDevelopmentHome();
    pollDevelopment();
  } catch (error) {
    notify(error.message);
    refreshDevelopmentHome();
  } finally {
    state.developmentStarting = false;
    refreshDevelopmentHome();
  }
}

function pollDevelopment() {
  clearTimeout(state.developmentTimer);
  const workspaceId = state.data?.workspaceId;
  if (!workspaceId) return;
  const tick = async () => {
    state.developmentTimer = null;
    try {
      const result = await postLocal('/api/dev/state', {workspaceId});
      if (!state.data || state.data.workspaceId !== workspaceId) return;
      state.data.development = result;
      refreshDevelopmentHome();
      if (result.run?.status === 'running') state.developmentTimer = setTimeout(tick, 1400);
      else if (result.run?.status === 'completed') notify('模型修改方案已生成。');
    } catch (error) { notify(error.message); }
  };
  state.developmentTimer = setTimeout(tick, 600);
}

async function cancelDevelopment(runId) {
  try {
    const result = await postLocal('/api/dev/cancel', {workspaceId: state.data.workspaceId, runId});
    state.data.development = result;
    refreshDevelopmentHome();
    pollDevelopment();
  } catch (error) { notify(error.message); }
}

async function applyDevelopment(proposalId) {
  if (!proposalId || state.proposalApplying) return;
  state.proposalApplying = true;
  refreshDevelopmentHome();
  try {
    const result = await postLocal('/api/dev/apply', {workspaceId: state.data.workspaceId, proposalId});
    state.data.development = {...developmentState(), proposal: result.proposal};
    await loadSnapshot();
    notify('系统已应用修改方案。请进入审阅空间核对差异。');
    refreshDevelopmentHome();
  } catch (error) {
    notify(error.message);
    refreshDevelopmentHome();
  } finally {
    state.proposalApplying = false;
    refreshDevelopmentHome();
  }
}

async function discardDevelopment(proposalId) {
  if (!proposalId) return;
  try {
    const result = await postLocal('/api/dev/discard', {workspaceId: state.data.workspaceId, proposalId});
    state.data.development = result;
    refreshDevelopmentHome();
    notify('系统已丢弃修改方案。代码没有变化。');
  } catch (error) { notify(error.message); }
}

// 页面展示可运行的插件验证脚本和最近一次结果。
function renderVerificationPanel() {
  if (!developmentHostReady()) return '';
  const verification = verificationSnapshot();
  const run = verification.run;
  const running = run?.status === 'running';
  const changed = state.data.git.changes.length;
  return `<section class="verify-panel" aria-label="运行验证与提交">
    <div class="section-heading"><h2>运行验证与提交</h2><span class="badge">独立于对齐状态</span></div>
    <p class="note">系统只运行 CoHarness 插件 package.json 中声明的 test、typecheck 和 build。对齐状态不代表测试通过。</p>
    <div class="verify-actions">${verification.scripts.length ? verification.scripts.map(script => `<button data-verify-script="${esc(script.name)}" ${running ? 'disabled' : ''}>${verifyLabel(script.name)}</button>`).join('') : '<span class="muted">当前工作区没有可运行的 CoHarness 插件脚本。</span>'}</div>
    ${run ? `<div class="verify-run"><div class="verify-run-head"><span class="badge verify-${esc(run.status)}">${verifyStatus(run.status)}</span><code>${esc(run.command)}</code><span>${run.durationMs ?? '—'} ms</span>${running ? `<button data-action="verify-cancel" data-run-id="${esc(run.id)}">停止</button>` : ''}</div>${run.stale ? '<p class="warning">验证后工作区已经变化。本次结果不再对应当前文件。</p>' : ''}<p class="note">${esc(run.cwd)}</p><details class="verify-output"><summary>查看输出 · ${run.exitCode === null ? '尚无退出码' : '退出码 ' + run.exitCode}</summary><pre>${esc(String(run.output || '').slice(-24000))}</pre></details>${run.reload === 'client' ? '<p class="note build-note">客户端产物已重建。页面可能自动重载；宿主改动仍需重启 dsh web。</p>' : ''}</div>` : '<p class="muted">尚未运行验证。</p>'}
    <div class="commit-box"><label for="commit-message">提交说明</label><div><input id="commit-message" maxlength="200" placeholder="说明这次提交的目的。"><button data-action="git-commit" ${!changed ? 'disabled' : ''}>创建提交</button></div><span>系统会暂存当前工作区的 ${changed} 个变动文件。提交不会自动运行验证。</span></div>
  </section>`;
}

async function startVerification(script) {
  if (!script) return;
  try {
    const result = await postLocal('/api/verify/start', {workspaceId: state.data.workspaceId, script});
    state.data.verification = result;
    refreshDevelopmentHome();
    pollVerification();
  } catch (error) { notify(error.message); }
}

async function cancelVerification(runId) {
  try {
    const result = await postLocal('/api/verify/cancel', {workspaceId: state.data.workspaceId, runId});
    state.data.verification = result;
    refreshDevelopmentHome();
    pollVerification();
  } catch (error) { notify(error.message); }
}

function pollVerification() {
  clearTimeout(state.verificationTimer);
  const workspaceId = state.data?.workspaceId;
  if (!workspaceId) return;
  const tick = async () => {
    state.verificationTimer = null;
    try {
      const result = await postLocal('/api/verify/state', {workspaceId});
      if (!state.data || state.data.workspaceId !== workspaceId) return;
      state.data.verification = result;
      refreshDevelopmentHome();
      if (result.run?.status === 'running') state.verificationTimer = setTimeout(tick, 1500);
      else notify(result.run?.status === 'passed' ? '验证通过。' : result.run?.status === 'failed' ? '验证失败。请查看输出。' : '验证结束。');
    } catch (error) { notify(error.message); }
  };
  state.verificationTimer = setTimeout(tick, 700);
}

async function commitChanges() {
  const message = String($('#commit-message')?.value || '').trim();
  if (!message) return notify('请先填写提交说明。');
  const changed = state.data.git.changes.length;
  if (!changed) return notify('当前工作区没有可提交的修改。');
  if (!window.confirm(`系统将提交当前工作区的 ${changed} 个变动文件。`)) return;
  try {
    const result = await postLocal('/api/git/commit', {workspaceId: state.data.workspaceId, message});
    notify(`系统已创建提交 ${result.commit.slice(0, 10)}。`);
    await loadSnapshot();
    refreshDevelopmentHome();
  } catch (error) { notify(error.message); }
}

// 页面保存用户对模型修改动机的批注。
function annotationKey(file, change) { return `${state.data.workspaceId}:${file.path}:${file.version}:${change.id}`; }
function annotationDraft(file, change) {
  state.annotationDrafts ||= {};
  return state.annotationDrafts[annotationKey(file, change)] || '';
}
function rememberAnnotationDraft(file, change, value) {
  state.annotationDrafts ||= {};
  state.annotationDrafts[annotationKey(file, change)] = value;
}
function rationaleFor(file, change) {
  const records = state.data.rationales || [];
  const start = Math.min(change?.start > 0 ? change.start : 1, change?.oldStart > 0 ? change.oldStart : 1);
  const end = Math.max(change?.end || 0, change?.oldEnd || 0);
  return records.filter(record => record.path === file.path && record.start <= end && record.end >= start)
    .sort((left, right) => String(right.time).localeCompare(String(left.time)))[0] || null;
}
function annotationsFor(file, change) {
  return (state.data.annotations || []).filter(item => item.path === file.path && (!item.change || item.change === change?.id));
}

async function saveAnnotation() {
  const {file, change} = selection();
  const input = $('#annotation-text');
  const text = String(input?.value || '').trim();
  if (!file || !change) return notify('当前没有可批注的修改项。');
  if (!text) return notify('请先输入批注。');
  const rationale = rationaleFor(file, change);
  try {
    const value = await postLocal('/api/annotation', {workspaceId: state.data.workspaceId, path: file.path,
      change: change.id, version: file.version, basis: state.data.basis, rationaleId: rationale?.id || null, text});
    state.data.annotations = [value, ...(state.data.annotations || [])];
    state.annotationDrafts[annotationKey(file, change)] = '';
    renderMain();
    notify('系统已保存批注。用户可以把批注加入需求。');
  } catch (error) { notify(error.message); }
}

async function annotationToRequirement() {
  const {file, change} = selection();
  if (!file || !change) return notify('当前没有可加入需求的修改项。');
  const text = String($('#annotation-text')?.value || '').trim() || annotationsFor(file, change)[0]?.text || '';
  if (!text) return notify('请先输入批注，或保存一条批注。');
  const request = [String(taskRequest() || '').trim(), `来自审阅批注：${text}`].filter(Boolean).join('\n\n');
  try {
    const workflow = await postLocal('/api/task/save', {workspaceId: state.data.workspaceId,
      revision: state.data.workflow.revision, request, view: {}});
    state.data.workflow = workflow;
    if (state.liveData) state.liveData.workflow = workflow;
    try { coStorage.setItem(workflowKey(), JSON.stringify({taskId: workflow.active.id, request, view: {}})); } catch {}
    state.annotationDrafts[annotationKey(file, change)] = '';
    switchSpace('development');
    state.file = null; state.editing = false; state.developmentPage = 'current';
    renderTree(); renderMain(); $('#main').scrollTop = 0;
    notify('系统已把批注加入当前需求。');
  } catch (error) { notify(error.message); }
}
