/**
 * 用户模型连接列表与创建 Route Handler。
 *
 * 函数：
 * - GET：返回当前用户的 OpenAI-compatible 连接快照，绝不返回 API Key。
 * - POST：校验同源和输入后，加密保存新的用户模型连接。
 */

import { NextResponse } from "next/server";

import { getModelConnectionService } from "@/modules/model-connection/infrastructure/model-connection-service-factory";
import {
  applyModelConnectionSessionRenewal,
  authenticateModelConnectionRequest,
  modelConnectionErrorResponse,
} from "@/modules/model-connection/interfaces/model-connection-http";
import { presentModelConnection } from "@/modules/model-connection/interfaces/model-connection-presenter";
import { createModelConnectionRequestSchema } from "@/modules/model-connection/interfaces/model-connection-schemas";
import {
  assertAllowedWriteOrigin,
  malformedJsonResponse,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const authentication = await authenticateModelConnectionRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const connections = await getModelConnectionService().list(authentication.ownerId);
    return applyModelConnectionSessionRenewal(NextResponse.json({
      items: connections.map(presentModelConnection),
    }), authentication);
  } catch (error) {
    return modelConnectionErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return malformedJsonResponse();
  }

  const parsedInput = createModelConnectionRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
  }

  try {
    const authentication = await authenticateModelConnectionRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const connection = await getModelConnectionService().create(authentication.ownerId, {
      displayName: parsedInput.data.display_name,
      baseUrl: parsedInput.data.base_url,
      apiKey: parsedInput.data.api_key,
      defaultModelId: parsedInput.data.default_model_id,
      isDefault: parsedInput.data.set_as_default,
    });
    return applyModelConnectionSessionRenewal(
      NextResponse.json(presentModelConnection(connection), { status: 201 }),
      authentication,
    );
  } catch (error) {
    return modelConnectionErrorResponse(error);
  }
}
