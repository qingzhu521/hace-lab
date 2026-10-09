import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types';
import { defineDomain,domainTable } from '@deepseek-ai/dsh-storage-domain';
import { ProjectFiles } from './files.ts';
import { Store } from './store.ts';
import { IdeWorkspace } from './workspace.ts';

export const ideDomain=defineDomain({name:'coharness_ide',version:1,tables:{journal:domainTable(z.object({workspace:z.string(),sequence:z.number().int(),key:z.string(),time:z.string(),kind:z.string(),data:z.any()}))}});
export async function createIdeService(ctx: Context) {
  const domain=await ctx.storageDomain.open(ideDomain), workspaces=new Map<string,Promise<IdeWorkspace>>(),locks=new Map<string,Promise<unknown>>();
  let closed=false;
  ctx.effect(()=>async()=>{closed=true;await Promise.allSettled([...locks.values()]);await domain.close();});
  return async (payload: any) => {
    if(closed) throw new Error('服务正在关闭。');
    if(!payload||typeof payload.workspaceId!=='string'||typeof payload.route!=='string'||JSON.stringify(payload).length>4*1024*1024) throw new Error('请求格式无效。');
    const selected=ctx.workspaceRegistry.get(payload.workspaceId as WorkspaceId);
    if(!selected) throw new Error('系统未找到工作区。');
    const key=`${selected.id}:${selected.path}`;
    if(!workspaces.has(key)) workspaces.set(key,(async()=>{
      const files=new ProjectFiles(selected.path,selected.id);await files.initialize();
      const store=new Store(selected.id,domain.table('journal'));
      await store.importLegacy(process.env.COHARNESS_LEGACY_STATE_DIR,files.root);
      return new IdeWorkspace(files,store);
    })().catch(error=>{workspaces.delete(key);throw error;}));
    const workspace=await workspaces.get(key)!;
    // 系统按仓库串行执行操作，避免暂存影响另一个目录的保存。
    const previous=locks.get(workspace.files.gitRoot)??Promise.resolve();
    const job=previous.catch(()=>{}).then(()=>workspace.dispatch(payload.route,{...(payload.data??{}),workspaceId:selected.id}));
    locks.set(workspace.files.gitRoot,job);
    return job;
  };
}
