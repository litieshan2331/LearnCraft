/**
 * Profile HTTP 输入契约的单元测试。
 *
 * 测试：
 * - learningGoalCreateRequestSchema：接受任意非空程序员技术主题。
 * - learningGoalCreateRequestSchema：拒绝已废弃的 subject_key 和空白主题。
 */

import { describe, expect, it } from "vitest";

import { learningGoalCreateRequestSchema } from "./profile-schemas";

const goalInput = {
  topic: "  Go 并发编程  ",
  title: "掌握 Go 并发",
  description: "学习 goroutine、channel 和 context。",
  desired_outcome: "完成一个带取消机制的并发下载器。",
};

describe("learningGoalCreateRequestSchema", () => {
  it("接受并规范化用户填写的自由技术主题", () => {
    const result = learningGoalCreateRequestSchema.safeParse(goalInput);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.topic).toBe("Go 并发编程");
    }
  });

  it("拒绝已废弃的 subject_key 和空白主题", () => {
    expect(learningGoalCreateRequestSchema.safeParse({
      ...goalInput,
      topic: "",
      subject_key: "python-311-basics",
    }).success).toBe(false);
  });
});
