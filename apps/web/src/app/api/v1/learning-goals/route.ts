/**
 * 学习目标创建 Route Handler。
 *
 * 函数：
 * - GET：读取当前登录用户的学习目标列表及每个目标最新前测摘要。
 * - POST：保存当前画像版本下的自定义主题学习目标，并用 Idempotency-Key 防止重复创建。
 */

import { NextResponse } from "next/server";

import { getProfileService } from "@/modules/profile/infrastructure/profile-service-factory";
import {
  applyProfileSessionRenewal,
  authenticateProfileRequest,
  idempotencyKeyErrorResponse,
  profileErrorResponse,
} from "@/modules/profile/interfaces/profile-http";
import {
  presentLearningGoal,
  presentLearningGoalListItem,
} from "@/modules/profile/interfaces/profile-presenter";
import {
  idempotencyKeySchema,
  learningGoalCreateRequestSchema,
} from "@/modules/profile/interfaces/profile-schemas";
import {
  assertAllowedWriteOrigin,
  malformedJsonResponse,
  validationErrorResponse,
} from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const authentication = await authenticateProfileRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const goals = await getProfileService().listOwnedGoals(authentication.ownerId);
    return applyProfileSessionRenewal(
      NextResponse.json({ items: goals.map(presentLearningGoalListItem) }),
      authentication,
    );
  } catch (error) {
    return profileErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  const idempotencyKey = request.headers.get("Idempotency-Key");
  const parsedIdempotencyKey = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!parsedIdempotencyKey.success) {
    return idempotencyKeyErrorResponse();
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return malformedJsonResponse();
  }

  const parsedInput = learningGoalCreateRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
  }

  try {
    const authentication = await authenticateProfileRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const result = await getProfileService().createGoal({
      ownerId: authentication.ownerId,
      topic: parsedInput.data.topic,
      title: parsedInput.data.title,
      description: parsedInput.data.description,
      desiredOutcome: parsedInput.data.desired_outcome,
      targetDate: parsedInput.data.target_date,
      weeklyMinutesOverride: parsedInput.data.weekly_minutes_override,
      modelConnectionId: parsedInput.data.model_connection_id,
      idempotencyKey: parsedIdempotencyKey.data,
      requestHash: "",
    });

    return applyProfileSessionRenewal(
      NextResponse.json(presentLearningGoal(result.goal), { status: result.created ? 201 : 200 }),
      authentication,
    );
  } catch (error) {
    return profileErrorResponse(error);
  }
}
