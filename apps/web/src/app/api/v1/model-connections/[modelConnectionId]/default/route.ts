/**
 * 用户默认模型连接 Route Handler。
 *
 * 函数：
 * - POST：将当前用户拥有且处于 active 状态的连接设为账户默认连接。
 */

import { NextResponse } from "next/server";

import { getModelConnectionService } from "@/modules/model-connection/infrastructure/model-connection-service-factory";
import {
  applyModelConnectionSessionRenewal,
  authenticateModelConnectionRequest,
  modelConnectionErrorResponse,
} from "@/modules/model-connection/interfaces/model-connection-http";
import { presentModelConnection } from "@/modules/model-connection/interfaces/model-connection-presenter";
import { modelConnectionPathSchema } from "@/modules/model-connection/interfaces/model-connection-schemas";
import {
  assertAllowedWriteOrigin,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ modelConnectionId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  try {
    const authentication = await authenticateModelConnectionRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const params = await context.params;
    const parsedParams = modelConnectionPathSchema.safeParse({
      model_connection_id: params.modelConnectionId,
    });
    if (!parsedParams.success) {
      return applyModelConnectionSessionRenewal(
        validationErrorResponse(parsedParams.error),
        authentication,
      );
    }

    const connection = await getModelConnectionService().setDefault(
      authentication.ownerId,
      parsedParams.data.model_connection_id,
    );
    return applyModelConnectionSessionRenewal(
      NextResponse.json(presentModelConnection(connection)),
      authentication,
    );
  } catch (error) {
    return modelConnectionErrorResponse(error);
  }
}
