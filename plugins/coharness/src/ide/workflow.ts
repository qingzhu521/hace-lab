import { randomUUID } from 'node:crypto';
import { lstat, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git, hash, ProjectFiles } from './files.ts';
import { Store } from './store.ts';

export async function gitState(files: ProjectFiles) {
  const head=await files.head();
  const branch=(await git(files.root,['symbolic-ref','--short','-q','HEAD'],false)).stdout.toString().trim();
  const raw=await git(files.gitRoot,['status','--porcelain=v1','-z','--untracked-files=all','--no-renames','--',files.prefix||'.']);
  const changes=[],stamps=[];
  for(const row of raw.stdout.toString().split('\0').filter(Boolean)) {
    const status=row.slice(0,2), name=row.slice(3), path=name.slice(files.prefix.length);
    const kind=/U/.test(status)||['AA','DD'].includes(status)?'冲突':status==='??'||status.includes('A')?'新增':status.includes('D')?'删除':'修改';
    changes.push({path,status,kind});
    try {const stat=await lstat(resolve(files.gitRoot,name),{bigint:true});stamps.push([name,String(stat.size),String(stat.mtimeNs),String(stat.ctimeNs)]);}
    catch {stamps.push([name,null]);}
  }
  const index=changes.length?(await git(files.gitRoot,['diff','--cached','--raw','--no-abbrev','--',files.prefix||'.'])).stdout.toString():'';
  return {head,branch:branch||'分离 HEAD',changes,clean:changes.length===0,conflicted:changes.some(c=>c.kind==='冲突'),token:hash(JSON.stringify([head,branch,changes,stamps,index])),canStash:files.root===files.gitRoot&&!!head};
}
export class Workflow {
  files: ProjectFiles; store: Store;
  constructor(files: ProjectFiles,store: Store){this.files=files;this.store=store;}
  state(): any {return this.store.get('workflow')??{revision:0,active:null,paused:[]};}
  checked(payload: any) {
    const state=this.state();
    if(payload.workspaceId!==this.files.id) throw new Error('工作区已经切换。');
    if(payload.revision!==state.revision) throw new Error('任务状态已经变化。请刷新页面后重试。');
    return state;
  }
  view(value: any) {if(!value||Array.isArray(value)||typeof value!=='object'||Buffer.byteLength(JSON.stringify(value))>180000) throw new Error('任务阅读状态超过保存范围。');return value;}
  async persist(state: any,kind: string) {state.revision++;await this.store.put('workflow',state,kind);return state;}
  async save(payload: any) {
    const state=this.checked(payload),request=payload.request??'';
    if(typeof request!=='string'||request.length>12000) throw new Error('需求内容超过保存范围。');
    if(!state.active&&!request.trim()) throw new Error('请先输入你希望实现的功能。');
    state.active??={id:randomUUID(),created:new Date().toISOString(),phase:'需求讨论'};
    Object.assign(state.active,{request,view:this.view(payload.view??{}),updated:new Date().toISOString()});
    return this.persist(state,'用户保存任务');
  }
  async stashes(){return (await git(this.files.gitRoot,['stash','list','--format=%H'])).stdout.toString().trim().split('\n').filter(Boolean);}
  async pause(payload: any) {
    const state=this.checked(payload),status=await gitState(this.files);
    if(payload.gitToken!==status.token) throw new Error('目录内容已经变化。请刷新后重新暂存。');
    if(status.conflicted) throw new Error('目录存在冲突。请先处理冲突。');
    if(!status.clean&&!status.canStash) throw new Error('代码暂存需要打开已有提交的仓库根目录。');
    if(['暂存处理中','暂存待处理','恢复处理中','恢复待处理'].includes(state.active?.phase)) throw new Error('上次任务操作尚未完成。请先检查任务记录和 Git 暂存。');
    if(!status.clean) for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply']) {
      const path=(await git(this.files.gitRoot,['rev-parse','--git-path',name])).stdout.toString().trim();
      const exists=await access(resolve(this.files.gitRoot,path)).then(()=>true,()=>false);
      if(exists) throw new Error('Git 正在合并或变基。请先完成该操作。');
    }
    const task=state.active??{id:randomUUID(),request:'审阅已有修改',phase:'修改审阅',created:new Date().toISOString()};
    Object.assign(task,{view:this.view(payload.view??task.view??{}),baseHead:status.head,stash:null,phaseBeforePause:task.phase});
    if(!status.clean) {
      task.phase='暂存处理中';task.stashMessage=`coharness-task:${task.id}:${randomUUID()}`;state.active=task;
      await this.persist(state,'任务开始暂存');
      const before=new Set(await this.stashes());
      const result=await git(this.files.gitRoot,['stash','push','--include-untracked','--message',task.stashMessage],false);
      const matches=[];
      for(const oid of await this.stashes()) if(!before.has(oid)&&(await git(this.files.gitRoot,['show','-s','--format=%s',oid])).stdout.toString().includes(task.stashMessage)) matches.push(oid);
      task.stash=matches.length===1?matches[0]:null;
      if(result.code||!task.stash||!(await gitState(this.files)).clean) {
        task.phase='暂存待处理';task.error='暂存未完整完成。系统保留任务和 Git 暂存，请检查工作区。';
        await this.persist(state,'任务暂存未完成');throw new Error(task.error);
      }
    }
    task.phase='已暂存';task.pausedAt=new Date().toISOString();state.paused.unshift(task);state.active=null;
    return this.persist(state,'用户暂存任务');
  }
  async restore(payload: any) {
    const state=this.checked(payload);
    if(state.active) throw new Error('请先暂存当前任务，再恢复其他任务。');
    const task=state.paused.find((t:any)=>t.id===payload.taskId);
    if(!task) throw new Error('系统未找到该暂存任务。');
    const status=await gitState(this.files);
    if(payload.gitToken!==status.token||!status.clean) throw new Error('恢复任务需要干净且未发生变化的工作区。');
    if(task.stash&&(this.files.root!==this.files.gitRoot||!(await this.stashes()).includes(task.stash))) throw new Error('对应的 Git 暂存无法恢复。系统保留任务记录。');
    state.paused=state.paused.filter((t:any)=>t.id!==task.id);state.active=task;task.phase='恢复处理中';
    await this.persist(state,'任务开始恢复');
    if(task.stash&&(await git(this.files.gitRoot,['stash','apply','--index',task.stash],false)).code) {
      task.phase='恢复待处理';task.error='Git 未能完整恢复修改。请检查冲突。暂存备份仍然保留。';
      await this.persist(state,'任务恢复未完成');return {workflow:state,warning:task.error};
    }
    task.phase=task.phaseBeforePause??'需求讨论';delete task.phaseBeforePause;delete task.error;task.restoredAt=new Date().toISOString();
    await this.persist(state,'用户恢复任务');return {workflow:state,warning:''};
  }
}
export async function history(files: ProjectFiles,skip=0) {
  if(!Number.isInteger(skip)||skip<0||skip>100000) throw new Error('提交历史页码无效。');
  if(!await files.head()) return {commits:[],next:null};
  const fields=(await git(files.gitRoot,['log','-31',`--skip=${skip}`,'--format=%H%x00%P%x00%an%x00%aI%x00%s%x00',...(files.prefix?['--',files.prefix]:[])])).stdout.toString().split('\0');
  const commits=[];for(let i=0;i+4<fields.length;i+=5) commits.push({id:fields[i]!.trim(),parents:fields[i+1]!.split(' ').filter(Boolean),author:fields[i+2],date:fields[i+3],subject:fields[i+4]});
  return {commits:commits.slice(0,30),next:commits.length>30?skip+30:null};
}
export async function commitInfo(files: ProjectFiles,oid: unknown) {
  if(typeof oid!=='string'||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error('提交编号无效。');
  if((await git(files.gitRoot,['cat-file','-t',oid])).stdout.toString().trim()!=='commit') throw new Error('该编号不是 Git 提交。');
  const fields=(await git(files.gitRoot,['show','-s','--format=%P%x00%s',oid])).stdout.toString().trim().split('\0');
  const parents=fields[0]!.split(' ').filter(Boolean);
  return {id:oid,parent:parents[0]??null,merge:parents.length>1,subject:fields[1]??''};
}
