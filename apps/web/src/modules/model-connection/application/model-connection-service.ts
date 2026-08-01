/**
 * 用户模型连接的应用服务。
 *
 * 导出：
 * - ModelConnectionService：创建、列表、更新、设为默认和删除用户自带模型连接。
 */

import {
  CredentialCryptoConfigurationError,
  encryptCredential,
} from "@/lib/security/credential-crypto";

import {
  ModelConnectionApplicationError,
  type ModelConnectionCredentialEncryptor,
  type ModelConnectionRepository,
  type ModelConnectionSnapshot,
  normalizeOpenAiCompatibleBaseUrl,
} from "../domain/model-connection";

export interface CreateModelConnectionInput {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  defaultModelId: string;
  isDefault: boolean;
}

export interface UpdateModelConnectionInput {
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModelId?: string;
}

export class ModelConnectionService {
  constructor(
    private readonly repository: ModelConnectionRepository,
    private readonly credentialEncryptor: ModelConnectionCredentialEncryptor,
  ) {}

  async create(ownerId: string, input: CreateModelConnectionInput): Promise<ModelConnectionSnapshot> {
    try {
      return await this.repository.create({
        ownerId,
        displayName: input.displayName.trim(),
        baseUrl: normalizeOpenAiCompatibleBaseUrl(input.baseUrl),
        defaultModelId: input.defaultModelId.trim(),
        isDefault: input.isDefault,
        ...this.credentialEncryptor.encrypt(input.apiKey, ownerId),
      });
    } catch (error) {
      throw mapModelConnectionError(error);
    }
  }

  async list(ownerId: string): Promise<ModelConnectionSnapshot[]> {
    return this.repository.listOwned(ownerId);
  }

  async update(
    ownerId: string,
    connectionId: string,
    input: UpdateModelConnectionInput,
  ): Promise<ModelConnectionSnapshot> {
    try {
      const updatedConnection = await this.repository.updateOwned(ownerId, connectionId, {
        ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: normalizeOpenAiCompatibleBaseUrl(input.baseUrl) } : {}),
        ...(input.defaultModelId !== undefined ? { defaultModelId: input.defaultModelId.trim() } : {}),
        ...(input.apiKey !== undefined ? {
          credential: this.credentialEncryptor.encrypt(input.apiKey, ownerId),
        } : {}),
      });

      if (!updatedConnection) {
        throw new ModelConnectionApplicationError("MODEL_CONNECTION_NOT_FOUND");
      }

      return updatedConnection;
    } catch (error) {
      throw mapModelConnectionError(error);
    }
  }

  async setDefault(ownerId: string, connectionId: string): Promise<ModelConnectionSnapshot> {
    const connection = await this.repository.setDefaultOwned(ownerId, connectionId);
    if (!connection) {
      throw new ModelConnectionApplicationError("MODEL_CONNECTION_NOT_FOUND");
    }

    return connection;
  }

  async delete(ownerId: string, connectionId: string): Promise<void> {
    const deleted = await this.repository.deleteOwned(ownerId, connectionId);
    if (!deleted) {
      throw new ModelConnectionApplicationError("MODEL_CONNECTION_NOT_FOUND");
    }
  }
}

export class ServerCredentialEncryptor implements ModelConnectionCredentialEncryptor {
  encrypt(apiKey: string, ownerId: string) {
    const encrypted = encryptCredential(apiKey, ownerId);
    return {
      encryptedApiKey: encrypted.ciphertext,
      apiKeyIv: encrypted.iv,
      apiKeyAuthTag: encrypted.authTag,
      encryptionKeyVersion: encrypted.encryptionKeyVersion,
    };
  }
}

function mapModelConnectionError(error: unknown): Error {
  if (error instanceof ModelConnectionApplicationError) {
    return error;
  }
  if (error instanceof CredentialCryptoConfigurationError) {
    return new ModelConnectionApplicationError("CREDENTIAL_ENCRYPTION_UNAVAILABLE");
  }
  if (isUniqueConstraintViolation(error)) {
    return new ModelConnectionApplicationError("MODEL_CONNECTION_NAME_CONFLICT");
  }

  return error instanceof Error ? error : new Error("保存模型连接时发生未知错误。");
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505";
}
