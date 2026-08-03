/**
 * 用户模型连接 URL 规则的单元测试。
 *
 * 测试：
 * - normalizeOpenAiCompatibleBaseUrl：仅允许 HTTPS 公网域名，并拒绝 IP、回环、局域网和本地开发域名。
 */

import { describe, expect, it } from "vitest";

import {
  ModelConnectionApplicationError,
  normalizeOpenAiCompatibleBaseUrl,
} from "./model-connection";

describe("OpenAI-compatible Base URL", () => {
  it("规范化公网 Provider 地址", () => {
    expect(normalizeOpenAiCompatibleBaseUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com");
  });

  it.each([
    "http://127.0.0.1:8000",
    "http://api.deepseek.com",
    "http://192.168.1.8:8000",
    "http://172.20.0.2:8000",
    "http://10.0.0.2:8000",
    "http://localhost:11434",
    "http://model.local:8000",
    "http://[::1]:8000",
    "https://1.1.1.1",
    "https://[2606:4700:4700::1111]",
  ])("拒绝非 HTTPS 域名或本地地址：%s", (baseUrl) => {
    expect(() => normalizeOpenAiCompatibleBaseUrl(baseUrl)).toThrow(ModelConnectionApplicationError);
  });
});
