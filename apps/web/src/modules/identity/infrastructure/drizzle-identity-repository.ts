/**
 * Identity 限界上下文的 Drizzle 持久化适配器。
 *
 * 导出：
 * - DrizzleIdentityRepository：读写 users、auth_sessions 与 learner_profiles 所需的认证数据。
 */

import { and, eq, gt, isNull, lte } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { authSessions, learnerProfiles, users } from "@/lib/db/schema";

import type {
  AuthenticatedUser,
  IdentityRepository,
  PasswordUser,
  SessionCreation,
  SessionRecord,
} from "../domain/authentication";

export class DrizzleIdentityRepository implements IdentityRepository {
  async findUserByEmail(email: string): Promise<PasswordUser | null> {
    const database = getDatabase();
    const [user] = await database
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
        status: users.status,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      return null;
    }

    return {
      ...user,
      status: user.status as PasswordUser["status"],
    };
  }

  async createUser(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<AuthenticatedUser> {
    const database = getDatabase();
    const [user] = await database
      .insert(users)
      .values({
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
      })
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
      });

    if (!user) {
      throw new Error("创建用户后未返回用户记录。");
    }

    return user;
  }

  async createSessionForUser(userId: string, session: SessionCreation, now: Date): Promise<void> {
    const database = getDatabase();

    await database.transaction(async (transaction) => {
      await transaction.insert(authSessions).values({
        userId,
        tokenHash: session.tokenHash,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        ipHash: session.ipHash,
        userAgent: session.userAgent,
      });

      await transaction
        .update(users)
        .set({ lastLoginAt: now })
        .where(eq(users.id, userId));
    });
  }

  async findActiveSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const database = getDatabase();
    const [session] = await database
      .select({
        sessionId: authSessions.id,
        expiresAt: authSessions.expiresAt,
        lastSeenAt: authSessions.lastSeenAt,
        createdAt: authSessions.createdAt,
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        profileUserId: learnerProfiles.userId,
      })
      .from(authSessions)
      .innerJoin(users, eq(authSessions.userId, users.id))
      .leftJoin(learnerProfiles, eq(learnerProfiles.userId, users.id))
      .where(and(
        eq(authSessions.tokenHash, tokenHash),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
        eq(users.status, "active"),
      ))
      .limit(1);

    if (!session) {
      return null;
    }

    return {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      createdAt: session.createdAt,
      id: session.id,
      email: session.email,
      displayName: session.displayName,
      profileCompleted: session.profileUserId !== null,
    };
  }

  async renewSession(input: {
    sessionId: string;
    expiresAt: Date;
    lastSeenAt: Date;
    renewalAllowedBefore: Date;
    now: Date;
  }): Promise<boolean> {
    const database = getDatabase();
    const updatedSessions = await database
      .update(authSessions)
      .set({
        expiresAt: input.expiresAt,
        lastSeenAt: input.lastSeenAt,
      })
      .where(and(
        eq(authSessions.id, input.sessionId),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, input.now),
        lte(authSessions.lastSeenAt, input.renewalAllowedBefore),
      ))
      .returning({ id: authSessions.id });

    return updatedSessions.length === 1;
  }

  async revokeSessionByTokenHash(tokenHash: string, now: Date): Promise<boolean> {
    const database = getDatabase();
    const revokedSessions = await database
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(
        eq(authSessions.tokenHash, tokenHash),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ))
      .returning({ id: authSessions.id });

    return revokedSessions.length === 1;
  }
}
