/**
 * 用户模型连接的 Drizzle 持久化适配器。
 *
 * 导出：
 * - DrizzleModelConnectionRepository：按用户隔离读写加密模型连接，并原子维护默认连接。
 */

import { and, asc, eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { userModelConnections } from "@/lib/db/schema";

import {
  isModelConnectionStatus,
  MODEL_CONNECTION_PROTOCOL,
  type CreateModelConnectionRecord,
  type ModelConnectionRepository,
  type ModelConnectionSnapshot,
  type UpdateModelConnectionRecord,
} from "../domain/model-connection";

type ModelConnectionRecord = typeof userModelConnections.$inferSelect;

export class DrizzleModelConnectionRepository implements ModelConnectionRepository {
  async create(input: CreateModelConnectionRecord): Promise<ModelConnectionSnapshot> {
    const database = getDatabase();

    return database.transaction(async (transaction) => {
      if (input.isDefault) {
        await transaction
          .update(userModelConnections)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(and(
            eq(userModelConnections.ownerId, input.ownerId),
            eq(userModelConnections.isDefault, true),
          ));
      }

      const [connection] = await transaction
        .insert(userModelConnections)
        .values({
          ownerId: input.ownerId,
          displayName: input.displayName,
          protocol: MODEL_CONNECTION_PROTOCOL,
          baseUrl: input.baseUrl,
          defaultModelId: input.defaultModelId,
          encryptedApiKey: input.encryptedApiKey.toString("base64"),
          apiKeyIv: input.apiKeyIv.toString("base64"),
          apiKeyAuthTag: input.apiKeyAuthTag.toString("base64"),
          encryptionKeyVersion: input.encryptionKeyVersion,
          status: "active",
          isDefault: input.isDefault,
        })
        .returning();

      if (!connection) {
        throw new Error("创建模型连接后未返回记录。");
      }

      return toSnapshot(connection);
    });
  }

  async listOwned(ownerId: string): Promise<ModelConnectionSnapshot[]> {
    const database = getDatabase();
    const connections = await database
      .select()
      .from(userModelConnections)
      .where(eq(userModelConnections.ownerId, ownerId))
      .orderBy(asc(userModelConnections.displayName));

    return connections.map(toSnapshot);
  }

  async findOwned(ownerId: string, connectionId: string): Promise<ModelConnectionSnapshot | null> {
    const database = getDatabase();
    const [connection] = await database
      .select()
      .from(userModelConnections)
      .where(and(
        eq(userModelConnections.id, connectionId),
        eq(userModelConnections.ownerId, ownerId),
      ))
      .limit(1);

    return connection ? toSnapshot(connection) : null;
  }

  async updateOwned(
    ownerId: string,
    connectionId: string,
    input: UpdateModelConnectionRecord,
  ): Promise<ModelConnectionSnapshot | null> {
    const database = getDatabase();
    const [connection] = await database
      .update(userModelConnections)
      .set({
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.defaultModelId !== undefined ? { defaultModelId: input.defaultModelId } : {}),
        ...(input.credential ? {
          encryptedApiKey: input.credential.encryptedApiKey.toString("base64"),
          apiKeyIv: input.credential.apiKeyIv.toString("base64"),
          apiKeyAuthTag: input.credential.apiKeyAuthTag.toString("base64"),
          encryptionKeyVersion: input.credential.encryptionKeyVersion,
          status: "active" as const,
          lastVerifiedAt: null,
          lastErrorCode: null,
        } : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(userModelConnections.id, connectionId),
        eq(userModelConnections.ownerId, ownerId),
      ))
      .returning();

    return connection ? toSnapshot(connection) : null;
  }

  async setDefaultOwned(ownerId: string, connectionId: string): Promise<ModelConnectionSnapshot | null> {
    const database = getDatabase();

    return database.transaction(async (transaction) => {
      const [existingConnection] = await transaction
        .select()
        .from(userModelConnections)
        .where(and(
          eq(userModelConnections.id, connectionId),
          eq(userModelConnections.ownerId, ownerId),
          eq(userModelConnections.status, "active"),
        ))
        .limit(1)
        .for("update");

      if (!existingConnection) {
        return null;
      }

      const now = new Date();
      await transaction
        .update(userModelConnections)
        .set({ isDefault: false, updatedAt: now })
        .where(and(
          eq(userModelConnections.ownerId, ownerId),
          eq(userModelConnections.isDefault, true),
        ));

      const [connection] = await transaction
        .update(userModelConnections)
        .set({ isDefault: true, updatedAt: now })
        .where(eq(userModelConnections.id, connectionId))
        .returning();

      return connection ? toSnapshot(connection) : null;
    });
  }

  async deleteOwned(ownerId: string, connectionId: string): Promise<boolean> {
    const database = getDatabase();
    const deletedConnections = await database
      .delete(userModelConnections)
      .where(and(
        eq(userModelConnections.id, connectionId),
        eq(userModelConnections.ownerId, ownerId),
      ))
      .returning({ id: userModelConnections.id });

    return deletedConnections.length === 1;
  }
}

function toSnapshot(connection: ModelConnectionRecord): ModelConnectionSnapshot {
  if (connection.protocol !== MODEL_CONNECTION_PROTOCOL || !isModelConnectionStatus(connection.status)) {
    throw new Error("数据库中存在不支持的模型连接协议或状态。");
  }

  return {
    id: connection.id,
    displayName: connection.displayName,
    protocol: connection.protocol,
    baseUrl: connection.baseUrl,
    defaultModelId: connection.defaultModelId,
    status: connection.status,
    isDefault: connection.isDefault,
    lastVerifiedAt: connection.lastVerifiedAt,
    lastErrorCode: connection.lastErrorCode,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}
