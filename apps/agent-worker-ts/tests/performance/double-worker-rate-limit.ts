/**
 * 双进程 BullMQ、真实 Redis Lua 与真实 HTTPS SSE 的隔离验证，不调用付费模型或数据库。
 * 调用顺序：main 创建记录端和两个子进程 → runBatch 制造竞争 → verify 核对许可和请求
 * → ttlCases 验证续期、迟到释放及故障 → 写出脱敏事件和中文报告；workerMain 消费测试队列。
 * 所有配置仅作用于随机测试命名空间，测试出网适配器不改变生产安全策略。
 */
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { parseRedisConnection, type AgentQueueConfig } from '../../src/bootstrap/config.js';
import { createAgentRunWorker, type AgentRunJobPayload } from '../../src/infrastructure/queue/bullmq-agent-queue.js';
import { RespRedisClient } from '../../src/infrastructure/redis/resp-client.js';
import { RedisModelRateLimiter, type ModelRateLimitOptions, type ModelRateLimitLease } from '../../src/infrastructure/redis/model-rate-limiter.js';
import { OpenAiCompatibleModelGateway, ModelGatewayError } from '../../src/infrastructure/llm/model-gateway.js';
import { SafeModelEgressClient, createNodePinnedRequester } from '../../src/infrastructure/llm/safe-egress-client.js';

type Scene = 'G' | 'K-C' | 'U-C' | 'K-R' | 'U-R';
interface Fixture {
  id: string; scene: Scene; round: number; phase: number; wave: number;
  key: string; user: string; model: string; target: boolean; holdMs: number; prefix: string;
  submittedAt: number;
}
interface Event {
  type: string; at: number; id?: string; worker?: string; pid?: number; fixture?: Fixture;
  leaseId?: string; window?: number; code?: string; elapsedMs?: number; waitMs?: number;
}
interface WorkerMessage extends Event { type: string }
const redisUrl = process.env.AGENT_LIMIT_TEST_REDIS_URL;
assert(redisUrl, '必须显式指定独立测试 AGENT_LIMIT_TEST_REDIS_URL，不读取业务 Redis 配置。');
const base: ModelRateLimitOptions = {
  globalConcurrency: 100, apiKeyConcurrency: 100, userConcurrency: 100,
  apiKeyRpm: 1000, userRpm: 1000, leaseTtlSeconds: 1,
};

/** 返回每个场景的单维度约束，其他维度保留足够余量。 */
function options(scene: Scene, keyPrefix: string): ModelRateLimitOptions {
  const result = { ...base, keyPrefix };
  if (scene === 'G') result.globalConcurrency = 3;
  if (scene === 'K-C') result.apiKeyConcurrency = 2;
  if (scene === 'U-C') result.userConcurrency = 2;
  if (scene === 'K-R') result.apiKeyRpm = 5;
  if (scene === 'U-R') result.userRpm = 5;
  return result;
}

/** 生成两个进程共享的队列设置，每个进程四个任务槽位。 */
function queueConfig(prefix: string): AgentQueueConfig {
  return {
    connection: parseRedisConnection(redisUrl!), prefix, queueName: 'limit-verification',
    concurrency: 4, lockDurationMs: 30_000, maxAttempts: 0, backoffMs: 100, backoffMaxMs: 100,
  };
}

/** 从真实 Redis 时钟取得毫秒时间，避免用各 Worker 的时钟猜测 RPM 窗口。 */
async function redisNow(client: RespRedisClient): Promise<number> {
  const result = await client.command('EVAL', "local t=redis.call('TIME'); return t[1]*1000+math.floor(t[2]/1000)", '0');
  assert.equal(typeof result, 'number');
  return Number(result);
}

/** 带上界地等待可观察条件；覆盖不足时抛错而不是生成通过报告。 */
async function until(predicate: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('等待超时：' + description);
    await delay(10);
  }
}

/** 测试进程使用真实受控出网和证书，仅把测试域名解析为本机 HTTPS 夹具。 */
async function testEgress(port: number): Promise<SafeModelEgressClient> {
  const cert = await readFile(resolve('tests/fixtures/test-only-cert.pem'), 'utf8');
  const requester = createNodePinnedRequester();
  return new SafeModelEgressClient(
    { enabled: true, proxyUrl: null, connectTimeoutMs: 2000, readTimeoutMs: 5000, maxResponseBytes: 65536 },
    { record: async () => {} },
    { resolveEndpoint: async () => ({ baseUrl: 'https://api.example.com', hostname: 'api.example.com', port, pinnedIp: '127.0.0.1' }) },
    { request: async (input) => requester.request({ ...input, ca: cert }) },
  );
}

/** 子进程消费真实 BullMQ 测试任务，经许可、网关和 HTTPS 流完成或受控拒绝。 */
async function workerMain(): Promise<void> {
  const workerId = process.argv[3]!;
  const client = new RespRedisClient({ url: redisUrl! });
  const egress = await testEgress(Number(process.env.LIMIT_TEST_PORT));
  const gates = new Map<string, () => void>();
  const worker = createAgentRunWorker(queueConfig(process.env.LIMIT_TEST_QUEUE_PREFIX!), async (job) => {
    const fixture = (job.data as AgentRunJobPayload & { fixture: Fixture }).fixture;
    const started = Date.now();
    await new Promise<void>((release) => {
      gates.set(fixture.id, release);
      process.send?.({ type: 'ready', at: Date.now(), worker: workerId, id: fixture.id, fixture, pid: process.pid });
    });
    let granted: ModelRateLimitLease | undefined;
    const limiter = new RedisModelRateLimiter(client, options(fixture.scene, fixture.prefix));
    const gateway = new OpenAiCompatibleModelGateway(
      { postOpenAiCompatibleSse: async (input) => egress.postOpenAiCompatibleSse({
        ...input, payload: { ...(input.payload as object), test_fixture: { ...fixture, worker: workerId, leaseId: granted?.leaseId } },
      }) },
      0, undefined,
      { acquire: async (identity) => {
        granted = await limiter.acquire(identity);
        process.send?.({ type: 'acquired', at: Date.now(), worker: workerId, id: fixture.id, fixture, leaseId: granted.leaseId, window: granted.window });
        return granted;
      } },
    );
    let code = 'OK';
    try {
      await gateway.complete({
        agentRunId: fixture.id,
        connection: { ownerId: fixture.user, connectionId: 'test', apiKey: fixture.key, modelId: fixture.model, baseUrl: 'https://api.example.com' },
        messages: [{ role: 'user', content: '隔离限流验证' }],
      });
    } catch (error) {
      code = error instanceof ModelGatewayError ? error.code : String(error);
    }
    const result = { code, elapsedMs: Date.now() - fixture.submittedAt, waitMs: started - fixture.submittedAt };
    process.send?.({ type: 'done', at: Date.now(), worker: workerId, id: fixture.id, fixture, ...result });
    return result;
  });
  worker.on('error', (error) => process.send?.({ type: 'fatal', at: Date.now(), code: error.message }));
  process.on('message', async (message: { type: string; id?: string }) => {
    if (message.type === 'go') { gates.get(message.id!)?.(); gates.delete(message.id!); }
    if (message.type === 'stop') {
      await worker.close(); await client.close(); process.disconnect();
    }
  });
  await worker.waitUntilReady();
  process.send?.({ type: 'online', at: Date.now(), worker: workerId, pid: process.pid });
}

/** 创建 SSE 模型夹具，统一记录请求开始/真实响应结束或连接中止。 */
async function modelServer(events: Event[]): Promise<{ server: Server; port: number }> {
  const cert = await readFile(resolve('tests/fixtures/test-only-cert.pem'));
  const key = await readFile(resolve('tests/fixtures/test-only-key.pem'));
  const server = createServer({ cert, key }, async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { test_fixture: Fixture & { worker: string; leaseId: string } };
      const fixture = body.test_fixture;
      assert(fixture?.id, '缺少测试身份');
      events.push({ type: 'start', at: Date.now(), id: fixture.id, fixture, worker: fixture.worker, leaseId: fixture.leaseId });
      response.on('close', () => events.push({ type: 'end', at: Date.now(), id: fixture.id, fixture, worker: fixture.worker, code: response.writableFinished ? 'OK' : 'ABORTED' }));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '验证响应' } }] }) + '\n\n');
      const timer = setTimeout(() => response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n'), fixture.holdMs);
      response.once('close', () => clearTimeout(timer));
    } catch (error) { response.destroy(error as Error); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert(address && typeof address === 'object');
  return { server, port: address.port };
}

/** 提交八个任务并建立双进程屏障，先让 A/B 各发一个目标调用再释放竞争需求。 */
async function runBatch(queue: Queue, children: ChildProcess[], events: Event[], fixtures: Fixture[], seed: boolean): Promise<void> {
  const ids = new Set(fixtures.map((fixture) => fixture.id));
  await queue.addBulk(fixtures.map((fixture) => ({ name: 'agent.run', data: { agent_run_id: fixture.id, trace_id: randomUUID(), task_version: 1, fixture }, opts: { jobId: fixture.id, attempts: 1 } })));
  await until(() => events.filter((event) => event.type === 'ready' && ids.has(event.id!)).length === 8, '双 Worker 各占四个槽位');
  const ready = events.filter((event) => event.type === 'ready' && ids.has(event.id!));
  assert.equal(ready.filter((event) => event.worker === 'A').length, 4);
  assert.equal(ready.filter((event) => event.worker === 'B').length, 4);
  const sent = new Set<string>();
  /** 通过 IPC 放行指定 Worker 的任务，不绕过 BullMQ 的真实消费。 */
  const go = (event: Event): void => {
    children[event.worker === 'A' ? 0 : 1]!.send({ type: 'go', id: event.id }); sent.add(event.id!);
  };
  if (seed) {
    for (const name of ['A', 'B']) go(ready.find((event) => event.worker === name && event.fixture?.target)!);
    await until(() => events.filter((event) => event.type === 'start' && sent.has(event.id!)).length === 2, '双 Worker 目标调用重叠');
  }
  for (const event of ready) if (!sent.has(event.id!)) go(event);
  await until(() => events.filter((event) => event.type === 'done' && ids.has(event.id!)).length === 8, '全部任务终态');
  await until(() => {
    const starts = events.filter((event) => event.type === 'start' && ids.has(event.id!));
    return starts.every((start) => events.some((event) => event.type === 'end' && event.id === start.id));
  }, '模型端点响应结束');
}

/** 以就近秩法输出小样本分位数，保留样本数，不解释为生产容量。 */
function percentiles(values: number[]): { n: number; p95: number | null; p99: number | null } {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null, p99: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null };
}

/** 对一次场景的所有三层并发和两层 RPM、拒绝不出网、许可关联及双进程参与作断言。 */
function verify(events: Event[], scene: Scene, round: number, phase: number) {
  const selected = events.filter((event) => event.fixture?.scene === scene && event.fixture.round === round && event.fixture.phase === phase);
  const starts = selected.filter((event) => event.type === 'start');
  const grants = selected.filter((event) => event.type === 'acquired');
  const done = selected.filter((event) => event.type === 'done');
  const config = options(scene, '');
  const active = new Map<string, Fixture>();
  const windows = new Map<string, number>();
  let peak = 0; let crossWorker = false;
  for (const event of selected) {
    if (event.type === 'start') {
      assert(grants.some((grant) => grant.id === event.id && grant.leaseId === event.leaseId), '实际请求必须关联自己的许可');
      assert(!active.has(event.id!), '不得重复出网');
      active.set(event.id!, event.fixture!);
      const all = [...active.values()];
      assert(all.length <= config.globalConcurrency, '全局并发越界');
      for (const fixture of all) {
        assert(all.filter((f) => f.key === fixture.key && f.model === fixture.model).length <= config.apiKeyConcurrency, '凭据并发越界');
        assert(all.filter((f) => f.user === fixture.user && f.model === fixture.model).length <= config.userConcurrency, '用户并发越界');
      }
      const targeted = all.filter((f) => f.target);
      peak = Math.max(peak, targeted.length);
      const workers = new Set(starts.filter((s) => active.has(s.id!)).map((s) => s.worker));
      if (workers.size === 2) crossWorker = true;
    }
    if (event.type === 'end') assert(active.delete(event.id!), '结束记录必须对应开始');
  }
  for (const grant of grants) {
    assert(Number.isInteger(grant.window), '必须记录 Lua 返回的真实分钟窗口');
    for (const [kind, identity, cap] of [['key', grant.fixture!.key, config.apiKeyRpm], ['user', grant.fixture!.user, config.userRpm]] as const) {
      const group = `${kind}:${identity}:${grant.fixture!.model}:${grant.window}`;
      const count = (windows.get(group) ?? 0) + 1; windows.set(group, count);
      assert(count <= cap, '固定窗口 RPM 越界');
    }
  }
  assert.equal(active.size, 0); assert.equal(done.length, 24);
  const rejected = done.filter((event) => event.code === 'MODEL_RATE_LIMIT_EXCEEDED');
  assert(rejected.length > 0, '必须产生额外竞争和拒绝');
  assert(done.every((event) => event.code === 'OK' || event.code === 'MODEL_RATE_LIMIT_EXCEEDED'), '存在非预期故障');
  for (const event of rejected) assert(!starts.some((start) => start.id === event.id), '被拒绝的任务不得出网');
  for (const worker of ['A', 'B']) assert(starts.some((start) => start.worker === worker && start.fixture?.target), '两个 Worker 都应发起目标调用');
  assert(crossWorker, '必须有双进程调用重叠');
  if (scene !== 'G') assert(starts.some((start) => !start.fixture?.target), '独立身份对照必须获准');
  const targetGrants = grants.filter((grant) => grant.fixture?.target);
  const actualWindows = [...new Set(targetGrants.map((grant) => grant.window!))];
  if (scene.endsWith('R')) {
    assert.equal(actualWindows.length, 1, '一轮 RPM 不得意外跨窗');
    assert.equal(targetGrants.length, 5, '应达到 RPM 限额');
  } else assert.equal(peak, scene === 'G' ? 3 : 2, '必须实际达到并发限制');
  const successful = done.filter((event) => event.code === 'OK');
  assert.equal(successful.length, starts.length, '每个实际请求应成功完成');
  return {
    scene, round, phase, tasks: done.length, peak, targetGranted: targetGrants.length,
    windows: actualWindows, rejected: rejected.length,
    requestsA: starts.filter((event) => event.worker === 'A').length,
    requestsB: starts.filter((event) => event.worker === 'B').length,
    violations: 0, status: '通过',
    completionMs: percentiles(successful.map((event) => event.elapsedMs!)),
    modelMs: percentiles(starts.map((start) => selected.find((event) => event.type === 'end' && event.id === start.id)!.at - start.at)),
  };
}

/** 直接组件故障验证：续期跨 TTL、持续非空桶、旧释放、失效不复活、模型隔离与真实流中止。 */
async function ttlCases(client: RespRedisClient, prefix: string, port: number, events: Event[]): Promise<string[]> {
  const passed: string[] = [];
  const request = { ownerId: 'TTL-U', apiKey: 'TTL-K', modelId: 'M1' };
  const limiter = new RedisModelRateLimiter(client, { ...base, globalConcurrency: 1, keyPrefix: prefix });
  const first = await limiter.acquire(request);
  await delay(1450);
  assert.equal(first.signal?.aborted, false);
  await assert.rejects(limiter.acquire(request), { code: 'MODEL_RATE_LIMIT_EXCEEDED' });
  await first.release(); await first.release();
  const second = await limiter.acquire(request);
  await first.release();
  await assert.rejects(limiter.acquire(request), { code: 'MODEL_RATE_LIMIT_EXCEEDED' });
  await second.release();
  passed.push('调用跨过 TTL 自动续期、正常释放、重复旧释放不影响新许可');

  const old = await limiter.acquire(request);
  // 故障注入将自己的 score 置为过去，复现许可过期；不修改别的测试或业务键。
  await client.command('EVAL', "for i=1,3 do redis.call('ZADD',KEYS[i],0,ARGV[1]) end; return 1", '3', ...leaseKeys(prefix, request), old.leaseId!);
  const next = await limiter.acquire(request);
  await assert.rejects(old.renew!(), { code: 'MODEL_RATE_LIMIT_LEASE_LOST' });
  await old.release();
  await assert.rejects(limiter.acquire(request), { code: 'MODEL_RATE_LIMIT_EXCEEDED' });
  await next.release();
  passed.push('过期旧许可不能续期复活，迟到释放不能删除新许可');

  const continuous = new RedisModelRateLimiter(client, { ...base, globalConcurrency: 2, keyPrefix: prefix + 'continuous:' });
  const anchor = await continuous.acquire(request);
  for (let i = 0; i < 6; i++) {
    const rotating = await continuous.acquire(request);
    await assert.rejects(continuous.acquire(request), { code: 'MODEL_RATE_LIMIT_EXCEEDED' });
    await delay(220); await rotating.release();
  }
  assert.equal(anchor.signal?.aborted, false); await anchor.release();
  passed.push('持续非空桶跨 TTL，短调用轮换仍受合计上限控制');

  const scoped = new RedisModelRateLimiter(client, { ...base, apiKeyConcurrency: 1, userConcurrency: 1, keyPrefix: prefix + 'model:' });
  const m1 = await scoped.acquire(request);
  const m2 = await scoped.acquire({ ...request, modelId: 'M2' });
  await assert.rejects(scoped.acquire(request), { code: 'MODEL_RATE_LIMIT_EXCEEDED' });
  await m1.release(); await m2.release();
  const globallyScoped = new RedisModelRateLimiter(client, { ...base, globalConcurrency: 1, keyPrefix: prefix + 'global-model:' });
  const global = await globallyScoped.acquire(request);
  await assert.rejects(globallyScoped.acquire({ ...request, modelId: 'M2' }), { code: 'MODEL_RATE_LIMIT_EXCEEDED' });
  await global.release();
  passed.push('凭据及用户按模型分桶，全局并发跨模型共享');

  const egress = await testEgress(port);
  let broken = false;
  const injected = { command: async (...args: string[]) => {
    if (broken) throw new Error('仅注入限流 Redis 连接故障，队列 Redis 保持可用');
    return client.command(...args);
  } };
  const faultLimiter = new RedisModelRateLimiter(injected as RespRedisClient, { ...base, globalConcurrency: 1, keyPrefix: prefix + 'fault:' });
  const fixture: Fixture = { id: randomUUID(), scene: 'G', round: 0, phase: 0, wave: 0, key: 'TTL-K', user: 'TTL-U', model: 'M1', target: true, holdMs: 5000, prefix, submittedAt: Date.now() };
  let lease: ModelRateLimitLease | undefined;
  const gateway = new OpenAiCompatibleModelGateway({ postOpenAiCompatibleSse: async (input) => egress.postOpenAiCompatibleSse({ ...input, payload: { ...(input.payload as object), test_fixture: { ...fixture, worker: 'fault', leaseId: lease?.leaseId } } }) }, 0, undefined, { acquire: async (identity) => { lease = await faultLimiter.acquire(identity); return lease; } });
  const call = gateway.complete({ agentRunId: fixture.id, connection: { ...request, connectionId: 'test', baseUrl: 'https://api.example.com' }, messages: [{ role: 'user', content: '流中止验证' }] });
  const rejected = assert.rejects(call, { code: 'MODEL_RATE_LIMIT_UNAVAILABLE' });
  await until(() => events.some((event) => event.type === 'start' && event.id === fixture.id), '故障注入前实际 SSE 已建立');
  const faultAt = Date.now(); broken = true;
  await rejected;
  await until(() => events.some((event) => event.type === 'end' && event.id === fixture.id), '实际 HTTPS SSE 连接中止');
  const ended = events.find((event) => event.type === 'end' && event.id === fixture.id)!;
  assert.equal(ended.code, 'ABORTED'); assert(ended.at - faultAt < 1000, '应在 TTL 前关闭测试连接');
  await assert.rejects(faultLimiter.acquire(request), { code: 'MODEL_RATE_LIMIT_UNAVAILABLE' });
  broken = false; await delay(1100);
  const recovered = await faultLimiter.acquire(request); await recovered.release();
  passed.push('续期 Redis 故障中止真实 HTTPS SSE、后续获取 fail-closed、TTL 后恢复');
  return passed;
}

/** 仅为测试故障注入定位自己许可的三个脱敏桶。 */
function leaseKeys(prefix: string, request: { ownerId: string; apiKey: string; modelId: string }): string[] {
  return [prefix + 'leases:v2:global', prefix + 'leases:v2:key:' + hashScope(request.apiKey, request.modelId), prefix + 'leases:v2:user:' + hashScope(request.ownerId, request.modelId)];
}

/** 生成故障注入所需的测试身份桶摘要，与公开的组合分桶契约一致。 */
function hashScope(identity: string, model: string): string {
  return createHash('sha256').update(identity + '\u0000' + model).digest('hex');
}

/** 子进程持有许可后可被父进程杀死，用真实进程退出验证 TTL 回收。 */
async function crashChild(): Promise<void> {
  const client = new RespRedisClient({ url: redisUrl! });
  const lease = await new RedisModelRateLimiter(client, { ...base, globalConcurrency: 1, keyPrefix: process.env.LIMIT_TEST_CRASH_PREFIX! }).acquire({ ownerId: 'crash', apiKey: 'crash', modelId: 'M1' });
  process.send?.({ type: 'held', leaseId: lease.leaseId });
  setInterval(() => {}, 1000);
}

/** 父进程运行全部场景，输出可复核报告，并只清理自己随机命名空间中的队列和键。 */
async function main(): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const prefix = 'learncraft:limit-test:' + runId + ':';
  const output = resolve('test-results/rate-limit', runId);
  await mkdir(output, { recursive: true });
  const events: Event[] = [];
  const rows: ReturnType<typeof verify>[] = [];
  const client = new RespRedisClient({ url: redisUrl! });
  const config = queueConfig(prefix + 'queue:');
  const queue = new Queue(config.queueName, { connection: config.connection, prefix: config.prefix });
  const model = await modelServer(events);
  const children: ChildProcess[] = [];
  const boundaries: string[] = [];
  const startedAt = new Date().toISOString();
  let failure: string | null = null;
  try {
    for (const worker of ['A', 'B']) {
      const child = fork(fileURLToPath(import.meta.url), ['--worker', worker], { env: { ...process.env, LIMIT_TEST_PORT: String(model.port), LIMIT_TEST_QUEUE_PREFIX: config.prefix }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      child.on('message', (message: WorkerMessage) => events.push(message)); children.push(child);
    }
    await until(() => events.filter((event) => event.type === 'online').length === 2, '两个独立 Worker 上线');
    assert.notEqual(events.find((event) => event.worker === 'A')?.pid, events.find((event) => event.worker === 'B')?.pid);
    /** 创建一轮三波负载：并发场景响应跨 TTL，RPM 场景保持短响应。 */
    const runScene = async (scene: Scene, round: number, phase: number): Promise<void> => {
      for (let wave = 0; wave < 3; wave++) {
        const fixtures: Fixture[] = Array.from({ length: 8 }, (_, index) => {
          const target = scene === 'G' || index < 6;
          return {
            id: randomUUID(), scene, round, phase, wave, target,
            key: scene === 'U-C' || scene === 'U-R' ? 'K' + index : target ? 'K1' : 'K2',
            user: scene === 'K-C' || scene === 'K-R' ? 'U' + index : target ? 'U1' : 'U2',
            model: 'M1', holdMs: scene.endsWith('R') ? 100 : 1450,
            prefix: prefix + scene + ':' + round + ':', submittedAt: Date.now(),
          };
        });
        await runBatch(queue, children, events, fixtures, !scene.endsWith('R') || wave === 0);
      }
      rows.push(verify(events, scene, round, phase));
      console.log(scene, '轮', round, '窗口阶段', phase, '通过');
    };
    for (let round = 1; round <= 3; round++) for (const scene of ['G', 'K-C', 'U-C'] as const) await runScene(scene, round, 1);
    // 两个 RPM 场景、三轮使用独立命名空间，但各自在相邻窗口复用同一个前缀。
    let now = await redisNow(client);
    if (now % 60000 > 45000) await delay(60000 - now % 60000 + 150);
    const firstWindow = Math.floor(await redisNow(client) / 60000);
    for (let round = 1; round <= 3; round++) for (const scene of ['K-R', 'U-R'] as const) await runScene(scene, round, 1);
    assert(rows.filter((row) => row.scene.endsWith('R')).every((row) => row.windows[0] === firstWindow));
    now = await redisNow(client);
    console.log('等待 Redis 固定分钟窗口切换，剩余毫秒', 60000 - now % 60000);
    await delay(60000 - now % 60000 + 150);
    for (let round = 1; round <= 3; round++) for (const scene of ['K-R', 'U-R'] as const) await runScene(scene, round, 2);
    assert(rows.filter((row) => row.scene.endsWith('R') && row.phase === 2).every((row) => row.windows[0] === firstWindow + 1));
    boundaries.push(...await ttlCases(client, prefix + 'ttl:', model.port, events));
    const crashPrefix = prefix + 'crash:';
    const child = fork(fileURLToPath(import.meta.url), ['--crash'], { env: { ...process.env, LIMIT_TEST_CRASH_PREFIX: crashPrefix }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    children.push(child);
    let held = false; child.on('message', () => { held = true; });
    await until(() => held, '崩溃进程持有许可');
    const crashLimiter = new RedisModelRateLimiter(client, { ...base, globalConcurrency: 1, keyPrefix: crashPrefix });
    const identity = { ownerId: 'crash', apiKey: 'crash', modelId: 'M1' };
    await assert.rejects(crashLimiter.acquire(identity), { code: 'MODEL_RATE_LIMIT_EXCEEDED' });
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGKILL'); await exited; await delay(1150);
    const recovered = await crashLimiter.acquire(identity); await recovered.release();
    boundaries.push('真实持许可进程 SIGKILL 后，TTL 到期重新获取成功');
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    process.exitCode = 1;
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise<void>((done) => child.once('exit', () => done()));
        child.kill('SIGTERM'); await exit;
      }
    }
    await queue.obliterate({ force: true }); await queue.close();
    await client.command('EVAL', "local keys=redis.call('KEYS',ARGV[1]); for _,k in ipairs(keys) do redis.call('DEL',k) end; return #keys", '0', prefix + '*');
    await client.close(); model.server.closeAllConnections();
    await new Promise<void>((done) => model.server.close(() => done()));
    const report = {
      runId, startedAt, finishedAt: new Date().toISOString(), status: failure ? '失败或覆盖不足' : '通过', failure,
      environment: { node: process.version, workers: events.filter((event) => event.type === 'online'), concurrencyPerWorker: 4, leaseTtlSeconds: 1, requestRetries: 0, fallback: false, model: '本机 HTTPS SSE 夹具', scope: '真实 BullMQ 双进程 + 模型网关 + Redis；不含 PostgreSQL Outbox、业务工作流及长短分池对比', prefix },
      scenes: rows, boundaries,
    };
    await writeFile(resolve(output, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const table = rows.map((row) => `| ${row.scene} | ${row.round}/${row.phase} | ${row.tasks} | ${row.peak} | ${row.targetGranted} | ${row.windows.join(',')} | ${row.rejected} | ${row.requestsA}/${row.requestsB} | ${row.completionMs.n} | ${row.completionMs.p95}/${row.completionMs.p99} | ${row.violations} |`).join('\n');
    await writeFile(resolve(output, 'report.md'), `# 双 Worker 限流实测报告\n\n- 状态：${report.status}\n- 时间：${startedAt} 至 ${report.finishedAt}\n- Node：${process.version}；两个独立进程各 4 个槽位；TTL 1 秒\n- 并发场景模型保持 1450ms；RPM 场景保持 100ms；重试 0，无备用模型\n- 范围：${report.environment.scope}\n\n| 场景 | 轮/窗口阶段 | 任务 | 目标并发峰值 | 目标许可数 | 分钟窗口 | 拒绝 | A/B请求 | 成功样本 | 完成P95/P99毫秒 | 越界 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${table}\n\n## TTL 与故障边界\n\n${boundaries.map((item) => '- 通过：' + item).join('\n')}\n\n## 指标解释\n\n完成耗时从测试入队提交开始至网关结束，包含人为双进程屏障等待；按成功样本及就近秩法计算。模型耗时另见 report.json。小样本 P99 接近最大值，只用于复核，不是用户请求延迟、真实模型性能或容量承诺。限流正确性由逐请求并发和实际 Lua 窗口校验决定。\n\n${failure ? '## 失败信息\n\n```text\n' + failure + '\n```\n' : ''}`);
    console.log('报告目录', output, '结果', report.status);
  }
}

// 入口只选择当前进程职责；父子进程共用同一打包产物。
if (process.argv[2] === '--worker') await workerMain();
else if (process.argv[2] === '--crash') await crashChild();
else await main();
