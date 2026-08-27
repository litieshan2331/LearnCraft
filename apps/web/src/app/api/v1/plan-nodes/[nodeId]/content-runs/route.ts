/**
 * 学习节点的 card_content_generate AgentRun 创建 Route Handler。
 *
 * 函数：
 * - POST：为当前有效路线中的节点创建知识内容生成任务。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getCardContentGenerationService } from "@/modules/content/infrastructure/card-content-generation-service-factory";
import { CardContentGenerationApplicationError } from "@/modules/content/domain/content-generation";
import { cardContentGenerationErrorResponse } from "@/modules/content/interfaces/card-content-generation-http";
import { cardContentGenerationRequestSchema } from "@/modules/content/interfaces/card-content-generation-schemas";
import {
  agentRunErrorResponse,
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import { presentAgentRun } from "@/modules/agent-run/interfaces/agent-run-presenter";
import {
  assertAllowedWriteOrigin,
  malformedJsonResponse,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";
import { idempotencyKeyErrorResponse, idempotencyKeySchema } from "@/modules/profile/interfaces/profile-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ nodeId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  const idempotencyKey = request.headers.get("Idempotency-Key");
  const parsedIdempotencyKey = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!parsedIdempotencyKey.success) {
    return idempotencyKeyErrorResponse();
  }

  const { nodeId } = await context.params;
  const parsedNodeId = z.uuid().safeParse(nodeId);
  if (!parsedNodeId.success) {
    return validationErrorResponse(parsedNodeId.error);
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return malformedJsonResponse();
  }
  const parsedInput = cardContentGenerationRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
  }

  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const result = await getCardContentGenerationService().request({
      ownerId: authentication.ownerId,
      planNodeId: parsedNodeId.data,
      idempotencyKey: parsedIdempotencyKey.data,
    });

    return applyAgentRunSessionRenewal(
      NextResponse.json(presentAgentRun(result.agentRun), { status: result.created ? 202 : 200 }),
      authentication,
    );
  } catch (error) {
    if (error instanceof CardContentGenerationApplicationError) {
      return cardContentGenerationErrorResponse(error);
    }
    return agentRunErrorResponse(error);
  }
}
