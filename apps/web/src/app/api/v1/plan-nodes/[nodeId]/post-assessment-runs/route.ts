/**
 * 学习节点的 posttest_generate AgentRun 创建 Route Handler。
 *
 * 函数：
 * - POST：为拥有 ready 内容的节点创建后测生成任务；完成标记只作个人记录。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { getPosttestGenerationService } from "@/modules/assessment/infrastructure/posttest-generation-service-factory";
import { posttestGenerationErrorResponse } from "@/modules/assessment/interfaces/posttest-generation-http";
import { posttestGenerationRequestSchema } from "@/modules/assessment/interfaces/posttest-generation-schemas";
import { PosttestGenerationApplicationError } from "@/modules/assessment/domain/posttest-generation";
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

  const parsedInput = posttestGenerationRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
  }

  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const result = await getPosttestGenerationService().request({
      ownerId: authentication.ownerId,
      planNodeId: parsedNodeId.data,
      questionCount: parsedInput.data.question_count,
      difficulty: parsedInput.data.difficulty,
      idempotencyKey: parsedIdempotencyKey.data,
    });

    return applyAgentRunSessionRenewal(
      NextResponse.json(presentAgentRun(result.agentRun), { status: result.created ? 202 : 200 }),
      authentication,
    );
  } catch (error) {
    if (error instanceof PosttestGenerationApplicationError) {
      return posttestGenerationErrorResponse(error);
    }
    return agentRunErrorResponse(error);
  }
}