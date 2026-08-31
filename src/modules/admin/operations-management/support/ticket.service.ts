import { DatabaseService } from '@core/database';
import { Prisma } from '../../../../generated/prisma/index.js';
import { recordAdminAction } from '../../audit/index.js';
import type { PrismaTx } from '../operations.types.js';
import {
  SupportTicketNotFoundError,
  SupportAgentNotFoundError,
  SupportCategoryNotFoundError,
  OperationsValidationError,
} from '../operations.errors.js';
import type {
  ListSupportTicketsQuery,
  CreateSupportTicketBody,
  AssignTicketBody,
  UpdateTicketStatusBody,
  AddTicketMessageBody,
  ResolveTicketBody,
} from './ticket.schemas.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminSupportTicketListItemDto {
  id: string;
  ticketNumber: string;
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  slaDueAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  user: {
    id: string;
    fullName: string;
    phone: string;
    avatarUrl: string | null;
  };
  category: {
    id: string;
    code: string;
    name: string;
  } | null;
  assignedAgent: {
    id: string;
    displayName: string | null;
    status: string;
  } | null;
  ride: {
    id: string;
    rideCode: string;
    status: string;
    driverName: string | null;
    driverPhone: string | null;
  } | null;
  messagesCount: number;
}

export interface AdminSupportTicketDetailDto extends AdminSupportTicketListItemDto {
  reopenedCount: number;
  messages: Array<{
    id: string;
    body: string;
    isInternal: boolean;
    authorType: string;
    authorId: string | null;
    authorName: string | null;
    attachments: Prisma.JsonValue | null;
    createdAt: string;
  }>;
  assignments: Array<{
    id: string;
    agentId: string;
    agentName: string | null;
    assignedBy: string | null;
    reason: string | null;
    status: string;
    assignedAt: string;
    releasedAt: string | null;
  }>;
}

export class AdminTicketService {
  constructor(private readonly db: DatabaseService) {}

  private get client() {
    return this.db.client;
  }

  async list(query: ListSupportTicketsQuery): Promise<{
    data: AdminSupportTicketListItemDto[];
    meta: { page: number; limit: number; total: number; totalPages: number };
  }> {
    const page = Math.max(1, query.page);
    const limit = Math.max(1, Math.min(100, query.limit));
    const skip = (page - 1) * limit;

    const where: Prisma.SupportTicketWhereInput = {};

    if (query.status && query.status !== 'all') {
      where.status = query.status;
    }

    if (query.priority && query.priority !== 'all') {
      where.priority = query.priority;
    }

    if (query.categoryId) {
      where.categoryId = query.categoryId;
    }

    if (query.rideId) {
      where.rideId = query.rideId;
    }

    if (query.userId) {
      where.userId = query.userId;
    }

    if (query.assignedAgentId) {
      where.assignedAgentId = query.assignedAgentId;
    }

    if (query.search) {
      const s = query.search;
      where.OR = [
        { ticketNumber: { contains: s, mode: 'insensitive' } },
        { subject: { contains: s, mode: 'insensitive' } },
        { description: { contains: s, mode: 'insensitive' } },
        { user: { phoneNumber: { contains: s } } },
        { user: { profile: { firstName: { contains: s, mode: 'insensitive' } } } },
        { user: { profile: { lastName: { contains: s, mode: 'insensitive' } } } },
      ];
    }

    const [total, tickets] = await Promise.all([
      this.client.supportTicket.count({ where }),
      this.client.supportTicket.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            include: {
              profile: true,
            },
          },
          category: true,
          assignedAgent: {
            include: {
              user: {
                include: {
                  profile: true,
                },
              },
            },
          },
          ride: {
            include: {
              driver: {
                include: {
                  profile: true,
                  user: {
                    include: {
                      profile: true,
                    },
                  },
                },
              },
            },
          },
          _count: {
            select: {
              messages: true,
            },
          },
        },
      }),
    ]);

    const data: AdminSupportTicketListItemDto[] = tickets.map((t) => this.mapToListItemDto(t));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getById(idOrNumber: string): Promise<AdminSupportTicketDetailDto> {
    const isUuid = UUID_REGEX.test(idOrNumber);
    const where = isUuid ? { id: idOrNumber } : { ticketNumber: idOrNumber };

    const ticket = await this.client.supportTicket.findFirst({
      where,
      include: {
        user: {
          include: {
            profile: true,
          },
        },
        category: true,
        assignedAgent: {
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        },
        ride: {
          include: {
            driver: {
              include: {
                profile: true,
                user: {
                  include: {
                    profile: true,
                  },
                },
              },
            },
          },
        },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            author: {
              include: {
                profile: true,
              },
            },
          },
        },
        assignments: {
          orderBy: { assignedAt: 'desc' },
          include: {
            agent: {
              include: {
                user: {
                  include: {
                    profile: true,
                  },
                },
              },
            },
          },
        },
        _count: {
          select: {
            messages: true,
          },
        },
      },
    });

    if (!ticket) {
      throw new SupportTicketNotFoundError(`Support ticket '${idOrNumber}' not found`);
    }

    return this.mapToDetailDto(ticket);
  }

  async create(
    body: CreateSupportTicketBody,
    actorId?: string,
  ): Promise<AdminSupportTicketDetailDto> {
    let targetUserId = body.userId;

    if (!targetUserId && body.userPhoneNumber) {
      const user = await this.client.user.findFirst({
        where: { phoneNumber: body.userPhoneNumber },
      });
      if (user) {
        targetUserId = user.id;
      }
    }

    if (!targetUserId) {
      // Find default user or throw
      const firstUser = await this.client.user.findFirst();
      if (firstUser) {
        targetUserId = firstUser.id;
      } else {
        throw new OperationsValidationError('A valid userId is required to create a ticket');
      }
    }

    let categoryId = body.categoryId;
    if (!categoryId && body.categoryCode) {
      const category = await this.client.supportCategory.findFirst({
        where: { code: body.categoryCode },
      });
      if (category) {
        categoryId = category.id;
      } else {
        throw new SupportCategoryNotFoundError(`Support category '${body.categoryCode}' not found`);
      }
    }

    const ticketNumber = `TKT-${Math.floor(100000 + Math.random() * 900000)}`;

    const created = await this.client.$transaction(async (tx: PrismaTx) => {
      const ticket = await tx.supportTicket.create({
        data: {
          ticketNumber,
          userId: targetUserId!,
          categoryId: categoryId ?? null,
          rideId: body.rideId ?? null,
          subject: body.subject,
          description: body.description ?? null,
          priority: body.priority ?? 'NORMAL',
          channel: body.channel ?? 'APP',
          status: 'OPEN',
        },
      });

      if (body.description) {
        await tx.supportTicketMessage.create({
          data: {
            ticketId: ticket.id,
            authorType: 'CUSTOMER',
            authorId: targetUserId,
            body: body.description,
            isInternal: false,
          },
        });
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'support_ticket',
        entityId: ticket.id,
        summary: `Created support ticket ${ticket.ticketNumber}: ${ticket.subject}`,
        after: ticket,
      });

      return ticket;
    });

    return this.getById(created.id);
  }

  async assign(
    ticketId: string,
    body: AssignTicketBody,
    actorId?: string,
  ): Promise<AdminSupportTicketDetailDto> {
    const ticket = await this.client.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      throw new SupportTicketNotFoundError(`Support ticket '${ticketId}' not found`);
    }

    // Check if agent exists by SupportAgent ID or User ID
    let agent = await this.client.supportAgent.findUnique({
      where: { id: body.agentId },
    });

    if (!agent) {
      agent = await this.client.supportAgent.findUnique({
        where: { userId: body.agentId },
      });
    }

    if (!agent) {
      throw new SupportAgentNotFoundError(`Support agent '${body.agentId}' not found`);
    }

    await this.client.$transaction(async (tx: PrismaTx) => {
      // Release previous active assignments
      await tx.ticketAssignment.updateMany({
        where: { ticketId: ticket.id, status: 'ACTIVE' },
        data: { status: 'REASSIGNED', releasedAt: new Date() },
      });

      // Create new assignment
      await tx.ticketAssignment.create({
        data: {
          ticketId: ticket.id,
          agentId: agent.id,
          assignedBy: actorId ?? null,
          reason: body.reason ?? null,
          status: 'ACTIVE',
        },
      });

      // Update ticket
      const newStatus = ticket.status === 'OPEN' ? 'IN_PROGRESS' : ticket.status;
      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          assignedAgentId: agent.id,
          status: newStatus,
        },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'support_ticket',
        entityId: ticket.id,
        summary: `Assigned support ticket ${ticket.ticketNumber} to agent ${agent.displayName || agent.id}`,
        before: { assignedAgentId: ticket.assignedAgentId, status: ticket.status },
        after: { assignedAgentId: agent.id, status: newStatus },
      });
    });

    return this.getById(ticket.id);
  }

  async updateStatus(
    ticketId: string,
    body: UpdateTicketStatusBody,
    actorId?: string,
  ): Promise<AdminSupportTicketDetailDto> {
    const ticket = await this.client.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      throw new SupportTicketNotFoundError(`Support ticket '${ticketId}' not found`);
    }

    const updateData: Prisma.SupportTicketUpdateInput = {
      status: body.status,
    };

    const now = new Date();
    if (body.status === 'RESOLVED') {
      updateData.resolvedAt = now;
    } else if (body.status === 'CLOSED') {
      updateData.closedAt = now;
      if (!ticket.resolvedAt) {
        updateData.resolvedAt = now;
      }
    } else if (
      ['RESOLVED', 'CLOSED'].includes(ticket.status) &&
      ['OPEN', 'IN_PROGRESS', 'REOPENED'].includes(body.status)
    ) {
      updateData.reopenedCount = { increment: 1 };
      updateData.resolvedAt = null;
      updateData.closedAt = null;
    }

    await this.client.$transaction(async (tx: PrismaTx) => {
      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: updateData,
      });

      if (body.notes) {
        await tx.supportTicketMessage.create({
          data: {
            ticketId: ticket.id,
            authorType: 'AGENT',
            authorId: actorId ?? null,
            body: `[Status Change to ${body.status}] ${body.notes}`,
            isInternal: true,
          },
        });
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'support_ticket',
        entityId: ticket.id,
        summary: `Updated status of ticket ${ticket.ticketNumber} from ${ticket.status} to ${body.status}`,
        before: { status: ticket.status },
        after: { status: body.status },
      });
    });

    return this.getById(ticket.id);
  }

  async addMessage(
    ticketId: string,
    body: AddTicketMessageBody,
    actorId?: string,
  ): Promise<AdminSupportTicketDetailDto> {
    const ticket = await this.client.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      throw new SupportTicketNotFoundError(`Support ticket '${ticketId}' not found`);
    }

    await this.client.$transaction(async (tx: PrismaTx) => {
      await tx.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: body.authorType ?? 'AGENT',
          authorId: actorId ?? null,
          body: body.body,
          isInternal: body.isInternal ?? false,
          attachments: body.attachments ?? undefined,
        },
      });

      const updateData: Prisma.SupportTicketUpdateInput = {};
      if (!ticket.firstResponseAt && body.authorType !== 'CUSTOMER') {
        updateData.firstResponseAt = new Date();
      }

      if (body.authorType === 'CUSTOMER' && ticket.status === 'WAITING_CUSTOMER') {
        updateData.status = 'IN_PROGRESS';
      }

      if (Object.keys(updateData).length > 0) {
        await tx.supportTicket.update({
          where: { id: ticket.id },
          data: updateData,
        });
      }

      await recordAdminAction(tx, {
        actorId,
        action: 'CREATE',
        entityType: 'support_ticket_message',
        entityId: ticket.id,
        summary: `Added ${body.isInternal ? 'internal note' : 'reply'} on ticket ${ticket.ticketNumber}`,
      });
    });

    return this.getById(ticket.id);
  }

  async resolve(
    ticketId: string,
    body: ResolveTicketBody,
    actorId?: string,
  ): Promise<AdminSupportTicketDetailDto> {
    const ticket = await this.client.supportTicket.findUnique({
      where: { id: ticketId },
    });

    if (!ticket) {
      throw new SupportTicketNotFoundError(`Support ticket '${ticketId}' not found`);
    }

    const now = new Date();
    const status = body.status || 'RESOLVED';

    await this.client.$transaction(async (tx: PrismaTx) => {
      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status,
          resolvedAt: now,
          ...(status === 'CLOSED' ? { closedAt: now } : {}),
        },
      });

      await tx.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: 'AGENT',
          authorId: actorId ?? null,
          body: `[Resolution Notes]: ${body.resolutionNotes}`,
          isInternal: false,
        },
      });

      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'support_ticket',
        entityId: ticket.id,
        summary: `Resolved ticket ${ticket.ticketNumber}. Notes: ${body.resolutionNotes}`,
        before: { status: ticket.status },
        after: { status, resolvedAt: now },
      });
    });

    return this.getById(ticket.id);
  }

  async listCategories(): Promise<
    Array<{ id: string; code: string; name: string; sortOrder: number; defaultPriority: string }>
  > {
    const categories = await this.client.supportCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });

    return categories.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      sortOrder: c.sortOrder,
      defaultPriority: c.defaultPriority,
    }));
  }

  async listAgents(): Promise<
    Array<{
      id: string;
      userId: string;
      displayName: string | null;
      status: string;
      activeTickets: number;
    }>
  > {
    const agents = await this.client.supportAgent.findMany({
      include: {
        user: {
          include: {
            profile: true,
          },
        },
      },
    });

    return agents.map((a) => {
      const name =
        a.displayName ||
        [a.user?.profile?.firstName, a.user?.profile?.lastName].filter(Boolean).join(' ') ||
        'Agent';
      return {
        id: a.id,
        userId: a.userId,
        displayName: name,
        status: a.status,
        activeTickets: a.activeTickets,
      };
    });
  }

  private mapToListItemDto(
    ticket: Prisma.SupportTicketGetPayload<{
      include: {
        user: { include: { profile: true } };
        category: true;
        assignedAgent: { include: { user: { include: { profile: true } } } };
        ride: {
          include: {
            driver: {
              include: {
                profile: true;
                user: { include: { profile: true } };
              };
            };
          };
        };
        _count: { select: { messages: true } };
      };
    }>,
  ): AdminSupportTicketListItemDto {
    const userName =
      [ticket.user?.profile?.firstName, ticket.user?.profile?.lastName].filter(Boolean).join(' ') ||
      'Customer';

    const agentName = ticket.assignedAgent
      ? ticket.assignedAgent.displayName ||
        [
          ticket.assignedAgent.user?.profile?.firstName,
          ticket.assignedAgent.user?.profile?.lastName,
        ]
          .filter(Boolean)
          .join(' ') ||
        'Agent'
      : null;

    const driverName = ticket.ride?.driver
      ? [ticket.ride.driver.user?.profile?.firstName, ticket.ride.driver.user?.profile?.lastName]
          .filter(Boolean)
          .join(' ') ||
        ticket.ride.driver.profile?.fullLegalName ||
        'Driver'
      : null;

    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      description: ticket.description ?? null,
      status: ticket.status,
      priority: ticket.priority,
      channel: ticket.channel,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      firstResponseAt: ticket.firstResponseAt ? ticket.firstResponseAt.toISOString() : null,
      slaDueAt: ticket.slaDueAt ? ticket.slaDueAt.toISOString() : null,
      resolvedAt: ticket.resolvedAt ? ticket.resolvedAt.toISOString() : null,
      closedAt: ticket.closedAt ? ticket.closedAt.toISOString() : null,
      user: {
        id: ticket.userId,
        fullName: userName,
        phone: ticket.user?.phoneNumber ?? '',
        avatarUrl: ticket.user?.profile?.profileImageFileId ?? null,
      },
      category: ticket.category
        ? {
            id: ticket.category.id,
            code: ticket.category.code,
            name: ticket.category.name,
          }
        : null,
      assignedAgent: ticket.assignedAgent
        ? {
            id: ticket.assignedAgent.id,
            displayName: agentName,
            status: ticket.assignedAgent.status,
          }
        : null,
      ride: ticket.ride
        ? {
            id: ticket.ride.id,
            rideCode: ticket.ride.rideCode,
            status: ticket.ride.status,
            driverName,
            driverPhone: ticket.ride.driver?.user?.phoneNumber ?? null,
          }
        : null,
      messagesCount: ticket._count?.messages ?? 0,
    };
  }

  private mapToDetailDto(
    ticket: Prisma.SupportTicketGetPayload<{
      include: {
        user: { include: { profile: true } };
        category: true;
        assignedAgent: { include: { user: { include: { profile: true } } } };
        ride: {
          include: {
            driver: {
              include: {
                profile: true;
                user: { include: { profile: true } };
              };
            };
          };
        };
        messages: {
          include: { author: { include: { profile: true } } };
        };
        assignments: {
          include: { agent: { include: { user: { include: { profile: true } } } } };
        };
        _count: { select: { messages: true } };
      };
    }>,
  ): AdminSupportTicketDetailDto {
    const base = this.mapToListItemDto(ticket);

    const messages = (ticket.messages || []).map((m) => {
      const authorName = m.author
        ? [m.author.profile?.firstName, m.author.profile?.lastName].filter(Boolean).join(' ') ||
          m.authorType
        : m.authorType;

      return {
        id: m.id,
        body: m.body,
        isInternal: m.isInternal,
        authorType: m.authorType,
        authorId: m.authorId ?? null,
        authorName,
        attachments: m.attachments ?? null,
        createdAt: m.createdAt.toISOString(),
      };
    });

    const assignments = (ticket.assignments || []).map((a) => {
      const agentName = a.agent
        ? a.agent.displayName ||
          [a.agent.user?.profile?.firstName, a.agent.user?.profile?.lastName]
            .filter(Boolean)
            .join(' ') ||
          'Agent'
        : null;

      return {
        id: a.id,
        agentId: a.agentId,
        agentName,
        assignedBy: a.assignedBy ?? null,
        reason: a.reason ?? null,
        status: a.status,
        assignedAt: a.assignedAt.toISOString(),
        releasedAt: a.releasedAt ? a.releasedAt.toISOString() : null,
      };
    });

    return {
      ...base,
      reopenedCount: ticket.reopenedCount ?? 0,
      messages,
      assignments,
    };
  }
}
