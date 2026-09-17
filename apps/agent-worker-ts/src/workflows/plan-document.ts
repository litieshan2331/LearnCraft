/**
 * 学习路线输出合同（等价于 Python plan_generate.py 中的 LearningPlanNode / LearningPlanDocument）。
 *
 * 职责：定义章节式学习路线的运行时校验，包含节点字段约束与整条路线的结构约束
 * （node_key 唯一、ordinal 从 1 连续编号、前置依赖存在且不自依赖、依赖图无环）。
 * 与 Web 内部接口 /plan-result 的 schema 保持一致；Web 才是最终写入方，这里提前失败以省掉一次往返。
 *
 * 与 Python 的差异：Python 的结构校验写在 model_validator 里，pydantic 的 loc 为空，
 * 因此 {`_validation_paths`} 最终只会得到 response.json；本实现用 zod 的问题路径给出更细的定位
 * （例如 nodes.0.node_key）。错误码与错误语义完全一致，仅诊断信息更细。
 *
 * 导出：
 * - PLAN_NODE_KEY_PATTERN：node_key 与前置依赖键共用的格式。
 * - LearningPlanNodeSchema / LearningPlanDocumentSchema：节点与整条路线的合同。
 * - LearningPlanNode / LearningPlanDocument：对应类型。
 * - hasPlanCycle：判断前置依赖图是否有环。
 * - planValidationPaths：把校验失败收敛为去重后的字段路径。
 */

import { z } from 'zod';

export const PLAN_NODE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

const nodeKeySchema = z.string().min(1).max(100).regex(PLAN_NODE_KEY_PATTERN);

export const LearningPlanNodeSchema = z
  .object({
    node_key: nodeKeySchema,
    ordinal: z.number().int().min(1).max(12),
    title: z.string().min(1).max(255),
    node_brief: z.string().min(1).max(2_000),
    learning_objective: z.string().min(1).max(2_000),
    rationale: z.string().min(1).max(2_000),
    difficulty: z.number().int().min(1).max(5),
    estimated_minutes: z.number().int().min(5).max(1_440),
    prerequisite_node_keys: z.array(nodeKeySchema).max(11),
    completion_criteria: z.array(z.string().min(1).max(1_000)).min(1).max(10),
  })
  .strict();

export const LearningPlanDocumentSchema = z
  .object({
    schema_version: z.literal('learning_plan.v1'),
    title: z.string().min(1).max(255),
    summary: z.string().min(1).max(2_000),
    nodes: z.array(LearningPlanNodeSchema).min(6).max(12),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    const ordinals = new Set<number>();
    for (const [index, node] of value.nodes.entries()) {
      if (keys.has(node.node_key)) {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'node_key'], message: 'node_key 必须唯一。' });
      }
      keys.add(node.node_key);
      if (ordinals.has(node.ordinal)) {
        context.addIssue({ code: 'custom', path: ['nodes', index, 'ordinal'], message: 'ordinal 必须唯一。' });
      }
      ordinals.add(node.ordinal);
    }

    for (let ordinal = 1; ordinal <= value.nodes.length; ordinal += 1) {
      if (!ordinals.has(ordinal)) {
        context.addIssue({ code: 'custom', path: ['nodes'], message: '章节 ordinal 必须从 1 连续编号。' });
        break;
      }
    }

    const prerequisitesByKey = new Map<string, string[]>();
    for (const [index, node] of value.nodes.entries()) {
      const seen = new Set<string>();
      for (const prerequisiteKey of node.prerequisite_node_keys) {
        if (seen.has(prerequisiteKey)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'prerequisite_node_keys'],
            message: '前置节点不能重复。',
          });
        }
        seen.add(prerequisiteKey);
        if (!keys.has(prerequisiteKey)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'prerequisite_node_keys'],
            message: '前置节点必须存在于当前路线。',
          });
        }
        if (prerequisiteKey === node.node_key) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'prerequisite_node_keys'],
            message: '节点不能依赖自身。',
          });
        }
      }
      prerequisitesByKey.set(node.node_key, [...node.prerequisite_node_keys]);
    }

    if (hasPlanCycle(prerequisitesByKey)) {
      context.addIssue({ code: 'custom', path: ['nodes'], message: '路线前置依赖必须无环。' });
    }
  });

export type LearningPlanNode = z.infer<typeof LearningPlanNodeSchema>;
export type LearningPlanDocument = z.infer<typeof LearningPlanDocumentSchema>;

/** 以深度优先遍历判断前置依赖图是否有环（与 Python 的 _has_cycle 等价）。 */
export function hasPlanCycle(prerequisitesByKey: ReadonlyMap<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (nodeKey: string): boolean => {
    if (visiting.has(nodeKey)) {
      return true;
    }
    if (visited.has(nodeKey)) {
      return false;
    }
    visiting.add(nodeKey);
    for (const prerequisiteKey of prerequisitesByKey.get(nodeKey) ?? []) {
      if (visit(prerequisiteKey)) {
        return true;
      }
    }
    visiting.delete(nodeKey);
    visited.add(nodeKey);
    return false;
  };

  for (const nodeKey of prerequisitesByKey.keys()) {
    if (visit(nodeKey)) {
      return true;
    }
  }
  return false;
}

/** 把 zod 校验失败收敛为去重后的字段路径；空路径按 response.json 处理。 */
export function planValidationPaths(error: z.ZodError): string[] {
  const paths: string[] = [];
  for (const issue of error.issues) {
    const path = issue.path.map((segment) => String(segment)).join('.');
    const effective = path.length > 0 ? path : 'response.json';
    if (!paths.includes(effective)) {
      paths.push(effective);
    }
  }
  return paths;
}
