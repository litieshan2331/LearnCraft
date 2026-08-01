/**
 * 单个用户模型连接的更新与删除 Route Handler。
 *
 * 函数：
 * - PATCH：更新名称、Base URL、默认模型或 API Key；新 Key 会重新加密。
 * - DELETE：删除当前用户拥有的连接，并解除目标和历史任务的可选关联。
 */

import { NextResponse } from "next/server";

import { getModelConnectionService } from "@/modules/model-connection/infrastructure/model-connection-service-factory";
import {
  applyModelConnectionSessionRenewal,
  authenticateModelConnectionRequest,
  modelConnectionErrorResponse,
} from "@/modules/model-connection/interfaces/model-connection-http";
import { presentModelConnection } from "@/modules/model-connection/interfaces/model-connection-presenter";
import {
  modelConnectionPathSchema,
  updateModelConnectionRequestSchema,
} from "@/modules/model-connection/interfaces/model-connection-schemas";
import {
  assertAllowedWriteOrigin,
  malformedJsonResponse,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ modelConnectionId: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return malformedJsonResponse();
  }

  const parsedInput = updateModelConnectionRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
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

    const connection = await getModelConnectionService().update(
      authentication.ownerId,
      parsedParams.data.model_connection_id,
      {
        ...(parsedInput.data.display_name !== undefined ? {
          displayName: parsedInput.data.display_name,
        } : {}),
        ...(parsedInput.data.base_url !== undefined ? { baseUrl: parsedInput.data.base_url } : {}),
        ...(parsedInput.data.api_key !== undefined ? { apiKey: parsedInput.data.api_key } : {}),
        ...(parsedInput.data.default_model_id !== undefined ? {
          defaultModelId: parsedInput.data.default_model_id,
        } : {}),
      },
    );
    return applyModelConnectionSessionRenewal(
      NextResponse.json(presentModelConnection(connection)),
      authentication,
    );
  } catch (error) {
    return modelConnectionErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
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

    await getModelConnectionService().delete(
      authentication.ownerId,
      parsedParams.data.model_connection_id,
    );
    return applyModelConnectionSessionRenewal(new NextResponse(null, { status: 204 }), authentication);
  } catch (error) {
    return modelConnectionErrorResponse(error);
  }
}
