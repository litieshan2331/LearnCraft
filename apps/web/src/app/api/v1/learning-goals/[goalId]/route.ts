/**
 * 单个学习目标 Route Handler。
 *
 * 函数：
 * - GET：仅返回当前登录用户拥有的学习目标及其当前状态。
 */

import { NextResponse } from "next/server";

import { getProfileService } from "@/modules/profile/infrastructure/profile-service-factory";
import {
  applyProfileSessionRenewal,
  authenticateProfileRequest,
  profileErrorResponse,
} from "@/modules/profile/interfaces/profile-http";
import { presentLearningGoal } from "@/modules/profile/interfaces/profile-presenter";
import { learningGoalPathSchema } from "@/modules/profile/interfaces/profile-schemas";
import { validationErrorResponse } from "@/modules/identity/interfaces/auth-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ goalId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const authentication = await authenticateProfileRequest(request);
    if (!authentication.authenticated) {
      return authentication.response;
    }

    const params = await context.params;
    const parsedParams = learningGoalPathSchema.safeParse({ goal_id: params.goalId });
    if (!parsedParams.success) {
      return applyProfileSessionRenewal(validationErrorResponse(parsedParams.error), authentication);
    }

    const goal = await getProfileService().getOwnedGoal(
      authentication.ownerId,
      parsedParams.data.goal_id,
    );
    return applyProfileSessionRenewal(NextResponse.json(presentLearningGoal(goal)), authentication);
  } catch (error) {
    return profileErrorResponse(error);
  }
}
