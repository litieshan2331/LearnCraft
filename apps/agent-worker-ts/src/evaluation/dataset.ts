/**
 * Agent 评测集的读取、校验和标准化落盘。
 *
 * 调用顺序：readEvaluationDataset 读取 JSON/JSONL 并通过评测集契约校验；
 * writeEvaluationDataset 将已校验的数据写成后续 run 和 score 共用的 JSON 文件。
 * 本文件只处理评测集，不调用数据库、业务模型或 Judge。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { EvaluationDatasetSchema, type EvaluationDataset } from './schema/index.js';

/** 评测集构建命令的默认输入与输出路径。 */
export const DEFAULT_EVALUATION_DATASET_INPUT = 'evals/datasets/default.json';
export const DEFAULT_EVALUATION_DATASET_OUTPUT = 'evals/datasets/built.json';

/** 读取 JSON 或 JSONL 评测集，并返回经过统一契约校验的数据。 */
export async function readEvaluationDataset(path: string): Promise<EvaluationDataset> {
  const content = await readFile(resolve(path), 'utf8');
  let raw: unknown;
  if (path.toLowerCase().endsWith('.jsonl')) {
    const cases = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
    const first = cases[0];
    if (!isRecord(first) || typeof first.dataset_version !== 'string') {
      throw new Error('JSONL 评测集首行必须包含 dataset_version。');
    }
    raw = { schema_version: 'agent_eval.dataset.v1', dataset_version: first.dataset_version, cases };
  } else {
    raw = JSON.parse(content) as unknown;
  }
  const parsed = EvaluationDatasetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('评测集不符合 agent_eval.dataset.v1 契约。');
  }
  return parsed.data;
}

/** 将已校验评测集以稳定 JSON 格式写入目标路径。 */
export async function writeEvaluationDataset(
  path: string,
  dataset: EvaluationDataset,
): Promise<string> {
  const parsed = EvaluationDatasetSchema.parse(dataset);
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return target;
}

/** 判断未知值是否为非数组对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
