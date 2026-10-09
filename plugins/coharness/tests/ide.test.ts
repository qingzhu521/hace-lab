import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectFiles, git, MAX_FILE, hash } from '../src/ide/files.ts';
import { Store, type JournalRow } from '../src/ide/store.ts';
import { IdeWorkspace } from '../src/ide/workspace.ts';
import { gitState } from '../src/ide/workflow.ts';
import { symbolsFor } from '../src/ide/symbols.ts';
import { architectureDocument } from '../src/client/architecture-document.ts';

async function fixture(t:any) {
  const root=await mkdtemp(join(tmpdir(),'coharness-plugin-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const files=new ProjectFiles(root,'fixture');await files.initialize();
  await git(root,['config','user.name','CoHarness Test']);await git(root,['config','user.email','coharness@example.invalid']);
  await writeFile(join(root,'calc.ts'),'export function add(a: number, b: number) { return a + b; }\nexport const twice = (n: number) => add(n,n);\n');
  await git(root,['add','.']);await git(root,['commit','-qm','Initial fixture']);
  const rows=new Map<string,JournalRow>();
  const store=new Store('fixture',{entries:()=>rows.entries(),put:async(key,value)=>{rows.set(key,structuredClone(value));}});
  return {root,files,store,ide:new IdeWorkspace(files,store),rows};
}
test('file map, history and alignment bind to the selected versions',async t=>{
  const {root,ide,files}=await fixture(t);
  const clean=await ide.snapshot();assert.equal(clean.git.clean,true);assert.equal(clean.files[0].changes.length,0);
  await writeFile(join(root,'calc.ts'),'export function add(a: number, b: number) { return a - b; }\n');
  const changed=await ide.snapshot();const file=changed.files[0];assert.equal(file.kind,'修改');assert.ok(file.changes.length);
  const input={workspaceId:files.id,path:file.path,version:file.version,basis:changed.basis,change:file.changes[0].id,expectation:'用户得到两个数的差。',status:'已对齐'};
  assert.equal((await ide.dispatch('/api/alignment',input)).verification,'待验证');
  await writeFile(join(root,'calc.ts'),'export const answer=42;\n');
  await assert.rejects(ide.dispatch('/api/alignment',input),/已变化/);
  const detail=await ide.snapshot(clean.head!);assert.equal(detail.files[0].kind,'新增');assert.equal(detail.files[0].editable,false);
  assert.match(detail.files[0].after,/a \+ b/);assert.match(await readFile(join(root,'calc.ts'),'utf8'),/42/);
  assert.equal((await ide.dispatch('/api/history',{workspaceId:files.id})).commits[0].id,clean.head);
});
test('file saves reject stale versions and retain before/after snapshots',async t=>{
  const {root,ide,files,store}=await fixture(t),snap=await ide.snapshot(),file=snap.files[0];
  const saved=await ide.dispatch('/api/file/save',{workspaceId:files.id,path:file.path,version:file.version,content:'export const next=1;\n'});
  assert.equal(store.get(`working:${file.path}:${file.version}`).content,file.after);
  assert.equal(store.get(`working:${file.path}:${saved.version}`).content,'export const next=1;\n');
  await assert.rejects(ide.dispatch('/api/file/save',{workspaceId:files.id,path:file.path,version:file.version,content:'stale'}),/已经变化/);
  assert.equal(await readFile(join(root,file.path),'utf8'),'export const next=1;\n');
});
test('large text uses bounded pages and rejects changed continuations and links',async t=>{
  const {root,files}=await fixture(t);const content='中文内容\n'.repeat(MAX_FILE/4);
  await writeFile(join(root,'large.txt'),content);
  const first=await files.page({path:'large.txt'});assert.equal(first.file.editable,false);assert.ok(first.next);
  const second=await files.page({path:'large.txt',offset:first.next,revision:first.revision});assert.ok(second.offset>0);assert.ok(content.startsWith(first.file.after+second.file.after));
  await writeFile(join(root,'large.txt'),content+'变更');
  await assert.rejects(files.page({path:'large.txt',offset:first.next,revision:first.revision}),/已经变化/);
  await symlink('/etc/passwd',join(root,'link.txt'));await assert.rejects(files.page({path:'link.txt'}),/符号链接/);
  await assert.rejects(files.page({path:'../outside'}),/清单/);
});
test('pause and restore preserve staged, unstaged and untracked content plus stash backup',async t=>{
  const {root,ide,files}=await fixture(t);
  await writeFile(join(root,'calc.ts'),'staged\n');await git(root,['add','calc.ts']);await writeFile(join(root,'calc.ts'),'unstaged\n');await writeFile(join(root,'new.txt'),'new\n');
  const workflow=await ide.dispatch('/api/task/save',{workspaceId:files.id,revision:0,request:'实现计算功能',view:{}});
  const paused=await ide.dispatch('/api/task/pause',{workspaceId:files.id,revision:workflow.revision,gitToken:(await gitState(files)).token,view:{}});
  assert.equal((await gitState(files)).clean,true);assert.equal(paused.active,null);assert.ok(paused.paused[0].stash);
  const restored=await ide.dispatch('/api/task/restore',{workspaceId:files.id,revision:paused.revision,gitToken:(await gitState(files)).token,taskId:paused.paused[0].id});
  assert.equal(restored.workflow.active.request,'实现计算功能');assert.equal(await readFile(join(root,'calc.ts'),'utf8'),'unstaged\n');assert.equal(await readFile(join(root,'new.txt'),'utf8'),'new\n');
  assert.equal((await git(root,['show',':calc.ts'])).stdout.toString(),'staged\n');assert.ok((await ide.workflow.stashes()).includes(paused.paused[0].stash));
  await assert.rejects(ide.workflow.save({workspaceId:files.id,revision:0,request:'old',view:{}}),/已经变化/);
});
test('symbol parsing records caller direction and declared parameter counts',()=>{
  const symbols=symbolsFor('app.ts','function notify(message: string, opts = { a: 1, b: 2 }) { return message; }\nconst loadSnapshot = () => notify("ok");');
  assert.equal(symbols[0].parameterCount,2);assert.equal(symbols[1].parameterCount,0);
  assert.equal(symbols[1].calls[0].target,symbols[0].id);assert.equal(symbols[0].callers[0].target,symbols[1].id);
  const python=symbolsFor('app.py','def helper(x):\n    return x\n\ndef main(a,b=2,*args):\n    return helper(a)\n');
  assert.equal(python[1].parameterCount,3);assert.equal(python[1].calls[0].target,python[0].id);
});
test('journal recovers state and imports legacy SQLite without Python',async t=>{
  const {root,files,store,rows}=await fixture(t);
  const directory=await mkdtemp(join(tmpdir(),'coharness-legacy-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(directory,hash(root).slice(0,20)+'.sqlite3'));
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT); CREATE TABLE events (id INTEGER,time TEXT,kind TEXT,data TEXT)');
  db.prepare('INSERT INTO kv VALUES (?,?)').run('workflow',JSON.stringify({revision:2,active:{request:'原需求',workspaceId:'old'},paused:[]}));db.close();
  await store.importLegacy(directory,root);assert.equal(store.get('workflow').active.workspaceId,files.id);
  const recovered=new Store(files.id,{entries:()=>rows.entries(),put:async()=>{throw new Error('readonly');}});assert.equal(recovered.get('workflow').active.request,'原需求');
  await store.importLegacy(directory,root);assert.equal(store.get('workflow').revision,2);
});
test('architecture isolation policy precedes model markup',()=>{
  const html=architectureDocument('<script>parent.alert(1)</script><img src="https://example.com">');
  assert.ok(html.indexOf('Content-Security-Policy')<html.indexOf('<script>'));assert.match(html,/script-src 'none'/);assert.match(html,/connect-src 'none'/);
});
