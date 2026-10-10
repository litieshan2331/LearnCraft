/**
 * 临时诊断 Judge 请求耗时与底层异常，不修改已有评测结果，不记录密钥或推理内容。
 * 调用顺序：loadEnvironment 加载与启动器一致的配置；probe 用原始提示词发送单次请求；
 * describeError 提取安全错误标识；main 保存请求时序、响应统计与评分校验结果。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { buildJudgeMessages, parseJudgeResponse } from './judge.mjs';

/** 沿用评测启动器的环境优先级，只把配置保存在进程内存中。 */
function loadEnvironment() {
  const configuredPath = process.env.AGENT_EVAL_ENV_FILE?.trim();
  const paths = configuredPath ? [resolve(configuredPath)] : ['infra/.env', '.env'];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
        if (line.includes('"')) value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  }
}

/** 仅保留错误名称和机器错误码，避免记录 URL、密钥或原始错误正文。 */
function describeError(error) {
  return { name: error?.name, code: error?.code, cause_name: error?.cause?.name, cause_code: error?.cause?.code };
}

/** 使用业务已生成的候选输出和现有 Judge 提示词，记录单次请求各阶段耗时。 */
async function probe(caseId, model, timeoutMs) {
  const dataset = JSON.parse(readFileSync('evals/datasets/regression-40-v1-built.json', 'utf8'));
  const runDir = 'evals/runs/regression-40-001';
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const item = run.cases.find((entry) => entry.case_id === caseId);
  const evaluationCase = dataset.cases.find((entry) => entry.case_id === caseId);
  const candidate = JSON.parse(readFileSync(join(runDir, item.file_name), 'utf8'));
  const endpoint = new URL(process.env.AGENT_EVAL_JUDGE_BASE_URL);
  const path = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions';
  const payload = {
    model,
    messages: buildJudgeMessages({ evaluationCase, candidateOutput: candidate.candidate_output }),
    temperature: Number(process.env.AGENT_EVAL_JUDGE_TEMPERATURE || '0'),
    stream: false,
    response_format: { type: 'json_object' },
  };
  const started = Date.now();
  const controller = new AbortController();
  const result = { case_id: caseId, model, timeout_ms: timeoutMs, payload_chars: JSON.stringify(payload).length };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const milestone = setTimeout(() => console.log(JSON.stringify({ event: 'past_production_timeout', case_id: caseId, elapsed_ms: Date.now() - started })), 60_000);
  console.log(JSON.stringify({ event: 'request_started', ...result }));
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.AGENT_EVAL_JUDGE_API_KEY, 'User-Agent': 'LearnCraft-Agent-Eval/0.1' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    result.headers_ms = Date.now() - started;
    result.http_status = response.status;
    const body = await response.text();
    result.elapsed_ms = Date.now() - started;
    result.response_chars = body.length;
    const parsed = JSON.parse(body);
    const message = parsed.choices?.[0]?.message;
    result.finish_reason = parsed.choices?.[0]?.finish_reason;
    result.content_chars = message?.content?.length;
    result.reasoning_chars = message?.reasoning_content?.length;
    result.usage = parsed.usage;
    try {
      parseJudgeResponse(parsed);
      result.score_valid = true;
    } catch (error) {
      result.score_valid = false;
      result.score_error = describeError(error);
      try {
        const content = JSON.parse(message?.content);
        result.score_keys = Object.keys(content);
        result.dimension_shapes = Object.fromEntries(Object.entries(content).map(([key, value]) => [key, { keys: value && typeof value === 'object' ? Object.keys(value) : [], score: value?.score, reason_type: typeof value?.reason, evidence_type: Array.isArray(value?.evidence) ? 'array' : typeof value?.evidence }]));
      } catch { result.content_json_valid = false; }
    }
  } catch (error) {
    result.elapsed_ms = Date.now() - started;
    result.aborted = controller.signal.aborted;
    result.error = describeError(error);
  } finally {
    clearTimeout(timer);
    clearTimeout(milestone);
  }
  console.log(JSON.stringify({ event: 'request_finished', ...result }));
  return result;
}

/** 接收用例、模型和诊断超时并落盘安全统计，不覆盖正式评分目录。 */
async function main() {
  loadEnvironment();
  const caseId = process.argv[2] || 'reg40-assessment-02-python';
  const model = process.argv[3] || process.env.AGENT_EVAL_JUDGE_MODEL;
  const timeoutMs = Number(process.argv[4] || '180000');
  const result = await probe(caseId, model, timeoutMs);
  writeFileSync(join(import.meta.dirname, caseId + '-' + model + '-' + timeoutMs + '.json'), JSON.stringify(result, null, 2) + '\n');
}

await main();
