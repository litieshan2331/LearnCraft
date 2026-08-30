/**
 * 节点知识内容查询应用服务单元测试。
 *
 * 测试：
 * - CardContentQueryService：返回当前用户拥有的 ready 节点内容。
 * - CardContentQueryService：内容不可见或未成功时返回稳定错误码。
 */

import { describe, expect, it } from "vitest";

import {
  CardContentQueryServiceError,
  type CardContentQueryRepository,
  type CardContentSnapshot,
} from "../domain/content-query";
import { CardContentQueryService } from "./card-content-query-service";

const ownerId = "d8418b49-5ca9-4aeb-b6e0-25b35b17fb8f";
const cardContentId = "04d90a58-a556-45d2-9e63-108e2a261d58";

const content: CardContentSnapshot = {
  id: cardContentId,
  planNodeId: "1c6a5f2b-88e7-489f-9a8f-03b1d1f95840",
  version: 1,
  status: "ready",
  schemaVersion: "card_content.v1",
  foundation: "变量用于保存程序运行过程中的值。",
  workedExample: {
    explanation: "计算两个数的平均值。",
    code: "print((10 + 14) / 2)",
    call_sequence: ["计算", "打印"],
    expected_output: "12.0",
  },
  pitfallsDebug: [{ title: "字符串参与计算", cause: "输入值实际是字符串。", fix: "在计算前进行类型转换。" }],
  sourceRefs: [],
  createdAt: new Date("2026-08-27T00:00:00.000Z"),
  updatedAt: new Date("2026-08-27T00:00:00.000Z"),
  generatedAt: new Date("2026-08-27T00:00:00.000Z"),
};

class FakeCardContentQueryRepository implements CardContentQueryRepository {
  available = true;

  async findOwnedReadyContent() {
    return this.available ? content : null;
  }
}

describe("CardContentQueryService", () => {
  it("读取当前用户拥有的 ready 内容", async () => {
    const service = new CardContentQueryService(new FakeCardContentQueryRepository());

    await expect(service.getOwnedReadyContent(ownerId, cardContentId)).resolves.toEqual(content);
  });

  it("内容不存在、未成功或不属于当前用户时返回统一错误码", async () => {
    const repository = new FakeCardContentQueryRepository();
    repository.available = false;
    const service = new CardContentQueryService(repository);

    await expect(service.getOwnedReadyContent(ownerId, cardContentId))
      .rejects.toMatchObject({ code: "CARD_CONTENT_NOT_FOUND" } satisfies Partial<CardContentQueryServiceError>);
  });
});
