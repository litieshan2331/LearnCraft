/**
 * Agent Worker 读取账户默认模型连接密文的内部 Route Handler。
 * 只通过共享服务密钥鉴权，不接受浏览器 Cookie 或客户端传入的 owner_id。
 */

import { timingSafeEqual } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getDatabase } from '@/lib/db/client';
import { agentRuns, userModelConnections } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ agentRunId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  if (!hasValidInternalSecret(request)) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  const params = await context.params;
  const parsedAgentRunId = z.uuid().safeParse(params.agentRunId);
  if (!parsedAgentRunId.success) {
    return NextResponse.json({ error: 'INVALID_AGENT_RUN_ID' }, { status: 400 });
  }

  const database = getDatabase();
  const [record] = await database
    .select({
      ownerId: agentRuns.ownerId,
      connectionId: userModelConnections.id,
      baseUrl: userModelConnections.baseUrl,
      modelId: userModelConnections.defaultModelId,
      encryptedApiKey: userModelConnections.encryptedApiKey,
      apiKeyIv: userModelConnections.apiKeyIv,
      apiKeyAuthTag: userModelConnections.apiKeyAuthTag,
      encryptionKeyVersion: userModelConnections.encryptionKeyVersion,
    })
    .from(agentRuns)
    .innerJoin(userModelConnections, and(
      eq(userModelConnections.ownerId, agentRuns.ownerId),
      eq(userModelConnections.status, 'active'),
      eq(userModelConnections.isDefault, true),
    ))
    .where(eq(agentRuns.id, parsedAgentRunId.data))
    .limit(1);

  if (!record) {
    return NextResponse.json({ error: 'DEFAULT_MODEL_CONNECTION_NOT_FOUND' }, { status: 404 });
  }

  return NextResponse.json({
    owner_id: record.ownerId,
    connection_id: record.connectionId,
    base_url: record.baseUrl,
    model_id: record.modelId,
    credential: {
      ciphertext_base64: record.encryptedApiKey,
      iv_base64: record.apiKeyIv,
      auth_tag_base64: record.apiKeyAuthTag,
      encryption_key_version: record.encryptionKeyVersion,
    },
  });
}

function hasValidInternalSecret(request: Request): boolean {
  const expected = process.env.INTERNAL_SERVICE_SECRET?.trim();
  const supplied = request.headers.get('x-learncraft-internal-secret')?.trim();
  if (!expected || !supplied) {
    return false;
  }
  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}
