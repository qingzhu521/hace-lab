import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(plugin, '../..');
const cli = resolve(project, '.coharness/dsh-dev/node_modules/@deepseek-ai/dsh/lib/bin.js');
const env = { ...process.env, DSH_HOME: resolve(project, '.coharness/dsh-home'), COHARNESS_LEGACY_STATE_DIR: resolve(project, '.coharness/workspaces'),
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}` };
if (!existsSync(cli) || !existsSync(resolve(plugin, 'lib/client.js'))) {
  throw new Error('Install the isolated dsh runtime and build the plugin first. See README.md.');
}

let stopping = false;
function run(args) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: project, env, stdio: 'inherit' });
    const stop = () => { stopping = true; child.kill('SIGTERM'); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    const cleanup = () => { process.off('SIGTERM', stop); process.off('SIGINT', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0 || stopping || signal === 'SIGTERM') resolveExit();
      else reject(new Error(`dsh exited with ${code ?? signal}`));
    });
  });
}

await run(['plugin', '--profile', 'web', 'add', `file:${plugin}`]);
if (!stopping) await run(['web', '--patch', resolve(plugin, 'scripts/dev-picker.patch.yml'), '--no-open', '--port', process.env.COHARNESS_PORT || '3081']);
