/**
 * 学习者画像 Route Handler。
 *
 * 函数：
 * - GET：返回当前用户画像；首次尚未填写时返回 profile: null。
 * - PUT：校验同源与请求字段后，创建或更新当前用户画像。
 */

import { NextResponse } from "next/server";

import { getProfileService } from "@/modules/profile/infrastructure/profile-service-factory";
import {
  applyProfileSessionRenewal,
  authenticateProfileRequest,
  profileErrorResponse,
} from "@/modules/profile/interfaces/profile-http";
import { presentLearnerProfile } from "@/modules/profile/interfaces/profile-presenter";
import { learnerProfileUpsertRequestSchema } from "@/modules/profile/interfaces/profile-schemas";
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

    const profile = await getProfileService().getProfile(authentication.ownerId);
    return applyProfileSessionRenewal(NextResponse.json({
      profile: profile ? presentLearnerProfile(profile) : null,
    }), authentication);
  } catch (error) {
    return profileErrorResponse(error);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const originError = assertAllowedWriteOrigin(request);
  if (originError) {
    return originError;
  }

  const body = await request.json().catch(() => null);
  if (body === null) {
    return malformedJsonResponse();
  }

  const parsedInput = learnerProfileUpsertRequestSchema.safeParse(body);
  if (!parsedInput.success) {
    return validationErrorResponse(parsedInput.error);
  }

  try {
    const authentication = await authenticateProfileRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const profile = await getProfileService().saveProfile({
      ownerId: authentication.ownerId,
      currentLevel: parsedInput.data.current_level,
      weeklyMinutes: parsedInput.data.weekly_minutes,
      operatingSystem: parsedInput.data.operating_system,
      backgroundSummary: parsedInput.data.background_summary,
      contentPreference: parsedInput.data.content_preference,
    });
    return applyProfileSessionRenewal(
      NextResponse.json(presentLearnerProfile(profile)),
      authentication,
    );
  } catch (error) {
    return profileErrorResponse(error);
  }
}
