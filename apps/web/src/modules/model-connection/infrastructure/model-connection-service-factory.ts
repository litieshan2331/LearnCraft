/**
 * 用户模型连接应用服务的基础设施装配入口。
 *
 * 导出：
 * - getModelConnectionService：复用 Drizzle repository 与服务端凭据加密器装配出的应用服务。
 */

import {
  ModelConnectionService,
  ServerCredentialEncryptor,
} from "../application/model-connection-service";
import { DrizzleModelConnectionRepository } from "./drizzle-model-connection-repository";

let modelConnectionService: ModelConnectionService | undefined;

export function getModelConnectionService(): ModelConnectionService {
  modelConnectionService ??= new ModelConnectionService(
    new DrizzleModelConnectionRepository(),
    new ServerCredentialEncryptor(),
  );

  return modelConnectionService;
}
