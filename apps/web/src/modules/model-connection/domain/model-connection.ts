/**
 * 用户模型连接限界上下文的领域模型与端口。
 *
 * 导出：
 * - ModelConnectionRepository：用户模型连接的持久化端口。
 * - ModelConnectionCredentialEncryptor：API Key 的加密端口。
 * - ModelConnectionSnapshot：可安全返回浏览器的连接快照，不含 API Key。
 * - normalizeOpenAiCompatibleBaseUrl：规范化用户填写的 OpenAI-compatible Base URL。
 */

export const MODEL_CONNECTION_PROTOCOL = "openai_compatible";

export const MODEL_CONNECTION_STATUSES = ["active", "invalid", "revoked"] as const;

export type ModelConnectionStatus = (typeof MODEL_CONNECTION_STATUSES)[number];

export interface EncryptedModelCredential {
  encryptedApiKey: Buffer;
  apiKeyIv: Buffer;
  apiKeyAuthTag: Buffer;
  encryptionKeyVersion: string;
}

export interface ModelConnectionSnapshot {
  id: string;
  displayName: string;
  protocol: typeof MODEL_CONNECTION_PROTOCOL;
  baseUrl: string;
  defaultModelId: string;
  status: ModelConnectionStatus;
  isDefault: boolean;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateModelConnectionRecord extends EncryptedModelCredential {
  ownerId: string;
  displayName: string;
  baseUrl: string;
  defaultModelId: string;
  isDefault: boolean;
}

export interface UpdateModelConnectionRecord {
  displayName?: string;
  baseUrl?: string;
  defaultModelId?: string;
  credential?: EncryptedModelCredential;
}

export interface ModelConnectionRepository {
  create(input: CreateModelConnectionRecord): Promise<ModelConnectionSnapshot>;
  listOwned(ownerId: string): Promise<ModelConnectionSnapshot[]>;
  findOwned(ownerId: string, connectionId: string): Promise<ModelConnectionSnapshot | null>;
  updateOwned(
    ownerId: string,
    connectionId: string,
    input: UpdateModelConnectionRecord,
  ): Promise<ModelConnectionSnapshot | null>;
  setDefaultOwned(ownerId: string, connectionId: string): Promise<ModelConnectionSnapshot | null>;
  deleteOwned(ownerId: string, connectionId: string): Promise<boolean>;
}

export interface ModelConnectionCredentialEncryptor {
  encrypt(apiKey: string, ownerId: string): EncryptedModelCredential;
}

export type ModelConnectionApplicationErrorCode =
  | "MODEL_CONNECTION_NOT_FOUND"
  | "MODEL_CONNECTION_NAME_CONFLICT"
  | "INVALID_BASE_URL"
  | "CREDENTIAL_ENCRYPTION_UNAVAILABLE";

export class ModelConnectionApplicationError extends Error {
  constructor(public readonly code: ModelConnectionApplicationErrorCode) {
    super(code);
    this.name = "ModelConnectionApplicationError";
  }
}

export function normalizeOpenAiCompatibleBaseUrl(value: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.trim());
  } catch {
    throw new ModelConnectionApplicationError("INVALID_BASE_URL");
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new ModelConnectionApplicationError("INVALID_BASE_URL");
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new ModelConnectionApplicationError("INVALID_BASE_URL");
  }

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, "");
  parsedUrl.pathname = normalizedPath || "/";
  return parsedUrl.toString().replace(/\/$/, "");
}

export function isModelConnectionStatus(value: string): value is ModelConnectionStatus {
  return (MODEL_CONNECTION_STATUSES as readonly string[]).includes(value);
}
