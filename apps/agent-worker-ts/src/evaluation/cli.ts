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
export const DEFAULT_AGENT_EVAL_BUILT_DATASET_PATH = 'evals/datasets/built.json';
export const DEFAULT_AGENT_EVAL_OUTPUT_DIR = 'evals/runs';

/** 评测工具支持的三个阶段。 */
export type AgentEvalCommand = 'build' | 'run' | 'score';

/** 三阶段命令的解析结果。 */
export interface AgentEvalCommandOptions {
  command: AgentEvalCommand;
  ownerId?: string;
  inputPath: string;
  datasetPath: string;
  outputDir: string;
  retryFailed?: boolean;
}

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
    '用法：',
    '  agent-eval build [--input <草稿文件>] [--dataset <已构建评测集>]',
    '  agent-eval run --owner-id <用户UUID> [--dataset <评测集文件>] [--output <运行目录>]',
    '  agent-eval score --owner-id <用户UUID> [--dataset <评测集文件>] [--output <运行目录>] [--retry-failed]',
    '  agent-eval --owner-id <用户UUID> [--dataset <评测集文件>] [--output <运行目录>]',
    '',
    '选项：',
    '  --owner-id <用户UUID>       使用该用户当前的默认模型连接。',
    '  --input <草稿文件>          build 阶段输入；默认：' + DEFAULT_AGENT_EVAL_DATASET_PATH,
    '  --dataset <评测集文件>      run/score 默认：evals/datasets/built.json。',
    '  --output <结果目录>         默认：' + DEFAULT_AGENT_EVAL_OUTPUT_DIR,
    '  --retry-failed              仅用于 score；保留已有成功及无效结果，只重试 failed 并重新汇总。',
    '  --help                     显示帮助。',
  ].join('\n');
}

/** 解析 build/run/score 三阶段命令；旧的 --owner-id 形式仍按 run 兼容。 */
export function parseAgentEvalCommandArgs(
  argv: readonly string[],
): AgentEvalCommandOptions | { help: true } {
  const first = argv[0];
  if (first === '--help' || first === '-h') {
    return { help: true };
  }
  const command: AgentEvalCommand = first === 'build' || first === 'run' || first === 'score'
    ? first
    : 'run';
  if (command === 'run' && command !== first) {
    const legacy = parseAgentEvalCliArgs(argv);
    if ('help' in legacy) {
      return legacy;
    }
    return {
      command: 'run',
      ownerId: legacy.ownerId,
      inputPath: legacy.datasetPath,
      datasetPath: legacy.datasetPath,
      outputDir: legacy.outputDir,
    };
  }
  return parseCommandOptions(command, argv.slice(1));
}

/** 解析指定阶段的参数并校验 owner-id。 */
function parseCommandOptions(
  command: AgentEvalCommand,
  argv: readonly string[],
): AgentEvalCommandOptions | { help: true } {
  let ownerId: string | undefined;
  let inputPath = DEFAULT_AGENT_EVAL_DATASET_PATH;
  let datasetPath = DEFAULT_AGENT_EVAL_BUILT_DATASET_PATH;
  let outputDir = DEFAULT_AGENT_EVAL_OUTPUT_DIR;
  let retryFailed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      return { help: true };
    }
    if (argument === '--retry-failed') {
      if (command !== 'score') {
        throw new AgentEvalCliError('参数 --retry-failed 只能用于 score 命令。');
      }
      if (retryFailed) {
        throw new AgentEvalCliError('参数 --retry-failed 只能指定一次。');
      }
      retryFailed = true;
      continue;
    }
    const match = /^(--owner-id|--input|--dataset|--output)(?:=(.*))?$/.exec(argument ?? '');
    if (match === null) {
      throw new AgentEvalCliError('未知参数：' + String(argument) + '。使用 --help 查看用法。');
    }
    const optionName = match[1]!;
    const inlineValue = match[2];
    const parsedValue = readOptionValue(argv, index, optionName, inlineValue);
    index = parsedValue.nextIndex;
    if (optionName === '--owner-id') {
      if (ownerId !== undefined) {
        throw new AgentEvalCliError('参数 --owner-id 只能指定一次。');
      }
      ownerId = parsedValue.value;
    } else if (optionName === '--input') {
      inputPath = parsedValue.value;
    } else if (optionName === '--dataset') {
      datasetPath = parsedValue.value;
    } else {
      outputDir = parsedValue.value;
    }
  }
  if (command !== 'build') {
    if (ownerId === undefined) {
      throw new AgentEvalCliError('缺少必需参数 --owner-id。');
    }
    const parsedOwnerId = z.uuid().safeParse(ownerId);
    if (!parsedOwnerId.success) {
      throw new AgentEvalCliError('参数 --owner-id 必须是合法 UUID。');
    }
  }
  return { command, ownerId, inputPath, datasetPath, outputDir, ...(retryFailed ? { retryFailed: true } : {}) };
}
