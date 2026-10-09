/**
 * Agent 评测三阶段命令启动器。
 *
 * 调用顺序：main 读取 build/run/score 命令 → ensureBundle 使用仓库已有 esbuild 打包评测入口 →
 * runEvalProcess 调用 dist/agent-eval.js；因此每次执行都不需要 pnpm 重新链接依赖。
 * 本文件只负责启动构建和评测进程，评测业务逻辑仍由 apps/agent-worker-ts/src/main/agent-eval.ts 执行。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const workerRoot = resolve(repositoryRoot, 'apps', 'agent-worker-ts');
const workerDist = resolve(workerRoot, 'dist');
const workerEntry = resolve(workerDist, 'agent-eval.js');

/** 读取一个 dotenv 文件；已有进程环境变量优先于文件中的同名变量。 */
function loadDotEnvFile(path) {
  if (!existsSync(path)) {
    return false;
  }
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
      if (line.includes('"')) {
        value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

/** 自动加载评测环境；可用 AGENT_EVAL_ENV_FILE 指定其它 dotenv 文件。 */
function loadEvaluationEnvironment() {
  const configuredPath = process.env.AGENT_EVAL_ENV_FILE?.trim();
  if (configuredPath !== undefined && configuredPath.length > 0) {
    loadDotEnvFile(resolve(repositoryRoot, configuredPath));
    return;
  }
  // Compose 配置默认位于 infra/.env；根目录 .env 作为通用本地配置兜底。
  loadDotEnvFile(resolve(repositoryRoot, 'infra', '.env'));
  loadDotEnvFile(resolve(repositoryRoot, '.env'));
}

/** 执行外部命令并在失败时抛出错误。 */
function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error('命令执行失败：' + command);
  }
}

/** 查找可执行的 esbuild；工作区链接损坏时回退到 pnpm 内容仓库中的实际入口。 */
function resolveEsbuildInvocation() {
  const linkedCommand = process.platform === 'win32'
    ? resolve(workerRoot, 'node_modules', '.bin', 'esbuild.cmd')
    : resolve(workerRoot, 'node_modules', '.bin', 'esbuild');
  const linkedEntry = resolve(workerRoot, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (existsSync(linkedCommand) && existsSync(linkedEntry)) {
    return { command: linkedCommand, args: [] };
  }

  const pnpmStore = resolve(repositoryRoot, 'node_modules', '.pnpm');
  if (existsSync(pnpmStore)) {
    const candidates = readdirSync(pnpmStore)
      .filter((name) => name.startsWith('esbuild@'))
      .sort()
      .reverse()
      .map((name) => resolve(pnpmStore, name, 'node_modules', 'esbuild', 'bin', 'esbuild'))
      .filter((path) => existsSync(path));
    if (candidates[0] !== undefined) {
      return { command: process.execPath, args: [candidates[0]] };
    }
  }
  throw new Error('找不到可用的 esbuild：请先修复 agent-worker-ts 的依赖安装。');
}

/** 使用本地 esbuild 打包评测入口，避免触发 pnpm 依赖链接。 */
function ensureBundle() {
  const esbuild = resolveEsbuildInvocation();
  runCommand(esbuild.command, [...esbuild.args,
    'src/main/worker.ts',
    'src/main/dispatcher.ts',
    'src/main/agent-eval.ts',
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    '--outdir=dist',
    '--sourcemap',
    '--external:pg',
    '--external:bullmq',
    '--external:zod',
    '--external:undici',
    '--external:@modelcontextprotocol/sdk',
  ], workerRoot);
}

/** 启动构建后的评测命令并透传其参数和退出码。 */
function runEvalProcess(args) {
  if (!existsSync(workerEntry)) {
    throw new Error('评测入口构建失败：' + workerEntry);
  }
  runCommand(process.execPath, [workerEntry, ...args], repositoryRoot);
}

/** 执行三阶段评测命令。 */
function main() {
  const command = process.argv[2];
  if (command !== 'build' && command !== 'run' && command !== 'score') {
    console.error('用法：node scripts/agent-eval-command.mjs <build|run|score> [选项]');
    process.exitCode = 2;
    return;
  }
  loadEvaluationEnvironment();
  ensureBundle();
  runEvalProcess(process.argv.slice(2));
}

try {
  main();
} catch (error) {
  console.error('[agent-eval] 启动失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = process.exitCode || 1;
}
