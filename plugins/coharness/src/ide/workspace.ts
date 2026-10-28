import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { ProjectFiles, MAX_FILES, MAX_TOTAL, hash, decode, description, git } from './files.ts';
import { Store } from './store.ts';
import { Workflow, gitState, history, commitInfo } from './workflow.ts';
import { symbolsFor, changesFor } from './symbols.ts';
import type { DevelopmentRunner } from './development.ts';
import type { VerificationRunner } from './verification.ts';

export class IdeWorkspace {
  files: ProjectFiles; store: Store; workflow: Workflow;
  development?: DevelopmentRunner; verification?: VerificationRunner;
  constructor(files: ProjectFiles, store: Store) {this.files=files;this.store=store;this.workflow=new Workflow(files,store);}
  async snapshot(commit?: string) {
    const status=await gitState(this.files), review=commit?await commitInfo(this.files,commit):null;
    const kinds: Record<string,string>=Object.fromEntries(status.changes.map(c=>[c.path,c.kind]));
    let head=status.head,paths: string[],entries=await this.files.tree(head), historical: Map<string,any>|undefined;
    if(review) {
      head=review.id;
      const old=await this.files.tree(review.parent),next=await this.files.tree(review.id);
      paths=[...new Set([...old.keys(),...next.keys()])].filter(path=>JSON.stringify(old.get(path))!==JSON.stringify(next.get(path))).sort();
      historical=new Map();let remaining=MAX_TOTAL;
      for(const path of paths.slice(0,MAX_FILES)) {
        const before=old.get(path),after=next.get(path);
        const row:any={path,before:'',after:'',exists:!!after,baseExists:!!before,editable:false,previewable:false,notice:'',version:hash(JSON.stringify([before,after])),size:after?.size??0,consumed:0};
        kinds[path]=!before?'新增':!after?'删除':'修改';
        try {
          if((before?.size??0)+(after?.size??0)>remaining) throw new Error('该文件超出本次预载范围。');
          row.before=decode(await this.files.blob(before));row.after=decode(await this.files.blob(after));row.previewable=true;
          remaining-=Buffer.byteLength(row.before)+Buffer.byteLength(row.after);
        } catch(error:any) {row.notice=error.message;}
        historical.set(path,row);
      }
    } else {
      const inventory=await this.files.inventory(Object.keys(kinds));paths=inventory.paths;entries=inventory.entries;head=inventory.head;
    }
    const files:any[]=[],symbols:any[]=[],notices:string[]=[],maps=this.store.get('maps')??{};
    let remaining=MAX_TOTAL,mapChanged=false;
    if(paths.length>MAX_FILES) notices.push(`目录包含 ${paths.length} 个文件。系统预载 ${MAX_FILES} 个文件，其余正文按需读取。`);
    for(const path of paths.slice(0,MAX_FILES)) {
      const file=historical?historical.get(path):await this.files.file(path,entries.get(path),remaining);
      remaining-=file.consumed;delete file.consumed;file.kind=kinds[path]??'未修改';
      if(file.kind==='未修改'&&file.previewable) file.before=file.after;
      Object.assign(file,description(path,file.after),{purpose:'修改目的待共同说明。',symbols:file.previewable?symbolsFor(path,file.after):[]});
      Object.assign(file,file.previewable?changesFor(file.before,file.after,file.symbols,file.kind!=='未修改'):{changes:[],addedLines:[],removedLines:[]});
      if(file.diffUnavailable) {file.previewable=false;file.notice='该文件的差异计算超时。用户可在项目空间阅读正文。';}
      files.push(file);symbols.push(...file.symbols);
      if(!review&&maps[path]?.version!==file.version) {maps[path]={path,version:file.version,previousVersion:maps[path]?.version??null,description:file.description};mapChanged=true;}
    }
    if(mapChanged) await this.store.put('maps',maps,'系统更新文件地图');
    const directories:Record<string,string>={},counts:Record<string,{count:number;changed:number}>={};
    for(const path of paths) {const parts=path.split('/');for(let i=0;i<parts.length;i++){const key=parts.slice(0,i).join('/');counts[key]??={count:0,changed:0};counts[key]!.count++;if(kinds[path]) counts[key]!.changed++;}}
    for(const [key,count]of Object.entries(counts)) directories[key]=`包含 ${count.count} 个文件，其中 ${count.changed} 个存在变化。目录职责待生成。`;
    const basis=hash(JSON.stringify([this.files.id,head,review?.parent??status.token,files.map(f=>[f.path,f.version,f.kind])]));
    const values=this.store.values(),fileByPath=new Map(files.map(file=>[file.path,file]));
    const rationales=Object.entries(values).filter(([key])=>key.startsWith('rationale:')).map(([,value])=>value)
      .sort((left,right)=>String(right.time).localeCompare(String(left.time))).slice(0,100)
      .map(value=>({...value,stale:fileByPath.get(value.path)?.version!==value.postVersion}));
    const annotations=Object.entries(values).filter(([key])=>key.startsWith('annotation:')).map(([,value])=>value)
      .sort((left,right)=>String(right.time).localeCompare(String(left.time))).slice(0,100)
      .map(value=>({...value,stale:fileByPath.get(value.path)?.version!==value.version}));
    const verification=this.verification?await this.verification.state():{scripts:[],run:null};
    const verificationRun=verification.run?{...verification.run,output:String(verification.run.output||'').slice(-24_000),stale:verification.run.status!=='running'&&(verification.run.token!==status.token||verification.run.head!==status.head)}:null;
    return {files,index:paths.map(path=>({path,kind:kinds[path]??'未修改'})),directories,symbols,basis,
      records:Object.fromEntries(Object.entries(values).filter(([key,value])=>key.startsWith('alignment:')&&(value.commit??null)===(commit??null))),events:this.store.events(),
      rationales,annotations,development:this.development?.state()??null,verification:{scripts:verification.scripts,run:verificationRun},
      baseline:review?review.parent?.slice(0,12)??'空目录':head?'Git HEAD':'尚无已对齐提交',head,review,
      project:basename(this.files.root),root:this.files.root,workspaceId:this.files.id,gitRoot:this.files.gitRoot,notices,git:status,workflow:this.workflow.state(),token:'dsh-rpc'};
  }
  async alignment(payload:any) {
    if(typeof payload.expectation!=='string'||!payload.expectation.trim()||payload.expectation.length>12000) throw new Error('请输入预期修改效果。');
    if(!['讨论中','已对齐'].includes(payload.status)) throw new Error('系统不支持该对齐状态。');
    const current=await this.snapshot(payload.commit),file=current.files.find(f=>f.path===payload.path);
    if(!file||file.version!==payload.version||current.basis!==payload.basis) throw new Error('源文件已变化。请刷新修改地图后继续对齐。');
    if(!file.changes.some((c:any)=>c.id===payload.change)) throw new Error('系统未找到目标修改项。');
    const value={workspaceId:this.files.id,path:file.path,version:file.version,basis:current.basis,change:payload.change,commit:payload.commit??null,expectation:payload.expectation.trim(),status:payload.status,time:new Date().toISOString(),verification:'待验证',author:'用户'};
    await this.store.put(`alignment:${file.path}:${current.basis}:${payload.change}`,value,payload.status==='已对齐'?'用户确认预期':'用户提交预期');
    return value;
  }
  async annotation(payload:any) {
    const text=typeof payload.text==='string'?payload.text.trim():'';
    if(!text||text.length>4000) throw new Error('批注内容不能为空，且不能超过 4000 字符。');
    if(typeof payload.path!=='string'||!payload.path) throw new Error('批注缺少目标文件。');
    await this.files.readForEdit(payload.path);
    const value={id:randomUUID(),workspaceId:this.files.id,path:payload.path,change:typeof payload.change==='string'?payload.change:null,
      version:typeof payload.version==='string'?payload.version:'',basis:typeof payload.basis==='string'?payload.basis:'',
      rationaleId:typeof payload.rationaleId==='string'?payload.rationaleId:null,text,author:'用户',time:new Date().toISOString()};
    await this.store.put(`annotation:${value.id}`,value,'用户保存修改批注');
    return value;
  }
  async commit(payload:any) {
    const message=typeof payload.message==='string'?payload.message.trim():'';
    if(!message||message.length>200||message.includes('\0')) throw new Error('提交说明不能为空，且不能超过 200 字符。');
    const status=await gitState(this.files);
    if(status.clean) throw new Error('当前工作区没有可提交的修改。');
    if(status.conflicted) throw new Error('目录存在冲突。请先处理冲突。');
    const add=await git(this.files.root,['add','-A','--','.'],false);
    if(add.code) throw new Error(add.stderr.toString().trim()||'Git 未能暂存修改。');
    const result=await git(this.files.root,['commit','-m',message],false);
    if(result.code) throw new Error(result.stderr.toString().trim()||result.stdout.toString().trim()||'Git 未能创建提交。');
    const head=(await git(this.files.root,['rev-parse','HEAD'])).stdout.toString().trim();
    const subject=(await git(this.files.root,['show','-s','--format=%s',head])).stdout.toString().trim();
    const value={id:randomUUID(),commit:head,subject,message,time:new Date().toISOString(),files:status.changes.map(change=>change.path)};
    await this.store.put(`commit:${head}`,value,'用户创建提交');
    return value;
  }
  async dispatch(route: string,payload:any) {
    if(payload.workspaceId!==this.files.id) throw new Error('工作区已经切换。');
    switch(route) {
      case '/api/snapshot':return this.snapshot();
      case '/api/file/read':return this.files.page(payload);
      case '/api/file/save':return this.files.save(payload,(...args)=>this.store.put(...args));
      case '/api/history':return history(this.files,payload.skip);
      case '/api/history/detail':return this.snapshot(payload.commit);
      case '/api/task/save':return this.workflow.save(payload);
      case '/api/task/pause':return this.workflow.pause(payload);
      case '/api/task/restore':return this.workflow.restore(payload);
      case '/api/alignment':return this.alignment(payload);
      case '/api/dev/state':if(!this.development)throw new Error('开发服务尚未准备。');return this.development.state();
      case '/api/dev/start':if(!this.development)throw new Error('开发服务尚未准备。');return this.development.start(payload.requirement);
      case '/api/dev/cancel':if(!this.development)throw new Error('开发服务尚未准备。');this.development.cancel(payload.runId);return this.development.state();
      case '/api/dev/apply':if(!this.development)throw new Error('开发服务尚未准备。');return this.development.apply(payload.proposalId);
      case '/api/dev/discard':if(!this.development)throw new Error('开发服务尚未准备。');return this.development.discard(payload.proposalId);
      case '/api/verify/state':if(!this.verification)throw new Error('验证服务尚未准备。');return this.verification.state();
      case '/api/verify/start':if(!this.verification)throw new Error('验证服务尚未准备。');return this.verification.start(payload.script);
      case '/api/verify/cancel':if(!this.verification)throw new Error('验证服务尚未准备。');this.verification.cancel(payload.runId);return this.verification.state();
      case '/api/git/commit':return this.commit(payload);
      case '/api/annotation':return this.annotation(payload);
      default:throw new Error('系统不支持该操作。');
    }
  }
}
