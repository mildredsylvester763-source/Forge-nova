import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JobStatus, Prisma, WorkGraphStatus, WorkNodeStatus, WorkNodeType, WorkRiskLevel } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AiRouterService } from '../ai/ai-router.service';
import { AccessControlService } from '../authorization/access-control.service';
import { SecretScannerService } from '../security/secret-scanner.service';
import { PrismaService } from '../database/prisma.service';
import { parseWorkPlan } from './work-plan-parser';

const PLANNING_LEASE_MS = 5 * 60 * 1000;

@Injectable()
export class WorkGraphPlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly ai: AiRouterService,
    private readonly secrets: SecretScannerService,
  ) {}

  async plan(userId: string, graphId: string, signal?: AbortSignal, jobId?: string) {
    await this.access.requireWorkGraphRole(userId, graphId, this.access.writeRoles());
    const graph = await this.prisma.workGraph.findUnique({
      where: { id: graphId },
      select: {
        id: true,
        applicationId: true,
        title: true,
        sourcePrompt: true,
        status: true,
        version: true,
        planningLeaseExpiresAt: true,
        nodes: { select: { id: true, key: true } },
      },
    });
    if (!graph) throw new NotFoundException('Work graph not found.');

    const now = new Date();
    if (
      graph.status === WorkGraphStatus.PLANNING &&
      graph.planningLeaseExpiresAt &&
      graph.planningLeaseExpiresAt > now
    ) {
      throw new ConflictException('This work graph is already being planned.');
    }
    if (
      graph.status !== WorkGraphStatus.DRAFT &&
      !(graph.status === WorkGraphStatus.PLANNING && (!graph.planningLeaseExpiresAt || graph.planningLeaseExpiresAt <= now))
    ) {
      throw new ConflictException('Only an unplanned draft work graph can be planned.');
    }
    if (graph.nodes.length !== 1 || graph.nodes[0]?.key !== 'user-request') {
      throw new ConflictException('This work graph already contains plan nodes and cannot be replanned automatically.');
    }

    const planningToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + PLANNING_LEASE_MS);
    const claimed = await this.prisma.workGraph.updateMany({
      where: {
        id: graphId,
        version: graph.version,
        OR: [
          { status: WorkGraphStatus.DRAFT },
          { status: WorkGraphStatus.PLANNING, planningLeaseExpiresAt: { lte: now } },
          { status: WorkGraphStatus.PLANNING, planningLeaseExpiresAt: null },
        ],
      },
      data: {
        status: WorkGraphStatus.PLANNING,
        planningToken,
        planningLeaseExpiresAt: leaseExpiresAt,
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('The work graph changed concurrently. Reload it and retry.');
    }

    try {
      const result = await this.ai.complete({
        applicationId: graph.applicationId,
        operationId: `workgraph-plan:${graph.id}:v${graph.version + 1}`,
        systemPrompt: [
          'You are the requirements and execution-planning engine for GENESIS, an AI software factory.',
          'Convert the user request into a practical dependency-ordered work plan.',
          'Return only one JSON object. Do not use markdown fences or commentary.',
          'Required top-level shape: {"title":"...","nodes":[{"key":"stable-key","type":"ANALYSIS|GENERATE|MODIFY|BUILD|TEST|SECURITY_SCAN|DEPLOY|VERIFY|EXTERNAL_TOOL","title":"...","description":"...","dependsOnKeys":["earlier-node-key"],"input":{}}]}.',
          'Create 3–15 useful nodes when the task warrants it; do not add meaningless steps merely to increase count. The schema accepts at most 30 nodes.',
          'Every dependency must reference another node key in this same plan. Never create cycles or self-dependencies.',
          'Do not include the reserved key user-request. The platform preserves the original request node automatically.',
          'Only include DEPLOY when deployment is explicitly requested. Deploy and external-tool steps require human approval by default.',
          'Do not invent credentials, external account access, provider keys, successful tests, or completed work.',
          'Use ANALYSIS, GENERATE, MODIFY, BUILD, TEST, SECURITY_SCAN, VERIFY, DEPLOY, or EXTERNAL_TOOL as the node type.',
          'Use concise titles and provide actionable descriptions. The plan is not evidence that any step has executed.',
        ].join('\n'),
        userPrompt: graph.sourcePrompt,
        maxOutputTokens: 5000,
        allowFallback: true,
        signal,
      });

      if (signal?.aborted) throw new ConflictException('Work graph planning was cancelled before the plan could be saved.');
      const plan = parseWorkPlan(result.text);
      this.secrets.assertNoSecrets(JSON.stringify(plan));

      return await this.prisma.$transaction(async (tx) => {
        if (signal?.aborted) throw new ConflictException('Work graph planning was cancelled before persistence.');
        const locked = await tx.workGraph.findFirst({
          where: {
            id: graphId,
            status: WorkGraphStatus.PLANNING,
            planningToken,
            planningLeaseExpiresAt: { gt: new Date() },
            application: {
              status: { not: 'ARCHIVED' },
              project: {
                status: 'ACTIVE',
                workspace: {
                  organization: {
                    memberships: {
                      some: { userId, role: { in: this.access.writeRoles() } },
                    },
                  },
                },
              },
            },
          },
          select: { id: true, applicationId: true },
        });
        if (!locked) throw new ConflictException('The planning lease expired or was replaced; no plan was saved.');
        if (jobId) {
          const activeJob = await tx.workJob.findFirst({
            where: {
              id: jobId,
              applicationId: graph.applicationId,
              status: JobStatus.RUNNING,
              cancelRequestedAt: null,
            },
            select: { id: true },
          });
          if (!activeJob) throw new ConflictException('The planning job is no longer active; no plan was saved.');
        }

        const root = await tx.workNode.findFirst({
          where: { graphId, key: 'user-request' },
          select: { id: true },
        });
        if (!root) throw new ConflictException('The immutable original-request node is missing.');

        const idsByKey = new Map<string, string>();
        for (const node of plan.nodes) {
          const riskLevel = this.riskForType(node.type);
          const created = await tx.workNode.create({
            data: {
              graphId,
              key: node.key,
              type: node.type as WorkNodeType,
              title: node.title,
              description: node.description ?? null,
              status: WorkNodeStatus.PENDING,
              riskLevel,
              requiresApproval: node.type === 'DEPLOY' || node.type === 'EXTERNAL_TOOL',
              input: (node.input ?? {}) as Prisma.InputJsonValue,
            },
            select: { id: true, key: true, title: true, type: true, status: true, riskLevel: true, requiresApproval: true },
          });
          idsByKey.set(node.key, created.id);
        }

        const edges: Array<{ fromNodeId: string; toNodeId: string }> = [];
        for (const node of plan.nodes) {
          const targetId = idsByKey.get(node.key);
          if (!targetId) throw new ConflictException('A planned node could not be resolved.');
          edges.push({ fromNodeId: root.id, toNodeId: targetId });
          for (const dependencyKey of node.dependsOnKeys) {
            const fromNodeId = idsByKey.get(dependencyKey);
            if (!fromNodeId) throw new ConflictException('A dependency could not be resolved.');
            edges.push({ fromNodeId, toNodeId: targetId });
          }
        }
        await tx.workDependency.createMany({ data: edges });

        if (signal?.aborted) throw new ConflictException('Work graph planning was cancelled before commit.');
        if (jobId) {
          const stillActive = await tx.workJob.findFirst({
            where: {
              id: jobId,
              applicationId: graph.applicationId,
              status: JobStatus.RUNNING,
              cancelRequestedAt: null,
            },
            select: { id: true },
          });
          if (!stillActive) throw new ConflictException('The planning job was cancelled; the plan was rolled back.');
        }
        const updated = await tx.workGraph.update({
          where: { id: graphId },
          data: {
            title: plan.title,
            status: WorkGraphStatus.READY,
            planningToken: null,
            planningLeaseExpiresAt: null,
            version: { increment: 1 },
          },
          select: {
            id: true,
            applicationId: true,
            title: true,
            status: true,
            version: true,
            nodes: {
              select: { id: true, key: true, type: true, title: true, status: true, riskLevel: true, requiresApproval: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
        return updated;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      try {
        await this.prisma.workGraph.updateMany({
          where: { id: graphId, status: WorkGraphStatus.PLANNING, planningToken },
          data: {
            status: WorkGraphStatus.DRAFT,
            planningToken: null,
            planningLeaseExpiresAt: null,
          },
        });
      } catch {
        // Preserve the original failure; a later request can recover an expired planning lease.
      }
      throw error;
    }
  }

  private riskForType(type: string): WorkRiskLevel {
    if (type === 'DEPLOY' || type === 'EXTERNAL_TOOL') return WorkRiskLevel.HIGH;
    if (type === 'SECURITY_SCAN' || type === 'BUILD' || type === 'TEST') return WorkRiskLevel.MEDIUM;
    return WorkRiskLevel.LOW;
  }
}
