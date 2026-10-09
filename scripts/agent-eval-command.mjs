/**
 * Agent 评测三阶段命令启动器。
 *
 * 调用顺序：main 读取 build/run/score 命令 → ensureBundle 使用仓库已有 esbuild 打包评测入口 →
 * runEvalProcess 调用 dist/agent-eval.js；因此每次执行都不需要 pnpm 重新链接依赖。
 * 本文件只负责启动构建和评测进程，评测业务逻辑仍由 apps/agent-worker-ts/src/main/agent-eval.ts 执行。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '..');
const workerRoot = resolve(repositoryRoot, 'apps', 'agent-worker-ts');
const workerDist = resolve(workerRoot, 'dist');
const workerEntry = resolve(workerDist, 'agent-eval.js');

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

/** 使用本地 esbuild 打包评测入口，避免触发 pnpm 依赖链接。 */
function ensureBundle() {
  const esbuildCommand = process.platform === 'win32'
    ? resolve(workerRoot, 'node_modules', '.bin', 'esbuild.cmd')
    : resolve(workerRoot, 'node_modules', '.bin', 'esbuild');
  if (!existsSync(esbuildCommand)) {
    throw new Error('找不到本地 esbuild：' + esbuildCommand);
  }
  runCommand(esbuildCommand, [
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
  ensureBundle();
  runEvalProcess(process.argv.slice(2));
}

try {
  main();
} catch (error) {
  console.error('[agent-eval] 启动失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = process.exitCode || 1;
}
