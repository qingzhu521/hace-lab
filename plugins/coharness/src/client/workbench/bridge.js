'use strict';
const bridgeConfig = __COHARNESS_BRIDGE_CONFIG__;
const pendingRequests = new Map();
let bridgeCounter = 0;
let hostVisible = true;
let bridgeReady = false;
const sendHost = value => parent.postMessage({...value,channel:bridgeConfig.channel}, '*');
const coStorage = {
  getItem: key => bridgeConfig.storage[key] ?? null,
  setItem(key,value) {bridgeConfig.storage[key]=String(value);sendHost({type:'storage',key,value:String(value)});},
  removeItem(key) {delete bridgeConfig.storage[key];sendHost({type:'storage',key,value:null});},
};
window.fetch = (route,options={}) => new Promise((resolve,reject)=>{
  const id=++bridgeCounter;
  const timeout=setTimeout(()=>{pendingRequests.delete(id);reject(new Error('插件请求超时。请刷新状态后核对结果。'));},90000);
  pendingRequests.set(id,{resolve,reject,timeout});
  sendHost({type:'request',id,route,data:options.body?JSON.parse(options.body):{}});
});
window.addEventListener('message',event=>{
  const message=event.data;
  if(event.source!==parent||message?.channel!==bridgeConfig.channel) return;
  if(message.type==='response') {
    const pending=pendingRequests.get(message.id);if(!pending)return;
    clearTimeout(pending.timeout);pendingRequests.delete(message.id);
    pending.resolve(new Response(JSON.stringify(message.value),{status:message.ok?200:409,headers:{'Content-Type':'application/json'}}));
  }
  if(message.type==='command') {
    hostVisible=message.visible;
    if(!state.data)return;
    if(message.space==='project') state.projectView='files';
    switchSpace(message.space);
    if(message.refresh) loadSnapshot();
  }
});
// 页面将未保存草稿交给宿主保留。
function saveEditorDrafts() {
  if(!state.data)return;
  rememberEditor();
  const drafts=Object.fromEntries(Object.entries(state.editorBuffers).filter(([,buffer])=>buffer.dirty));
  const encoded=JSON.stringify(drafts);
  if(encoded!==coStorage.getItem('coharness.editorDrafts')) coStorage.setItem('coharness.editorDrafts',encoded);
}
