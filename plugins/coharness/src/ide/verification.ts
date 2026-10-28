import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectFiles } from './files.ts';
import type { Store } from './store.ts';
import { gitState } from './workflow.ts';

const SCRIPTS = ['test', 'typecheck', 'build'] as const;
const MAX_OUTPUT = 100_000;
const TIMEOUT = 180_000;

type ScriptName = typeof SCRIPTS[number];

interface ScriptRow { name: ScriptName; script: string; command: string; cwd: string }
interface VerifyRun {
  id: string; workspaceId: string; script: ScriptName; command: string; cwd: string;
  startedAt: string; status: 'running' | 'passed' | 'failed' | 'cancelled' | 'timeout' | 'error';
  exitCode: number | null; durationMs: number | null; output: string; truncated: boolean;
  head: string | null; token: string | null; reload: 'client' | null;
}
interface Job { run: VerifyRun; child?: ChildProcess; cancelled: boolean; timedOut?: boolean; finished?: boolean; timer?: ReturnType<typeof setTimeout> }

async function packageScripts(root: string): Promise<ScriptRow[]> {
  const candidates = [...new Set([root, join(root, 'plugins/coharness')])];
  for (const cwd of candidates) {
    if (!existsSync(join(cwd, 'package.json'))) continue;
    let value: any;
    try { value = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')); } catch { continue; }
    if (value?.name !== 'coharness-dsh') continue;
    return SCRIPTS.filter(name => typeof value.scripts?.[name] === 'string').map(name => ({
      name, script: value.scripts[name], command: `pnpm run ${name}`, cwd,
    }));
  }
  return [];
}

export class VerificationRunner {
  private files: ProjectFiles; private store: Store;
  private jobs = new Map<string, Job>();
  constructor(files: ProjectFiles, store: Store) { this.files=files; this.store=store; }

  private latest(): VerifyRun | null {
    const id = this.store.get('verify:latest')?.runId;
    if (!id) return null;
    return this.store.get(`verify:run:${id}`) ?? null;
  }

  async state(): Promise<{ scripts: ScriptRow[]; run: VerifyRun | null }> {
    const scripts = await packageScripts(this.files.root);
    let run = this.latest();
    const active = this.jobs.get(this.files.id);
    if (run?.status === 'running' && !active) {
      run = { ...run, status: 'error', exitCode: null, output: run.output + '\n宿主重启中断了本次验证。' };
    }
    return { scripts, run: active?.run ?? run };
  }

  async start(script: unknown): Promise<{ scripts: ScriptRow[]; run: VerifyRun }> {
    if (typeof script !== 'string' || !SCRIPTS.includes(script as ScriptName)) throw new Error('系统不支持该验证脚本。');
    if (this.jobs.get(this.files.id)?.run.status === 'running') throw new Error('当前已有验证正在运行。');
    const scripts = await packageScripts(this.files.root);
    const selected = scripts.find(item => item.name === script);
    if (!selected) throw new Error('当前工作区没有 CoHarness 插件脚本。请打开仓库根目录或插件目录。');
    let head: string | null = null;
    let token: string | null = null;
    try { const status = await gitState(this.files); head = status.head; token = status.token; } catch {}
    const run: VerifyRun = {
      id: randomUUID(), workspaceId: this.files.id, script: selected.name, command: selected.command,
      cwd: selected.cwd, startedAt: new Date().toISOString(), status: 'running',
      exitCode: null, durationMs: null, output: '', truncated: false, head, token, reload: null,
    };
    const job: Job = { run, cancelled: false };
    this.jobs.set(this.files.id, job);
    await this.store.put(`verify:run:${run.id}`, run, `开始${selected.name}验证`);
    await this.store.put('verify:latest', { runId: run.id }, '记录最近验证');
    const started = Date.now();
    let child: ChildProcess;
    try {
      child = spawn('pnpm', ['run', selected.name], {
        cwd: selected.cwd, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      run.status = 'error';
      run.output = `无法启动命令：${error instanceof Error ? error.message : '未知错误'}`;
      run.durationMs = Date.now() - started;
      this.jobs.delete(this.files.id);
      await this.store.put(`verify:run:${run.id}`, run, `完成${run.script}验证`);
      return { scripts, run };
    }
    job.child = child;
    job.timer = setTimeout(() => {
      if (job.run.status !== 'running') return;
      job.cancelled = true;
      job.timedOut = true;
      child.kill('SIGTERM');
    }, TIMEOUT);
    const append = (chunk: Buffer) => {
      if (run.status !== 'running') return;
      const text = chunk.toString();
      if (Buffer.byteLength(run.output) + Buffer.byteLength(text) > MAX_OUTPUT) {
        run.output = (run.output + text).slice(0, MAX_OUTPUT) + '\n[输出已截断]';
        run.truncated = true;
        return;
      }
      run.output += text;
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const finish = async (code: number | null) => {
      if (job.finished) return;
      job.finished = true;
      if (job.timer) clearTimeout(job.timer);
      if (job.cancelled) run.status = job.timedOut ? 'timeout' : 'cancelled';
      else if (run.status === 'running') run.status = code === 0 ? 'passed' : 'failed';
      run.exitCode = code;
      run.durationMs = Date.now() - started;
      run.reload = run.status === 'passed' && run.script === 'build' ? 'client' : null;
      this.jobs.delete(this.files.id);
      try { await this.store.put(`verify:run:${run.id}`, run, `完成${run.script}验证`); } catch {}
    };
    child.once('error', error => {
      run.status = 'error';
      run.output += `\n无法启动命令：${error.message}`;
      void finish(null);
    });
    child.once('close', code => { void finish(code); });
    return { scripts, run };
  }

  cancel(id: unknown): void {
    const job = this.jobs.get(this.files.id);
    if (!job || job.run.id !== id || job.run.status !== 'running') return;
    job.cancelled = true;
    job.child?.kill('SIGTERM');
  }

  dispose(): void {
    for (const job of this.jobs.values()) {
      job.cancelled = true;
      if (job.timer) clearTimeout(job.timer);
      job.child?.kill('SIGTERM');
    }
    this.jobs.clear();
  }
}
