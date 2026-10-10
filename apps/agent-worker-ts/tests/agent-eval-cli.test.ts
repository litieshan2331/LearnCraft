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
  parseAgentEvalCommandArgs,
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

describe('parseAgentEvalCommandArgs', () => {
  it('解析 build、run、score 三阶段命令', () => {
    expect(parseAgentEvalCommandArgs(['build', '--input', 'draft.json', '--dataset', 'built.json'])).toEqual({
      command: 'build',
      inputPath: 'draft.json',
      datasetPath: 'built.json',
      outputDir: 'evals/runs',
    });
    expect(parseAgentEvalCommandArgs(['run', '--owner-id', OWNER_ID])).toMatchObject({
      command: 'run',
      ownerId: OWNER_ID,
      datasetPath: 'evals/datasets/built.json',
    });
    expect(parseAgentEvalCommandArgs(['score', '--owner-id=' + OWNER_ID, '--output', 'runs/001'])).toMatchObject({
      command: 'score',
      ownerId: OWNER_ID,
      outputDir: 'runs/001',
    });
  });

  it('score 支持无值的 --retry-failed，普通 score 保持原行为', () => {
    expect(parseAgentEvalCommandArgs(['score', '--retry-failed', '--owner-id', OWNER_ID])).toMatchObject({
      command: 'score',
      ownerId: OWNER_ID,
      retryFailed: true,
    });
    expect(parseAgentEvalCommandArgs(['score', '--owner-id', OWNER_ID])).not.toHaveProperty('retryFailed');
    expect(formatAgentEvalCliUsage()).toContain('--retry-failed');
  });

  it('拒绝非 score 命令、重复开关和带值的重试参数', () => {
    expect(() => parseAgentEvalCommandArgs(['build', '--retry-failed'])).toThrow('只能用于 score');
    expect(() => parseAgentEvalCommandArgs(['run', '--owner-id', OWNER_ID, '--retry-failed'])).toThrow('只能用于 score');
    expect(() => parseAgentEvalCommandArgs(['score', '--owner-id', OWNER_ID, '--retry-failed', '--retry-failed'])).toThrow('只能指定一次');
    expect(() => parseAgentEvalCommandArgs(['score', '--owner-id', OWNER_ID, '--retry-failed=true'])).toThrow(AgentEvalCliError);
  });
});
