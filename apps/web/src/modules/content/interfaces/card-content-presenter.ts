/**
 * 节点知识内容公开响应映射器。
 *
 * 导出：
 * - presentCardContent：仅返回可供学习者阅读的内容和来源引用；示例代码的预渲染 html 由调用方（读取接口）传入。
 */

import type {
  CardContentSnapshot,
  CardContentWorkedExampleView,
} from "../domain/content-query";

/**
 * 示例区块的对外形状：files 一个文件一个元素并带上服务端预渲染的 html，call_sequence 对象化，
 * expected_output 保持字符串（v2 刻意不对象化）。
 */
function presentWorkedExample(
  workedExample: CardContentWorkedExampleView,
  fileHtml: ReadonlyMap<string, string>,
) {
  return {
    explanation: workedExample.explanation,
    files: workedExample.files.map((file) => ({
      path: file.path,
      language: file.language,
      role: file.role,
      content: file.content,
      html: fileHtml.get(file.path) ?? "",
    })),
    entry_file: workedExample.entryFile,
    call_sequence: workedExample.callSequence.map((step) => ({
      step: step.step,
      file: step.file,
      function: step.function,
      note: step.note,
    })),
    expected_output: workedExample.expectedOutput,
  };
}

export function presentCardContent(
  content: CardContentSnapshot,
  fileHtml: ReadonlyMap<string, string>,
) {
  return {
    id: content.id,
    plan_node_id: content.planNodeId,
    version: content.version,
    status: content.status,
    schema_version: content.schemaVersion,
    foundation: content.foundation,
    worked_example: presentWorkedExample(content.workedExample, fileHtml),
    pitfalls_debug: content.pitfallsDebug,
    source_refs: content.sourceRefs,
    created_at: content.createdAt.toISOString(),
    updated_at: content.updatedAt.toISOString(),
    generated_at: content.generatedAt?.toISOString() ?? null,
  };
}