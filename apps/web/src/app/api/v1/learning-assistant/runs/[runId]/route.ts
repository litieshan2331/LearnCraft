/**
 * 学习助手对话运行 Route Handler。
 *
 * 函数：GET 查询当前用户拥有的 queued/running/终态运行；不会触发执行或修改运行状态。
 */

import { NextResponse } from "next/server";

import { getLearningAssistantService } from "@/modules/learning-assistant/infrastructure/learning-assistant-service-factory";
import { presentRun } from "@/modules/learning-assistant/interfaces/learning-assistant-presenter";
import { runPathSchema } from "@/modules/learning-assistant/interfaces/learning-assistant-schemas";
import {
  applyLearningAssistantSessionRenewal,
  authenticateLearningAssistantRequest,
  learningAssistantErrorResponse,
} from "@/modules/learning-assistant/interfaces/learning-assistant-http";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

/** 返回当前用户可见的单个对话运行状态。 */
export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateLearningAssistantRequest(request);
    if (!authentication.authenticated) return authentication.response;
    const params = await context.params;
    const parsedParams = runPathSchema.safeParse({ run_id: params.runId });
    if (!parsedParams.success) {
      return applyLearningAssistantSessionRenewal(validationErrorResponse(parsedParams.error), authentication);
    }
    const run = await getLearningAssistantService().getRun(
      authentication.ownerId,
      parsedParams.data.run_id,
    );
    return applyLearningAssistantSessionRenewal(NextResponse.json(presentRun(run)), authentication);
  } catch (error) {
    return learningAssistantErrorResponse(error);
  }
}
