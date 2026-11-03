/**
 * Tavily 工具上下文基准入口：显式开启后执行一次原始 MCP search → extract，
 * 再用线上四字段契约压缩同一结果并计算多轮回灌的估算 token 节省。
 * 调用顺序：readTavilyBenchmarkSettings 读取 env → runTavilyContextBenchmark 发起调用 → 输出 JSON 报告。
 */

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import {
  compactTavilyResults,
  filterSupportedArguments,
  parseSearchSources,
  readMcpPayload,
  TAVILY_REMOTE_MCP_URL,
  type ToolExecutionResult,
} from '../infrastructure/mcp/tavily-tool-gateway.js';
import {
  formatToolContextMeasurement,
  measureToolResultContext,
  type ToolContextMeasurement,
} from '../application/services/tool-context-token-measurement.js';

export interface TavilyBenchmarkSettings {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  query: string;
  searchDepth: string;
  extractDepth: string;
  maxResults: number;
  extractTopResults: number;
  extractChunksPerSource: number;
  includeRawContent: boolean;
  includeAnswer: boolean;
  includeImages: boolean;
  format: string;
  requestsAfterTool: number;
  bytesPerToken: number;
  proxyUrl: string | null;
  outputFile: string | null;
  includePayload: boolean;
}

export interface TavilyContextBenchmarkReport {
  schemaVersion: 'tool_context_benchmark.v1';
  query: string;
  endpoint: string;
  rawPayloadIncluded: boolean;
  rawResult: { search: Record<string, unknown>; extract: Record<string, unknown> } | null;
  compactResult: ToolExecutionResult;
  measurement: ToolContextMeasurement;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(name + ' 必须是大于等于 1 的整数。');
  return parsed;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(name + ' 必须是 true 或 false。');
}

/** 读取基准参数；enabled 默认为 false，防止普通启动或测试意外发起 Tavily 请求。 */
export function readTavilyBenchmarkSettings(): TavilyBenchmarkSettings {
  const enabled = booleanEnv('TAVILY_BENCHMARK_ALLOW_NETWORK', false);
  const apiKey = env('TAVILY_BENCHMARK_API_KEY') ?? env('TAVILY_API_KEY');
  const query = env('TAVILY_BENCHMARK_QUERY');
  if (enabled && apiKey === undefined) throw new Error('开启 Tavily 基准时必须配置 TAVILY_BENCHMARK_API_KEY 或 TAVILY_API_KEY。');
  if (enabled && query === undefined) throw new Error('开启 Tavily 基准时必须配置 TAVILY_BENCHMARK_QUERY。');
  if (enabled && query !== undefined && query.length > 500) throw new Error('TAVILY_BENCHMARK_QUERY 最多 500 个字符。');
  const bytesPerTokenRaw = env('TAVILY_BENCHMARK_BYTES_PER_TOKEN');
  const bytesPerToken = bytesPerTokenRaw === undefined ? 4 : Number(bytesPerTokenRaw);
  if (!Number.isFinite(bytesPerToken) || bytesPerToken <= 0) throw new Error('TAVILY_BENCHMARK_BYTES_PER_TOKEN 必须是正数。');
  const endpoint = env('TAVILY_BENCHMARK_ENDPOINT') ?? TAVILY_REMOTE_MCP_URL;
  if (enabled) {
    let parsedEndpoint: URL;
    try { parsedEndpoint = new URL(endpoint); } catch { throw new Error('TAVILY_BENCHMARK_ENDPOINT 必须是合法 URL。'); }
    if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.username.length > 0 || parsedEndpoint.password.length > 0) {
      throw new Error('TAVILY_BENCHMARK_ENDPOINT 必须是无凭据的 HTTPS URL。');
    }
  }
  return {
    enabled,
    apiKey: apiKey ?? '',
    endpoint,
    query: query ?? '',
    searchDepth: env('TAVILY_BENCHMARK_SEARCH_DEPTH') ?? 'basic',
    extractDepth: env('TAVILY_BENCHMARK_EXTRACT_DEPTH') ?? 'basic',
    maxResults: positiveInteger('TAVILY_BENCHMARK_MAX_RESULTS', 3),
    extractTopResults: positiveInteger('TAVILY_BENCHMARK_EXTRACT_TOP_RESULTS', 2),
    extractChunksPerSource: positiveInteger('TAVILY_BENCHMARK_EXTRACT_CHUNKS_PER_SOURCE', 3),
    includeRawContent: booleanEnv('TAVILY_BENCHMARK_INCLUDE_RAW_CONTENT', true),
    includeAnswer: booleanEnv('TAVILY_BENCHMARK_INCLUDE_ANSWER', false),
    includeImages: booleanEnv('TAVILY_BENCHMARK_INCLUDE_IMAGES', false),
    format: env('TAVILY_BENCHMARK_FORMAT') ?? 'markdown',
    requestsAfterTool: positiveInteger('TAVILY_BENCHMARK_REQUESTS_AFTER_TOOL', 3),
    bytesPerToken,
    proxyUrl: env('MODEL_EGRESS_PROXY_URL') ?? null,
    outputFile: env('TAVILY_BENCHMARK_OUTPUT_FILE') ?? null,
    includePayload: booleanEnv('TAVILY_BENCHMARK_INCLUDE_PAYLOAD', false),
  };
}

function findToolName(names: ReadonlySet<string>, ...candidates: string[]): string {
  for (const candidate of candidates) if (names.has(candidate)) return candidate;
  throw new Error('Tavily MCP 未提供所需工具：' + candidates.join('/'));
}

function schemaOf(tools: readonly { name: string; inputSchema?: unknown }[], name: string): unknown {
  return tools.find((tool) => tool.name === name)?.inputSchema;
}

function serialize(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('基准结果无法序列化为 JSON。');
  return result;
}

/** 发起原始 Tavily MCP 调用，并把完整 search/extract payload 与四字段结果做同源对比。 */
export async function runTavilyContextBenchmark(settings: TavilyBenchmarkSettings): Promise<TavilyContextBenchmarkReport> {
  if (!settings.enabled) throw new Error('Tavily 基准未开启；请设置 TAVILY_BENCHMARK_ALLOW_NETWORK=true。');
  const dispatcher: Dispatcher = settings.proxyUrl === null
    ? new Agent({ connect: { timeout: 10_000 }, headersTimeout: 45_000, bodyTimeout: 45_000 })
    : new ProxyAgent({ uri: settings.proxyUrl, connect: { timeout: 10_000 } });
  const client = new Client({ name: 'learncraft-tool-context-benchmark', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(settings.endpoint), {
    requestInit: {
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + settings.apiKey,
        DEFAULT_PARAMETERS: JSON.stringify({
          search_depth: settings.searchDepth,
          max_results: settings.maxResults,
          include_images: settings.includeImages,
          include_raw_content: settings.includeRawContent,
          include_answer: settings.includeAnswer,
        }),
        'User-Agent': 'LearnCraft-Tool-Context-Benchmark/0.1',
      },
    },
    fetch: ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) => undiciFetch(input, {
      ...(init ?? {}),
      dispatcher,
      redirect: 'manual',
    })) as never,
  });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    const names = new Set(tools.map((tool) => tool.name));
    const searchName = findToolName(names, 'tavily_search', 'tavily-search');
    const extractName = findToolName(names, 'tavily_extract', 'tavily-extract');
    const searchResponse = await client.callTool({
      name: searchName,
      arguments: filterSupportedArguments(schemaOf(tools, searchName), {
        query: settings.query,
        search_depth: settings.searchDepth,
        max_results: settings.maxResults,
        include_images: settings.includeImages,
        include_raw_content: settings.includeRawContent,
        include_answer: settings.includeAnswer,
      }),
    });
    const searchPayload = readMcpPayload(searchResponse, 'TAVILY_BENCHMARK_SEARCH_FAILED');
    const sources = parseSearchSources(searchPayload);
    let extractPayload: Record<string, unknown> = { results: [] };
    if (sources.length > 0) {
      const selected = sources.slice(0, settings.extractTopResults);
      const extractResponse = await client.callTool({
        name: extractName,
        arguments: filterSupportedArguments(schemaOf(tools, extractName), {
          urls: selected.map((source) => source.url),
          query: settings.query,
          extract_depth: settings.extractDepth,
          chunks_per_source: settings.extractChunksPerSource,
          include_images: settings.includeImages,
          include_favicon: false,
          format: settings.format,
        }),
      });
      extractPayload = readMcpPayload(extractResponse, 'TAVILY_BENCHMARK_EXTRACT_FAILED');
    }
    const compactResult = compactTavilyResults({ query: settings.query, searchPayload, extractPayload, extractTopResults: settings.extractTopResults });
    const rawResult = { search: searchPayload, extract: extractPayload };
    const measurement = measureToolResultContext({
      rawResult: serialize(rawResult),
      compactResult: serialize(compactResult),
      requestsAfterTool: settings.requestsAfterTool,
      bytesPerToken: settings.bytesPerToken,
    });
    return {
      schemaVersion: 'tool_context_benchmark.v1',
      query: settings.query,
      endpoint: settings.endpoint,
      rawPayloadIncluded: settings.includePayload,
      rawResult: settings.includePayload ? rawResult : null,
      compactResult,
      measurement,
    };
  } finally {
    await client.close().catch(() => undefined);
    await dispatcher.close().catch(() => undefined);
  }
}

/** 独立 CLI：输出 stdout，并可按 env 写入 JSON 文件。 */
export async function main(): Promise<void> {
  const settings = readTavilyBenchmarkSettings();
  const report = await runTavilyContextBenchmark(settings);
  const text = formatToolContextMeasurement(report.measurement);
  console.log(JSON.stringify({ ...report, measurement: JSON.parse(text) }, null, 2));
  if (settings.outputFile !== null) await writeFile(settings.outputFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[tool-context-benchmark] ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
