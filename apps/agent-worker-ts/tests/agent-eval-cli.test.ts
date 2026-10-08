/**
 * 独立 Agent 评测进程命令行参数测试。
 *
 * 调用顺序：传入命令行数组，验证默认值、显式值、帮助参数和非法参数均按约定处理。
 */

import { describe, expect, it } from 'vitest';

import {
  AgentEvalCliError,
  DEFAULT_AGENT_EVAL_DATASET_PATH,
  DEFAULT_AGENT_EVAL_OUTPUT_DIR,
  formatAgentEvalCliUsage,
  parseAgentEvalCliArgs,
} from '../src/evaluation/cli.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';

describe('parseAgentEvalCliArgs', () => {
  it('解析 owner-id 并使用默认路径', () => {
    expect(parseAgentEvalCliArgs(['--owner-id', OWNER_ID])).toEqual({
      ownerId: OWNER_ID,
      datasetPath: DEFAULT_AGENT_EVAL_DATASET_PATH,
      outputDir: DEFAULT_AGENT_EVAL_OUTPUT_DIR,
    });
  });

  it('支持等号写法和自定义路径', () => {
    expect(parseAgentEvalCliArgs([
      '--owner-id=' + OWNER_ID,
      '--dataset', 'evals/datasets/v1.jsonl',
      '--output=evals/runs/run-001',
    ])).toEqual({
      ownerId: OWNER_ID,
      datasetPath: 'evals/datasets/v1.jsonl',
      outputDir: 'evals/runs/run-001',
    });
  });

  it('帮助参数不要求 owner-id', () => {
    expect(parseAgentEvalCliArgs(['--help'])).toEqual({ help: true });
    expect(formatAgentEvalCliUsage()).toContain('--owner-id');
  });

  it('缺少 owner-id 或遇到未知参数时抛出 CLI 错误', () => {
    expect(() => parseAgentEvalCliArgs([])).toThrow(AgentEvalCliError);
    expect(() => parseAgentEvalCliArgs(['--unknown'])).toThrow(AgentEvalCliError);
  });
});
