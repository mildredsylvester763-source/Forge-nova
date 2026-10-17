import { UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';

const planNodeSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
  type: z.enum(['ANALYSIS', 'GENERATE', 'MODIFY', 'BUILD', 'TEST', 'SECURITY_SCAN', 'DEPLOY', 'VERIFY', 'EXTERNAL_TOOL']),
  title: z.string().trim().min(1).max(160),
  description: z.string().max(10000).optional(),
  dependsOnKeys: z.array(z.string()).max(30).default([]),
  input: z.record(z.string(), z.unknown()).optional(),
}).strict();

const planSchema = z.object({
  title: z.string().trim().min(1).max(160),
  nodes: z.array(planNodeSchema).min(1).max(30),
}).strict();

export type ParsedWorkPlan = z.infer<typeof planSchema>;

export function parseWorkPlan(text: string): ParsedWorkPlan {
  const jsonText = text.trim().replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/, '');
  let decoded: unknown;
  try {
    decoded = JSON.parse(jsonText);
  } catch {
    throw new UnprocessableEntityException('The AI planner did not return valid JSON; no plan was saved.');
  }

  const parsed = planSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new UnprocessableEntityException({
      message: 'The AI planner output did not match the required work-plan schema.',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const plan = parsed.data;
  const keys = new Set<string>();
  for (const node of plan.nodes) {
    if (node.key === 'user-request') {
      throw new UnprocessableEntityException('The planner cannot replace the immutable original-request node.');
    }
    if (keys.has(node.key)) {
      throw new UnprocessableEntityException(`The planner returned a duplicate node key: ${node.key}.`);
    }
    keys.add(node.key);
  }

  const adjacency = new Map<string, string[]>();
  for (const node of plan.nodes) adjacency.set(node.key, []);
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOnKeys) {
      if (!keys.has(dependency)) {
        throw new UnprocessableEntityException(`Node ${node.key} references an unknown dependency: ${dependency}.`);
      }
      if (dependency === node.key) {
        throw new UnprocessableEntityException(`Node ${node.key} cannot depend on itself.`);
      }
      adjacency.get(dependency)?.push(node.key);
    }
  }

  const states = new Map<string, 0 | 1 | 2>();
  const visit = (key: string): boolean => {
    const state = states.get(key) ?? 0;
    if (state === 1) return false;
    if (state === 2) return true;
    states.set(key, 1);
    for (const next of adjacency.get(key) ?? []) {
      if (!visit(next)) return false;
    }
    states.set(key, 2);
    return true;
  };

  for (const key of keys) {
    if (!visit(key)) {
      throw new UnprocessableEntityException('The planner returned a cyclic dependency graph; no plan was saved.');
    }
  }

  return plan;
}
