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
  return `<aside class="review-tools"><header><strong>修改对齐</strong><button data-action="toggle-review-tools" aria-label="收起对齐面板">›</button></header>${renderAlignment(file,change)}<details class="tool-section"><summary>文件职责与修改目的</summary><p>${esc(file.description)}</p><p>${esc(file.purpose)}</p></details>${symbol?`<details class="tool-section"><summary>逐步阅读</summary>${renderBehavior(file,change,symbol)}</details>`:''}${renderEvents(file.path)}</aside>`;
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
