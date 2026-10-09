import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hash } from './files.ts';

export interface JournalRow { workspace: string; sequence: number; key: string; time: string; kind: string; data: any }
export interface Journal { entries(): IterableIterator<[string,JournalRow]>; put(key: string,value: JournalRow): Promise<void> }
// 每条持久化记录同时保存状态和操作。系统按序号恢复状态。
export class Store {
  id: string; journal: Journal;
  constructor(id: string, journal: Journal) { this.id=id; this.journal=journal; }
  rows() { return [...this.journal.entries()].map(([id,row])=>({id,...row})).filter(row=>row.workspace===this.id).sort((a,b)=>a.sequence-b.sequence); }
  values(): Record<string,any> {
    const values: Record<string,any> = {};
    for (const row of this.rows()) {
      if(row.key === 'legacy:import') Object.assign(values,structuredClone(row.data.values));
      values[row.key] = structuredClone(row.data);
    }
    return values;
  }
  get(key: string): any { return this.values()[key]; }
  async put(key: string,data: any,kind: string) {
    const rows=this.rows();
    await this.journal.put(randomUUID(),{workspace:this.id,sequence:(rows.at(-1)?.sequence??0)+1,key,time:new Date().toISOString(),kind,data:structuredClone(data)});
  }
  events() {
    const summary = (data: any) => Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !['content','view','values','events'].includes(key)));
    return this.rows().flatMap(row => {
      if(row.key === 'legacy:import') {
        const old = (row.data.events ?? []).map((event: any) => {
          let data = {}; try { data = JSON.parse(event.data); } catch {}
          return {id:`legacy-${event.id}`,time:event.time,kind:event.kind,data:summary(data)};
        });
        return [...old,{id:row.id,time:row.time,kind:row.kind,data:{source:row.data.source}}];
      }
      return [{id:row.id,time:row.time,kind:row.kind,data:row.key==='maps'?{files:Object.keys(row.data).length}:summary(row.data)}];
    }).slice(-150).reverse();
  }
  async importLegacy(directory: string | undefined, root: string) {
    if(!directory || this.rows().length) return;
    const file=resolve(directory,hash(root).slice(0,20)+'.sqlite3');
    if(!existsSync(file)) return;
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(file,{readOnly:true});
    try {
      const rows=db.prepare('SELECT key,value FROM kv').all();
      const events=db.prepare('SELECT id,time,kind,data FROM events ORDER BY id').all();
      const replaceId = (value: any): any => {
        if(Array.isArray(value)) return value.map(replaceId);
        if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,key==='workspaceId'?this.id:replaceId(v)]));
        return value;
      };
      // 系统用一条持久化记录导入全部旧状态，避免导入中断留下半份数据。
      const values = Object.fromEntries(rows.map(row => [String(row.key),replaceId(JSON.parse(String(row.value)))]));
      await this.put('legacy:import',{source:file,values,events},'系统导入旧版状态与操作记录');
    } finally { db.close(); }
  }
}
