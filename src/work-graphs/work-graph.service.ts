import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  WorkGraphStatus,
  WorkNodeStatus,
  WorkNodeType,
  WorkRiskLevel,
} from '@prisma/client';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { SecretScannerService } from '../security/secret-scanner.service';
import { CreateWorkGraphDto } from './dto/create-work-graph.dto';
import { CreateWorkNodeDto } from './dto/create-work-node.dto';

@Injectable()
export class WorkGraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly secrets: SecretScannerService,
  ) {}

  async listForApplication(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.prisma.workGraph.findMany({
      where: { applicationId },
      select: {
        id: true,
        applicationId: true,
        title: true,
        status: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { nodes: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async create(userId: string, applicationId: string, dto: CreateWorkGraphDto) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    this.secrets.assertNoSecrets(dto.sourcePrompt);
    return this.prisma.workGraph.create({
      data: {
        applicationId,
        title: dto.title.trim(),
        sourcePrompt: dto.sourcePrompt.trim(),
        createdBy: userId,
        nodes: {
          create: {
            key: 'user-request',
            type: WorkNodeType.REQUIREMENT,
            title: 'Original user request',
            description: dto.sourcePrompt.trim(),
            status: WorkNodeStatus.SUCCEEDED,
            riskLevel: WorkRiskLevel.LOW,
            requiresApproval: false,
            input: { prompt: dto.sourcePrompt.trim() },
          },
        },
      },
      select: {
        id: true,
        applicationId: true,
        title: true,
        sourcePrompt: true,
        status: true,
        version: true,
        createdAt: true,
        nodes: {
          select: { id: true, key: true, type: true, status: true, title: true },
        },
      },
    });
  }

  async get(userId: string, graphId: string) {
    await this.access.requireWorkGraphRole(userId, graphId, this.access.allRoles());
    const graph = await this.prisma.workGraph.findUnique({
      where: { id: graphId },
      select: {
        id: true,
        applicationId: true,
        title: true,
        sourcePrompt: true,
        status: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        nodes: {
          select: {
            id: true,
            key: true,
            type: true,
            title: true,
            description: true,
            status: true,
            riskLevel: true,
            requiresApproval: true,
            input: true,
            output: true,
            attemptCount: true,
            createdAt: true,
            updatedAt: true,
            incomingDependencies: {
              select: { fromNodeId: true },
            },
            outgoingDependencies: {
              select: { toNodeId: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!graph) throw new NotFoundException('Work graph not found.');
    return graph;
  }

  async addNode(userId: string, graphId: string, dto: CreateWorkNodeDto) {
    const graph = await this.access.requireWorkGraphRole(
      userId,
      graphId,
      this.access.writeRoles(),
    );
    if (![WorkGraphStatus.DRAFT, WorkGraphStatus.READY].includes(graph.status)) {
      throw new ConflictException('Nodes cannot be added after graph execution has started.');
    }

    const inputJson = dto.input ?? {};
    const serializedInput = JSON.stringify(inputJson);
    this.secrets.assertNoSecrets(serializedInput);
    if (Buffer.byteLength(serializedInput, 'utf8') > 65536) {
      throw new BadRequestException('A work node input cannot exceed 64 KB.');
    }

    const dependencies = dto.dependsOnNodeIds ?? [];
    if (dependencies.length > 0) {
      const matching = await this.prisma.workNode.findMany({
        where: { graphId, id: { in: dependencies } },
        select: { id: true },
      });
      if (matching.length !== dependencies.length) {
        throw new BadRequestException('Every dependency must refer to a node in this work graph.');
      }
    }

    const riskLevel = this.riskForType(dto.type);
    const requiresApproval = dto.type === WorkNodeType.DEPLOY || dto.type === WorkNodeType.EXTERNAL_TOOL;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const node = await tx.workNode.create({
          data: {
            graphId,
            key: dto.key,
            type: dto.type,
            title: dto.title.trim(),
            description: dto.description?.trim() || null,
            input: inputJson as Prisma.InputJsonValue,
            riskLevel,
            requiresApproval,
          },
          select: {
            id: true,
            graphId: true,
            key: true,
            type: true,
            title: true,
            status: true,
            riskLevel: true,
            requiresApproval: true,
            createdAt: true,
          },
        });

        if (dependencies.length > 0) {
          await tx.workDependency.createMany({
            data: dependencies.map((fromNodeId) => ({
              fromNodeId,
              toNodeId: node.id,
            })),
          });
        }

        await tx.workGraph.update({
          where: { id: graphId },
          data: { version: { increment: 1 }, status: graph.status },
        });
        return node;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A work node with this key already exists in this graph.');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('The work graph changed concurrently. Reload it and retry.');
      }
      throw error;
    }
  }

  async validate(userId: string, graphId: string) {
    await this.access.requireWorkGraphRole(userId, graphId, this.access.allRoles());
    const nodes = await this.prisma.workNode.findMany({
      where: { graphId },
      select: {
        id: true,
        key: true,
        status: true,
        incomingDependencies: { select: { fromNodeId: true } },
        outgoingDependencies: { select: { toNodeId: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const nodeIds = new Set(nodes.map((node) => node.id));
    const adjacency = new Map<string, string[]>();
    let edgeCount = 0;
    for (const node of nodes) {
      adjacency.set(node.id, node.outgoingDependencies.map((edge) => edge.toNodeId));
      edgeCount += node.outgoingDependencies.length;
    }

    const state = new Map<string, 0 | 1 | 2>();
    const cycles: string[][] = [];
    const stack: string[] = [];
    const visit = (nodeId: string): void => {
      const currentState = state.get(nodeId) ?? 0;
      if (currentState === 2) return;
      if (currentState === 1) {
        const start = stack.indexOf(nodeId);
        cycles.push([...stack.slice(Math.max(start, 0)), nodeId]);
        return;
      }

      state.set(nodeId, 1);
      stack.push(nodeId);
      for (const next of adjacency.get(nodeId) ?? []) {
        if (nodeIds.has(next)) visit(next);
      }
      stack.pop();
      state.set(nodeId, 2);
    };
    for (const node of nodes) {
      if (!state.has(node.id)) visit(node.id);
    }

    const statusById = new Map(nodes.map((node) => [node.id, node.status]));
    const readyNodes = nodes
      .filter(
        (node) =>
          node.status === WorkNodeStatus.PENDING &&
          node.incomingDependencies.every((edge) =>
            statusById.get(edge.fromNodeId) === WorkNodeStatus.SUCCEEDED,
          ),
      )
      .map((node) => ({ id: node.id, key: node.key }));

    return {
      valid: cycles.length === 0,
      graphId,
      nodeCount: nodes.length,
      edgeCount,
      cycles,
      readyNodes,
    };
  }

  private riskForType(type: WorkNodeType): WorkRiskLevel {
    if (type === WorkNodeType.DEPLOY || type === WorkNodeType.EXTERNAL_TOOL) {
      return WorkRiskLevel.HIGH;
    }
    if (type === WorkNodeType.SECURITY_SCAN || type === WorkNodeType.BUILD || type === WorkNodeType.TEST) {
      return WorkRiskLevel.MEDIUM;
    }
    return WorkRiskLevel.LOW;
  }
}
