/**
 * 节点知识内容查询 Route Handler。
 *
 * 函数：
 * - GET：仅向内容所有者返回 ready 卡片的公开知识内容和来源引用。
 */

import { NextResponse } from "next/server";

import {
  applyAgentRunSessionRenewal,
  authenticateAgentRunRequest,
} from "@/modules/agent-run/interfaces/agent-run-http";
import { getCardContentQueryService } from "@/modules/content/infrastructure/card-content-query-service-factory";
import {
  cardContentPathSchema,
  cardContentQueryErrorResponse,
} from "@/modules/content/interfaces/card-content-query-http";
import { presentCardContent } from "@/modules/content/interfaces/card-content-presenter";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ cardContentId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateAgentRunRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const { cardContentId } = await context.params;
    const parsedParams = cardContentPathSchema.safeParse({ card_content_id: cardContentId });
    if (!parsedParams.success) {
      return applyAgentRunSessionRenewal(
        validationErrorResponse(parsedParams.error),
        authentication,
      );
    }

    const content = await getCardContentQueryService().getOwnedReadyContent(
      authentication.ownerId,
      parsedParams.data.card_content_id,
    );
    return applyAgentRunSessionRenewal(
      NextResponse.json(presentCardContent(content)),
      authentication,
    );
  } catch (error) {
    return cardContentQueryErrorResponse(error);
  }
}
