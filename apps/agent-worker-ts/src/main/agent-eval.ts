/**
 * 独立 Agent 评测进程入口（参数解析阶段）。
 *
 * 调用顺序：main 读取进程参数并调用 parseAgentEvalCliArgs；--help 输出用法，
 * 有效参数则打印解析结果，为后续评测集执行、业务 Agent 调用和 Judge 调用提供启动边界。
 * 本阶段不执行评测，不访问数据库，也不调用模型 Provider。
 */

import { pathToFileURL } from 'node:url';

import {
  AgentEvalCliError,
  formatAgentEvalCliUsage,
  parseAgentEvalCliArgs,
} from '../evaluation/cli.js';

/** 判断当前模块是否由 Node 作为独立进程入口直接执行。 */
function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/** 解析并展示评测进程启动参数；实际评测执行将在后续步骤接入。 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseAgentEvalCliArgs(argv);
  if ('help' in parsed) {
    console.log(formatAgentEvalCliUsage());
    return;
  }
  console.log('[agent-eval] 参数解析成功：' + JSON.stringify(parsed));
}

/** 处理独立进程入口错误并返回非零退出码。 */
async function runMain(): Promise<void> {
  try {
    await main();
  } catch (error: unknown) {
    if (error instanceof AgentEvalCliError) {
      console.error('[agent-eval] ' + error.message);
      console.error(formatAgentEvalCliUsage());
    } else {
      console.error('[agent-eval] 启动失败', error);
    }
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  void runMain();
}
