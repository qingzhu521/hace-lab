import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, realpath, open, rename, unlink, chmod } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename, extname, sep } from 'node:path';

const execute = promisify(execFile);
export const MAX_FILE = 512 * 1024, MAX_TOTAL = 8 * 1024 * 1024, MAX_FILES = 1000, PAGE = 128 * 1024;
export const EXCLUDED = new Set(['.git', '.coharness', '.codex', '.agents', 'node_modules', '__pycache__', '.venv', 'venv']);
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const version = (value: Buffer, exists = true) => hash(Buffer.concat([Buffer.from(exists ? 'file\0' : 'missing\0'), value]));
export const eligible = (path: string) => !path.split('/').some(part => EXCLUDED.has(part));
export async function git(root: string, args: string[], check = true) {
  try {
    const result = await execute('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args],
      { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 20_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: any) {
    if (check) throw new Error(error.stderr?.toString().trim() || 'Git 未能完成操作。');
    return { stdout: Buffer.from(error.stdout ?? ''), stderr: Buffer.from(error.stderr ?? ''), code: 1 };
  }
}
export async function safePath(root: string, path: unknown): Promise<string> {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => part === '..' || EXCLUDED.has(part))) throw new Error('文件路径超出工作区范围。');
  let current = root;
  for (const part of path.split('/').filter(Boolean)) {
    current = resolve(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('系统不跟随符号链接。'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  const rel = relative(root, current);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('文件路径超出工作区范围。');
  return current;
}
export function decode(data: Buffer): string {
  if (data.length > MAX_FILE) throw new Error('文件超过 512 KiB，用户可在项目空间分段读取。');
  if (data.includes(0)) throw new Error('该文件包含二进制内容。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new Error('该文件使用非 UTF-8 编码。'); }
}
export function description(path: string, source: string) {
  const label = ({ '.py': 'Python', '.js': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.html': 'HTML', '.md': 'Markdown' } as Record<string,string>)[extname(path)] ?? (extname(path).slice(1).toUpperCase() || '文本');
  const first = source.trimStart().split('\n')[0] ?? '';
  const comment = /^(\/\/|# |\/\*|"""|'''|<!--)/.test(first) ? first.replace(/^[\/#*"'<>!\s-]+|[\/#*"'<>!\s-]+$/g, '').slice(0,220) : '';
  return { label, description: comment || '职责说明待生成。你可以直接阅读实际文件内容。', descriptionSource: comment ? '文件首部说明' : '尚未生成职责说明' };
}
export interface TreeEntry { oid: string; size: number; mode: string; type: string }
export class ProjectFiles {
  root: string; gitRoot = ''; prefix = ''; id: string;
  blobs = new Map<string, Buffer>();
  constructor(root: string, id: string) { this.root = root; this.id = id; }
  async initialize() {
    this.root = await realpath(this.root);
    let result = await git(this.root, ['rev-parse', '--show-toplevel'], false);
    if (result.code) { await git(this.root, ['init', '--quiet']); result = await git(this.root, ['rev-parse', '--show-toplevel']); }
    this.gitRoot = await realpath(result.stdout.toString().trim());
    const prefix = relative(this.gitRoot, this.root).split(sep).join('/'); this.prefix = prefix ? `${prefix}/` : '';
  }
  async head() { const result = await git(this.root, ['rev-parse', '--verify', 'HEAD'], false); return result.code ? null : result.stdout.toString().trim(); }
  async tree(oid: string | null): Promise<Map<string, TreeEntry>> {
    const result = new Map<string, TreeEntry>(); if (!oid) return result;
    const raw = await git(this.gitRoot, ['ls-tree', '-r', '-z', '-l', oid, ...(this.prefix ? ['--', this.prefix] : [])]);
    for (const row of raw.stdout.toString().split('\0').filter(Boolean)) {
      const split = row.indexOf('\t'); const [mode, type, blob, size] = row.slice(0, split).trim().split(/\s+/);
      const path = row.slice(split + 1).slice(this.prefix.length);
      if (eligible(path)) result.set(path, { oid: blob!, size: Number(size) || 0, mode: mode!, type: type! });
    }
    return result;
  }
  async inventory(priority: string[] = []) {
    const head = await this.head(); const entries = await this.tree(head);
    const names = (await git(this.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'])).stdout.toString().split('\0').filter(Boolean);
    const preferred = new Set(priority);
    const paths = [...new Set([...entries.keys(), ...names])].filter(eligible).sort((a,b) => Number(preferred.has(b)) - Number(preferred.has(a)) || a.localeCompare(b));
    return { head, entries, paths };
  }
  async blob(entry?: TreeEntry): Promise<Buffer> {
    if (!entry) return Buffer.alloc(0);
    if (entry.type !== 'blob' || entry.mode === '120000') throw new Error('链接或子模块需要专门的查看器。');
    if (entry.size > MAX_FILE) throw new Error('文件超过 512 KiB，用户可在项目空间分段读取。');
    if (!this.blobs.has(entry.oid)) this.blobs.set(entry.oid, (await git(this.gitRoot, ['cat-file', 'blob', entry.oid])).stdout);
    return this.blobs.get(entry.oid)!;
  }
  async current(path: string, limit = MAX_FILE): Promise<{ data: Buffer; exists: boolean; mode: number }> {
    const target = await safePath(this.root, path);
    let file;
    try { file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error: any) { if (error.code === 'ENOENT') return { data: Buffer.alloc(0), exists: false, mode: 0 }; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('该项目项不是普通文件。');
      if (stat.size > limit) throw new Error('文件超过读取范围。用户可在项目空间分段读取。');
      const buffer = Buffer.alloc(limit + 1); let size = 0;
      while (size < buffer.length) { const read = await file.read(buffer, size, buffer.length-size, size); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > limit) throw new Error('读取期间文件变大。请重新读取。');
      return { data: buffer.subarray(0,size), exists: true, mode: stat.mode };
    } finally { await file.close(); }
  }
  async file(path: string, entry?: TreeEntry, remaining = MAX_TOTAL): Promise<any> {
    try {
      const current = await this.current(path);
      if (current.data.length + (entry?.size ?? 0) > remaining) throw new Error('该文件尚未预载。用户可在项目空间打开正文。');
      const before = await this.blob(entry); const after = current.data;
      return { path, before: decode(before), after: decode(after), exists: current.exists, baseExists: !!entry,
        editable: current.exists, previewable: true, notice: '', version: version(after,current.exists), size: after.length, consumed: before.length + after.length };
    } catch (error: any) { return { path, before: '', after: '', exists: false, baseExists: !!entry, editable: false, previewable: false,
      notice: error.message, version: hash(error.message), size: 0, consumed: 0 }; }
  }
  async page(payload: any) {
    const { path, offset = 0 } = payload;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('文本位置无效。');
    if (!(await this.inventory([path])).paths.includes(path)) throw new Error('该文件已移出工作区清单。');
    const file = await open(await safePath(this.root,path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile()) throw new Error('该项目项不是普通文件。');
      const stamp = (info: typeof stat) => hash([info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':'));
      const revision = stamp(stat); const size = Number(stat.size);
      if (offset && payload.revision !== revision) throw new Error('文件已经变化。请重新读取首段。');
      if (offset > size) throw new Error('文本位置超出文件范围。');
      const buffer = Buffer.alloc(size > MAX_FILE ? PAGE : MAX_FILE);
      const read = await file.read(buffer,0,buffer.length,offset); let data = buffer.subarray(0,read.bytesRead);
      if (data.includes(0)) throw new Error('该文件包含二进制内容。');
      let text = ''; let decoded = false;
      for (let trim = 0; trim <= (offset + data.length < size ? 3 : 0); trim++) {
        try { text = new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,data.length-trim)); data = data.subarray(0,data.length-trim); decoded = true; break; } catch {}
      }
      if (!decoded) throw new Error('该文件使用非 UTF-8 编码。');
      if (stamp(await file.stat({bigint:true})) !== revision) throw new Error('读取期间文件发生变化。请重新读取首段。');
      const end = offset + data.length; const complete = offset === 0 && end === size;
      return { workspaceId: this.id, revision, offset, next: end < size ? end : null, end, size,
        file: { path, after: text, before: '', exists: true, previewable: true, editable: complete, version: complete ? version(data) : revision,
          ...description(path, offset ? '' : text), symbols: [], changes: [], notice: '', partial: !complete } };
    } finally { await file.close(); }
  }
  async save(payload: any, record: (key: string, value: any, kind: string) => Promise<void>) {
    if (typeof payload.content !== 'string' || Buffer.byteLength(payload.content) > MAX_FILE) throw new Error('编辑器仅支持不超过 512 KiB 的 UTF-8 文本。');
    if (!(await this.inventory([payload.path])).paths.includes(payload.path)) throw new Error('该文件已移出工作区清单。');
    const current = await this.current(payload.path); decode(current.data);
    if (!current.exists || version(current.data) !== payload.version) throw new Error('磁盘文件已经变化。编辑草稿已保留。');
    const target = await safePath(this.root,payload.path); const temporary = resolve(dirname(target), `.coharness-edit-${randomUUID()}`);
    await record(`working:${payload.path}:${payload.version}`, { path: payload.path, version: payload.version, content: current.data.toString(), workspaceId: this.id }, '编辑前快照保存');
    try {
      const output = await open(temporary,'wx',current.mode & 0o777);
      try { await output.writeFile(payload.content); await output.sync(); } finally { await output.close(); }
      await chmod(temporary,current.mode & 0o777);
      const latest = await this.current(payload.path);
      if (!latest.exists || !latest.data.equals(current.data)) throw new Error('保存期间磁盘文件发生变化。请重新读取后合并。');
      await safePath(this.root,payload.path); await rename(temporary,target);
    } finally { await unlink(temporary).catch(() => {}); }
    const value = { workspaceId: this.id, path: payload.path, version: version(Buffer.from(payload.content)), previousVersion: payload.version, content: payload.content };
    await record(`working:${payload.path}:${value.version}`,value,'用户保存工作快照');
    return { version: value.version, path: payload.path };
  }
}
