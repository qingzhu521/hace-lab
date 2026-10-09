import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Source } from './schema.ts';

export const LIMITS = { fileBytes: 512 * 1024, excerptBytes: 16 * 1024, totalBytes: 96 * 1024,
  reads: 16, entries: 80, lines: 120, steps: 16, durationMs: 180_000 };
const ignored = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', '__pycache__']);
function allowed(part: string): boolean {
  return !part.startsWith('.') && !ignored.has(part)
    && !/^(?:id_rsa|id_ed25519|credentials(?:\..*)?|secrets?(?:\..*)?)$|\.(?:pem|key|p12|pfx)$/i.test(part);
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export class ProjectReader {
  readonly sources: Source[] = [];
  private bytes = 0;
  readonly root: string;
  private constructor(root: string) { this.root = root; }
  static async create(root: string): Promise<ProjectReader> { return new ProjectReader(await realpath(root)); }

  private async locate(path: string): Promise<string> {
    if (isAbsolute(path) || path.includes('\\') || path.includes('\0')) throw new Error('Use a relative project path.');
    const parts = path.split('/').filter(part => part && part !== '.');
    if (parts.some(part => part === '..' || !allowed(part))) throw new Error('This path is outside the reading scope.');
    let current = this.root;
    for (const part of parts) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are outside the reading scope.');
    }
    const canonical = await realpath(current);
    if (!within(this.root, canonical)) throw new Error('This path is outside the project.');
    return canonical;
  }

  async list(path = '.', offset = 0, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!Number.isInteger(offset) || offset < 0 || offset > 2000) throw new Error('Use an offset between 0 and 2000.');
    const directory = await opendir(await this.locate(path));
    const entries: { name: string; kind: 'directory' | 'file' }[] = [];
    let seen = 0;
    let more = false;
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (!allowed(entry.name) || entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      if (seen++ < offset) continue;
      if (entries.length === LIMITS.entries) { more = true; break; }
      entries.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
    }
    return { path, entries, nextOffset: more ? offset + entries.length : null,
      omitted: 'Hidden files, symbolic links, dependency directories, build outputs, and common credential files are excluded.' };
  }

  private async content(path: string, signal?: AbortSignal): Promise<Buffer> {
    const target = await this.locate(path);
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > LIMITS.fileBytes) throw new Error('This file exceeds the 512 KiB reading limit or is not regular.');
      // The bounded buffer also limits reads when a file grows after stat.
      const buffer = Buffer.alloc(LIMITS.fileBytes + 1);
      let count = 0;
      while (count < buffer.length) {
        signal?.throwIfAborted();
        const result = await file.read(buffer, count, buffer.length - count, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (count > LIMITS.fileBytes) throw new Error('This file exceeds the 512 KiB reading limit.');
      if (await realpath(target) !== target) throw new Error('The file path changed during reading.');
      return buffer.subarray(0, count);
    } finally { await file.close(); }
  }

  async read(path: string, startLine = 1, signal?: AbortSignal): Promise<Source> {
    signal?.throwIfAborted();
    if (!Number.isInteger(startLine) || startLine < 1) throw new Error('startLine must be a positive integer.');
    if (this.sources.length >= LIMITS.reads) throw new Error('The reading budget is exhausted. Submit the overview with remaining unknowns.');
    const buffer = await this.content(path, signal);
    if (buffer.includes(0)) throw new Error('Binary files are outside the reading scope.');
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(buffer).split('\n');
    if (startLine > lines.length) throw new Error(`This file has ${lines.length} lines.`);
    const chosen: string[] = [];
    let size = 0;
    for (const line of lines.slice(startLine - 1, startLine - 1 + LIMITS.lines)) {
      const next = Buffer.byteLength(line) + 1;
      if (size + next > LIMITS.excerptBytes) break;
      chosen.push(line); size += next;
    }
    if (!chosen.length) throw new Error('This line exceeds the excerpt limit. Choose another file.');
    if (this.bytes + size > LIMITS.totalBytes) throw new Error('The total excerpt budget is exhausted. Submit the overview.');
    this.bytes += size;
    const source: Source = { id: `source-${this.sources.length + 1}`, path: relative(this.root, resolve(this.root, path)).split(sep).join('/'),
      hash: createHash('sha256').update(buffer).digest('hex'), startLine,
      endLine: startLine + chosen.length - 1, excerpt: chosen.join('\n') };
    this.sources.push(source);
    return source;
  }

  async stalePaths(sources: Source[], signal?: AbortSignal): Promise<string[]> {
    const stale: string[] = [];
    for (const path of new Set(sources.map(source => source.path))) {
      try {
        const hash = createHash('sha256').update(await this.content(path, signal)).digest('hex');
        if (sources.some(source => source.path === path && source.hash !== hash)) stale.push(path);
      } catch (error) { signal?.throwIfAborted(); stale.push(path); }
    }
    return stale;
  }
}
