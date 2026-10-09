import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import template from './workbench/index.html?workbench';
import css from './panel.module.css';
export type Space = 'project' | 'development' | 'review';
export interface IdeActions { ide(workspaceId:string,route:string,data:unknown,signal:AbortSignal):Promise<unknown> }
export function Workbench({workspaceId,space,visible,revision,ide,onSpace,onOverview}:{workspaceId:string;space:Space;visible:boolean;revision:number;onSpace:(space:Space)=>void;onOverview:()=>void}&IdeActions):ReactNode {
  const frame=useRef<HTMLIFrameElement>(null),latest=useRef({space,visible,revision,onSpace,onOverview});
  latest.current={space,visible,revision,onSpace,onOverview};
  const channel=useMemo(()=>crypto.randomUUID(),[workspaceId]);
  const storageKey=`coharness.plugin:${workspaceId}`;
  const document=useMemo(()=>{
    let storage={};try{storage=JSON.parse(localStorage.getItem(storageKey)||'{}');}catch{}
    return template.replace('__COHARNESS_BRIDGE_CONFIG__',()=>JSON.stringify({channel,storage}).replace(/</g,'\\u003c'));
  },[channel,storageKey]);
  useEffect(()=>{
    const controller=new AbortController();
    const send=(value:unknown)=>frame.current?.contentWindow?.postMessage(value,'*');
    const listener=(event:MessageEvent)=>{
      const message=event.data;
      if(event.source!==frame.current?.contentWindow||message?.channel!==channel)return;
      if(message.type==='ready')send({type:'command',channel,space:latest.current.space,visible:latest.current.visible});
      if(message.type==='space'&&['project','development','review'].includes(message.space))latest.current.onSpace(message.space);
      if(message.type==='overview')latest.current.onOverview();
      if(message.type==='storage'&&typeof message.key==='string'&&message.key.startsWith('coharness.')&&(message.value===null||typeof message.value==='string'&&message.value.length<2*1024*1024)) {
        try{const storage=JSON.parse(localStorage.getItem(storageKey)||'{}');if(message.value===null)delete storage[message.key];else storage[message.key]=message.value;localStorage.setItem(storageKey,JSON.stringify(storage));}
        catch{send({type:'storage-error',channel});}
      }
      if(message.type==='request'&&Number.isSafeInteger(message.id)&&typeof message.route==='string') {
        void ide(workspaceId,message.route,message.data,controller.signal).then(value=>send({type:'response',channel,id:message.id,ok:true,value}),error=>send({type:'response',channel,id:message.id,ok:false,value:{error:error.message}}));
      }
    };
    window.addEventListener('message',listener);
    return()=>{controller.abort();window.removeEventListener('message',listener);};
  },[channel,workspaceId,storageKey,ide]);
  useEffect(()=>{frame.current?.contentWindow?.postMessage({type:'command',channel,space,visible,refresh:true},'*');},[channel,space,visible,revision]);
  return <iframe ref={frame} srcDoc={document} sandbox="allow-scripts allow-modals" title="CoHarness 工作台" className={css.workbench} hidden={!visible}/>;
}
