/**
 * 工具上下文基准启动器：使用仓库已有 esbuild 打包 TypeScript 入口，再运行一次显式开启的 Tavily 基准。
 * 调用顺序：读取 dotenv → 定位 esbuild → 打包 → 启动 tool-context-benchmark.js。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const workerRoot = resolve(repositoryRoot, 'apps', 'agent-worker-ts');
const workerDist = resolve(workerRoot, 'dist');
const workerEntry = resolve(workerDist, 'tool-context-benchmark.js');

function loadDotEnvFile(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null || line.startsWith('#')) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function resolveEsbuild() {
  const linked = resolve(workerRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  const linkedEntry = resolve(workerRoot, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (existsSync(linked) && existsSync(linkedEntry)) return { command: linked, args: [] };
  const store = resolve(repositoryRoot, 'node_modules', '.pnpm');
  const candidate = readdirSync(store).filter((name) => name.startsWith('esbuild@')).sort().reverse()
    .map((name) => resolve(store, name, 'node_modules', 'esbuild', 'bin', 'esbuild')).find(existsSync);
  if (candidate === undefined) throw new Error('找不到 esbuild，请先安装工作区依赖。');
  return { command: process.execPath, args: [candidate] };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.cmd') });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('命令执行失败：' + command);
}

function main() {
  loadDotEnvFile(resolve(repositoryRoot, 'infra', '.env'));
  loadDotEnvFile(resolve(repositoryRoot, '.env'));
  const esbuild = resolveEsbuild();
  run(esbuild.command, [...esbuild.args,
    'src/main/tool-context-benchmark.ts', '--bundle', '--platform=node', '--format=esm', '--target=node22',
    '--outfile=dist/tool-context-benchmark.js', '--external:undici', '--external:@modelcontextprotocol/sdk',
  ], workerRoot);
  run(process.execPath, [workerEntry], repositoryRoot);
}

try { main(); } catch (error) {
  console.error('[tool-context-benchmark] 启动失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
