'use strict';

// 页面为三个空间分别保留文件标签。
function editorTabs(file) {
  state.openTabs ||= {};
  const key = spaceKey();
  const tabs = state.openTabs[key] ||= [];
  if(file && !tabs.includes(file.path)) tabs.push(file.path);
  return `<nav class="editor-tabs" aria-label="文件标签">${tabs.map(path=>`<div class="editor-tab-wrap ${file?.path===path?'active':''}"><button data-file="${esc(path)}" class="editor-tab ${file?.path===path?'active':''}" title="${esc(path)}"><span class="file-icon">${fileIcon(path)}</span>${esc(path.split('/').at(-1))}<span class="tab-dirty">${state.editorBuffers[`${state.data.workspaceId}:${path}`]?.dirty?'●':''}</span></button><button class="close-tab" data-close-file="${esc(path)}" aria-label="关闭 ${esc(path)}">×</button></div>`).join('') || '<span class="empty-tab">工作区</span>'}</nav>`;
}
function fileIcon(path) {return /\.[jt]sx?$/.test(path)?'{}':path.endsWith('.py')?'py':path.endsWith('.md')?'M↓':'▤';}
function editorStatus(file,editable=false) {
  return `<footer class="editor-status"><span>${esc(state.data.git.branch)} <span class="status-separator">/</span> ${editable?'可编辑':state.data.review?'提交快照 · 只读':'只读'}</span><span id="cursor-status">${esc(file?.label||'文件')}</span><span>UTF-8</span><span>${file?`${file.after.split('\n').length} 行`:''}</span></footer>`;
}
function outlineSelect(file) {
  return `<select id="symbol-picker" aria-label="跳转到符号"><option value="">符号导航</option>${file.symbols.map(s=>`<option value="${esc(s.id)}">${esc(s.name)} · ${s.parameterCount??'?'} 参数</option>`).join('')}</select>`;
}
function reviewTools(file,change,symbol) {
  return `<aside class="review-tools"><header><strong>修改自述</strong><button data-action="toggle-review-tools" aria-label="收起自述面板">›</button></header>${renderChangeExplanation(file,change)}${renderAlignment(file,change)}<details class="tool-section"><summary>文件职责与修改目的</summary><p>${esc(file.description)}</p><p>${esc(file.purpose)}</p></details>${symbol?`<details class="tool-section"><summary>逐步阅读</summary>${renderBehavior(file,change,symbol)}</details>`:''}${renderEvents(file.path)}</aside>`;
}

// 页面为当前修改生成可核对的系统自述。
function explanationContext(file, change) {
  return {record: recordFor(file, change), request: taskRequest(), commit: state.data.review?.subject || '',
    phase: state.data.workflow?.active?.phase || '', review: state.data.review?.id || '',
    rationale: rationaleFor(file, change), annotations: annotationsFor(file, change),
    verification: state.data.verification?.run || null};
}

function renderRationale(explanation) {
  const rationale = explanation.rationale;
  if (!rationale) return '<p class="note">这项修改没有关联的模型方案。自述只说明差异事实。</p>';
  const evidence = (rationale.evidence || []).slice(0, 6).map(item => `<code>${esc(item.path)}:${item.startLine}–${item.endLine}</code>`).join(' ');
  return `<div class="ai-rationale ${rationale.stale ? 'is-stale' : ''}">
    <div class="rationale-head"><h3>AI 修改动机</h3><span class="badge">模型生成</span></div>
    <p>${esc(rationale.reason)}</p>
    <p><span class="explanation-label">预期效果</span>${esc(rationale.expected)}</p>
    ${evidence ? `<div class="rationale-evidence">${evidence}</div>` : ''}
    <small>${esc(rationale.provider)} / ${esc(rationale.model)} · ${new Date(rationale.time).toLocaleString()}${rationale.stale ? ' · 文件已在此后变化' : ''}</small>
  </div>`;
}

function renderAnnotationBox(file, change, explanation) {
  const saved = explanation.annotations || [];
  return `<div class="annotation-box"><h3>我的批注</h3>
    <p class="note">批注绑定当前修改项和文件版本。用户可以把批注加入当前需求。</p>
    <textarea id="annotation-text" maxlength="4000" placeholder="记录你对这项修改的判断、疑问或后续要求。">${esc(annotationDraft(file, change))}</textarea>
    <div class="annotation-actions"><button data-action="save-annotation">保存批注</button><button data-action="annotation-to-requirement">加入需求 →</button></div>
    ${saved.length ? `<div class="annotation-list">${saved.map(item => `<div class="annotation-item"><time>${esc(new Date(item.time).toLocaleString())}</time><p>${esc(item.text)}</p>${item.stale ? '<span class="annotation-stale">文件已变化</span>' : ''}</div>`).join('')}</div>` : ''}
  </div>`;
}

function renderVerificationSummary(verification) {
  if (!verification) return '<p class="note">项目验证尚未运行。对齐状态不等于测试通过。</p>';
  return `<div class="change-verification"><h3>项目验证</h3><p><span class="badge verify-${esc(verification.status)}">${verifyStatus(verification.status)}</span> ${esc(verifyLabel(verification.script))}${verification.stale ? ' · 验证后工作区已变化' : ''}</p><small>${new Date(verification.startedAt).toLocaleString()}${verification.exitCode === null ? '' : ' · 退出码 ' + verification.exitCode}</small><p class="note">验证和对齐是两条独立记录。</p></div>`;
}

// 页面把新增行和删除行放进可展开的小片段。
function explanationExcerpt(title, items, kind, total) {
  if (!items.length) return '';
  return `<details class="explanation-excerpt ${kind}"><summary>${esc(title)} · ${total} 行${total > items.length ? ` · 显示前 ${items.length} 行` : ''}</summary><pre>${items.map(item => `<span class="excerpt-line"><b>${item.line}</b>${esc(item.text) || ' '}</span>`).join('\n')}</pre></details>`;
}

function renderChangeExplanation(file, change) {
  if (!change) return '';
  const explanation = changeExplanation(file, change, explanationContext(file, change));
  const facts = [
    ['改动范围', explanation.range],
    ['修改项', `${explanation.position} / ${explanation.total}`],
    ['涉及函数', explanation.symbol ? `${explanation.symbol.name}（${explanation.symbol.parameters || '无参数'}）` : '文件内容'],
    ['任务阶段', explanation.phase || '尚未建立任务'],
  ];
  return `<section class="change-explanation" aria-label="修改自述">
    <header><div><span class="eyebrow">修改自述</span><h2>${esc(explanation.headline)}</h2></div><span class="badge">${esc(explanation.status)}</span></header>
    <p class="explanation-summary">${esc(explanation.summary)}</p>
    <dl class="explanation-facts">${facts.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
    ${explanationExcerpt('新增行', explanation.added, 'added', explanation.counts.added)}${explanationExcerpt('删除行', explanation.removed, 'removed', explanation.counts.removed)}
    ${explanation.callers.length ? `<details class="explanation-callers"><summary>同文件调用者 · ${explanation.callerCount}${explanation.callerCount > explanation.callers.length ? ` · 显示前 ${explanation.callers.length}` : ''}</summary><ul>${explanation.callers.map(item => `<li><code>L${item.line}</code> ${esc(item.expression)}</li>`).join('')}</ul></details>` : ''}
    ${explanation.calls.length ? `<details class="explanation-callers"><summary>该函数调用的其他函数 · ${explanation.callCount}${explanation.callCount > explanation.calls.length ? ` · 显示前 ${explanation.calls.length}` : ''}</summary><ul>${explanation.calls.map(item => `<li><code>L${item.line}</code> ${esc(item.expression)}</li>`).join('')}</ul></details>` : ''}
    ${renderRationale(explanation)}
    <div class="explanation-intent"><h3>与当前需求的关系</h3>${explanation.commit ? `<p><span class="explanation-label">提交说明</span>${esc(explanation.commit)}</p>` : ''}${explanation.request ? `<p><span class="explanation-label">当前需求</span>${esc(explanation.request)}</p>` : '<p class="muted">当前没有已保存的需求。</p>'}${explanation.expectation ? `<p><span class="explanation-label">用户记录</span>${esc(explanation.expectation)}</p>` : '<p class="muted">用户尚未记录预期效果。</p>'}</div>
    <div class="explanation-next"><h3>继续开发的核对点</h3><ul>${explanation.checkpoints.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>
    <div class="explanation-actions"><button class="primary" data-action="develop-change">在开发空间继续 →</button>${explanation.symbol ? `<button data-symbol="${esc(explanation.symbol.id)}">打开调用上下文</button>` : ''}<button data-action="focus-expectation">记录预期</button></div>
    ${renderAnnotationBox(file, change, explanation)}
    ${renderVerificationSummary(explanation.verification)}
    <p class="note">${esc(explanation.note)}</p>
  </section>`;
}

// 页面挂载代码编辑器，并沿用版本核对与草稿存储。
function mountCodeEditors() {
  window.CoEditor.cleanup();
  const file=state.data?selection().file:null;
  if(!file)return;
  document.querySelectorAll('.code-scroll:not([data-editor-key])').forEach(element=>{
    const lines=[...element.querySelectorAll('.code-line')];
    if(!lines.length)return;
    const doc=lines.map(line=>line.lastElementChild.textContent).join('\n');
    const start=Number(lines[0].dataset.line)||1;
    const marks=Object.fromEntries(lines.filter(line=>line.classList.contains('added')||line.classList.contains('removed')).map(line=>[line.dataset.line,line.classList.contains('added')?'cm-added':'cm-removed']));
    element.replaceChildren();
    window.CoEditor.mount(element,{doc,path:file.path,start,marks,key:`read:${state.data.workspaceId}:${file.path}:${element.id}:${start}`});
  });
  const input=$('#source-editor');
  if(input&&!input.dataset.mounted){
    input.dataset.mounted='true';input.hidden=true;
    const container=document.createElement('div');container.className='live-editor';input.after(container);
    const workspaceId=state.data.workspaceId,path=file.path;
    window.CoEditor.mount(container,{doc:input.value,path,editable:true,key:`edit:${workspaceId}:${path}`,
      onChange(value){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));const tab=document.querySelector('.editor-tab.active .tab-dirty');if(tab)tab.textContent=state.editorBuffers[`${workspaceId}:${path}`]?.dirty?'●':'';},
      onCursor(line,column){const status=$('#cursor-status');if(status)status.textContent=`行 ${line}, 列 ${column}`;}});
  }
  const picker=$('#symbol-picker');
  if(picker&&!picker.dataset.bound){picker.dataset.bound='true';picker.addEventListener('change',()=>{if(picker.value)openContext(picker.value);});}
  const change=$('#change-picker');
  if(change&&!change.dataset.bound){change.dataset.bound='true';change.addEventListener('change',()=>selectChange(Number(change.value)));}
}
let editorMountPending=false;
new MutationObserver(()=>{
  if(editorMountPending)return;editorMountPending=true;
  queueMicrotask(()=>{editorMountPending=false;mountCodeEditors();});
}).observe(document.body,{childList:true,subtree:true});

// 文件树只渲染已展开的目录。
function renderFileExplorer() {
  const query=$('#filter').value.trim().toLowerCase();
  const files=projectFiles().filter(file=>file.kind!=='删除'&&(!query||file.path.toLowerCase().includes(query)));
  const root={children:new Map(),count:0};
  for(const file of files){let node=root;const parts=file.path.split('/');parts.forEach((name,index)=>{node.count++;if(!node.children.has(name))node.children.set(name,{path:parts.slice(0,index+1).join('/'),children:new Map(),count:0});node=node.children.get(name);if(index===parts.length-1)node.file=file;});}
  const render=(node,depth=0)=>[...node.children].sort(([a,x],[b,y])=>Number(!!x.file)-Number(!!y.file)||a.localeCompare(b)).slice(0,200).map(([name,child])=>{
    if(child.file)return `<button class="explorer-file ${state.file===child.path?'active':''}" style="--depth:${depth}" data-file="${esc(child.path)}" title="${esc(child.path)}"><span class="file-icon">${fileIcon(child.path)}</span><span>${esc(name)}</span>${child.file.kind!=='未修改'?`<small class="git-mark">${child.file.kind==='新增'?'A':'M'}</small>`:''}</button>`;
    const key=`${state.data.workspaceId}:explorer:${child.path}`;
    const open=state.directoryOpen.get(key)??Boolean(query||state.file?.startsWith(child.path+'/'));
    return `<div class="project-directory" data-tree-key="${esc(key)}"><button class="explorer-folder directory-toggle" style="--depth:${depth}" data-folder-toggle="${esc(child.path)}" aria-expanded="${open}" aria-label="${open?'收起':'展开'} ${esc(child.path)}"><span>${open?'▾':'▸'}</span><span class="folder-icon">▱</span><span>${esc(name)}</span></button><div class="children ${open?'':'hidden'}">${open?render(child,depth+1):''}</div></div>`;
  }).join('');
  $('#tree').innerHTML=`<div class="explorer-root">${esc(state.data.project)} <small>${files.length}</small></div>${render(root)}${files.length===0?'<p class="note">没有匹配文件。</p>':''}`;
  $('#file-count').textContent=files.length;
}
function renderEditorWelcome() {
  $('#main').innerHTML=`<div class="editor-shell">${editorTabs(null)}<div class="editor-welcome"><div class="welcome-icon">{ }</div><h1>${esc(state.data.project)}</h1><p>用户从文件树打开源码。</p><div class="shortcut-list"><span>搜索文件</span><kbd>/</kbd><span>搜索代码</span><kbd>Ctrl F</kbd><span>保存文件</span><kbd>Ctrl S</kbd></div></div>${editorStatus(null)}</div>`;
}

function closeFileTab(path) {
  rememberEditor(); rememberDraft(); saveEditorDrafts();
  const key=spaceKey(),tabs=state.openTabs[key]||[],index=tabs.indexOf(path);
  state.openTabs[key]=tabs.filter(item=>item!==path);
  if(state.file===path){const next=state.openTabs[key][Math.max(0,index-1)];if(next)return selectFile(next);state.file=null;state.editing=false;}
  renderTree();renderMain();
}
