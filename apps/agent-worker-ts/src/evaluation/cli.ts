/**
 * 独立 Agent 评测进程的命令行参数解析。
 *
 * 调用顺序：入口调用 parseAgentEvalCliArgs 解析参数；解析失败时抛出可展示的错误，
 * 解析成功后返回 owner-id、评测集路径和结果目录，后续评测流程再消费该配置。
 *
 * 导出：
 * - AgentEvalCliOptions：解析后的命令行配置。
 * - AgentEvalCliError：命令行参数错误。
 * - parseAgentEvalCliArgs：解析命令行参数。
 * - formatAgentEvalCliUsage：生成帮助文本。
 */

import { z } from 'zod';

/** 评测集和结果目录的默认路径。 */
export const DEFAULT_AGENT_EVAL_DATASET_PATH = 'evals/datasets/default.json';
export const DEFAULT_AGENT_EVAL_OUTPUT_DIR = 'evals/runs';

/** 评测进程解析后的命令行配置。 */
export interface AgentEvalCliOptions {
  ownerId: string;
  datasetPath: string;
  outputDir: string;
}

/** 命令行参数错误，供入口统一转换为退出码 1。 */
export class AgentEvalCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEvalCliError';
  }
}

/** 判断一个参数是否是帮助参数。 */
function isHelpArgument(argument: string): boolean {
  return argument === '--help' || argument === '-h';
}

/** 从参数中读取带值选项，并检查是否重复或缺少值。 */
function readOptionValue(
  argv: readonly string[],
  index: number,
  optionName: string,
  inlineValue: string | undefined,
): { value: string; nextIndex: number } {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) {
      throw new AgentEvalCliError('参数 ' + optionName + ' 的值不能为空。');
    }
    return { value: inlineValue, nextIndex: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) {
    throw new AgentEvalCliError('参数 ' + optionName + ' 缺少值。');
  }
  return { value: next, nextIndex: index + 1 };
}

/** 校验并标准化解析结果，确保 owner-id 是项目使用的 UUID。 */
function validateOptions(options: AgentEvalCliOptions): AgentEvalCliOptions {
  const parsed = z
    .object({
      ownerId: z.uuid(),
      datasetPath: z.string().min(1),
      outputDir: z.string().min(1),
    })
    .safeParse(options);
  if (!parsed.success) {
    throw new AgentEvalCliError('评测参数不合法：' + parsed.error.issues.map((issue) => issue.message).join('；'));
  }
  return parsed.data;
}

/** 解析独立评测进程参数；支持 --option value 和 --option=value 两种写法。 */
export function parseAgentEvalCliArgs(
  argv: readonly string[],
): AgentEvalCliOptions | { help: true } {
  let ownerId: string | undefined;
  let datasetPath = DEFAULT_AGENT_EVAL_DATASET_PATH;
  let outputDir = DEFAULT_AGENT_EVAL_OUTPUT_DIR;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) {
      continue;
    }
    if (isHelpArgument(argument)) {
      help = true;
      continue;
    }

    const match = /^(--owner-id|--dataset|--output)(?:=(.*))?$/.exec(argument);
    if (match === null) {
      throw new AgentEvalCliError('未知参数：' + argument + '。使用 --help 查看用法。');
    }
    const optionName = match[1];
    const inlineValue = match[2];
    if (optionName === undefined) {
      throw new AgentEvalCliError('无法解析参数：' + argument + '。');
    }
    const parsedValue = readOptionValue(argv, index, optionName, inlineValue);
    index = parsedValue.nextIndex;
    if (optionName === '--owner-id') {
      if (ownerId !== undefined) {
        throw new AgentEvalCliError('参数 --owner-id 只能指定一次。');
      }
      ownerId = parsedValue.value;
    } else if (optionName === '--dataset') {
      datasetPath = parsedValue.value;
    } else {
      outputDir = parsedValue.value;
    }
  }

  if (help) {
    return { help: true };
  }
  if (ownerId === undefined) {
    throw new AgentEvalCliError('缺少必需参数 --owner-id。');
  }
  return validateOptions({ ownerId, datasetPath, outputDir });
}

/** 生成独立评测进程的命令行帮助文本。 */
export function formatAgentEvalCliUsage(): string {
  return [
    '用法：agent-eval --owner-id <用户UUID> [--dataset <评测集文件>] [--output <结果目录>]',
    '',
    '选项：',
    '  --owner-id <用户UUID>       使用该用户当前的默认模型连接。',
    '  --dataset <评测集文件>      默认：' + DEFAULT_AGENT_EVAL_DATASET_PATH,
    '  --output <结果目录>         默认：' + DEFAULT_AGENT_EVAL_OUTPUT_DIR,
    '  --help                     显示帮助。',
  ].join('\n');
}
