import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { asClass, type AwilixContainer } from 'awilix';
import { DatabaseService } from '@core/database';
import { callerId } from '@core/auth';
import { container } from '@core/di';
import { rateLimits } from '@config';
import { CustomerSupportTicketNotFoundError, SupportTicketClosedError } from './support.errors.js';

const createTicketSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  description: z.string().trim().min(1).max(4000),
  category: z.string().trim().max(64).optional(),
  rideId: z.string().uuid().optional(),
  channel: z.enum(['APP', 'CHAT']).optional(),
});

const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

const CATEGORY_ALIASES: Record<string, string> = {
  trip_booking: 'RIDE_ISSUE',
  account_wallet: 'PAYMENT',
  safety_security: 'SAFETY',
  app_technical: 'APP_ISSUE',
  general_help: 'RIDE_ISSUE',
  driver_behaviour: 'DRIVER_COMPLAINT',
  ride_check: 'RIDE_ISSUE',
  driving_issue: 'RIDE_ISSUE',
  route_issue: 'RIDE_ISSUE',
  vehicle_issue: 'RIDE_ISSUE',
  other_issue: 'RIDE_ISSUE',
};

function publicMessage(row: {
  id: string;
  body: string;
  authorType: string;
  authorId: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    body: row.body,
    authorType: row.authorType,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
    fromCustomer: row.authorType === 'CUSTOMER',
  };
}

export class CustomerSupportService {
  constructor(private readonly databaseService: DatabaseService) {}

  private get client() {
    return this.databaseService.client;
  }

  async createForCustomer(userId: string, input: z.infer<typeof createTicketSchema>) {
    let categoryId: string | null = null;
    if (input.category) {
      const mapped =
        CATEGORY_ALIASES[input.category] ??
        CATEGORY_ALIASES[input.category.toLowerCase()] ??
        input.category.toUpperCase();
      const byCode = await this.client.supportCategory.findFirst({
        where: {
          OR: [{ code: mapped }, { code: input.category.toUpperCase() }, { code: input.category }],
        },
      });
      categoryId = byCode?.id ?? null;
    }

    let rideId: string | null = input.rideId ?? null;
    if (rideId) {
      const ride = await this.client.ride.findFirst({
        where: { id: rideId, customerId: userId },
        select: { id: true },
      });
      if (!ride) rideId = null;
    }

    const ticketNumber = `TKT-${Math.floor(100000 + Math.random() * 900000)}`;
    const ticket = await this.client.$transaction(async (tx) => {
      const created = await tx.supportTicket.create({
        data: {
          ticketNumber,
          userId,
          categoryId,
          rideId,
          subject: input.subject,
          description: input.description,
          priority: 'NORMAL',
          channel: input.channel === 'CHAT' ? 'CHAT' : 'APP',
          status: 'OPEN',
        },
      });
      await tx.supportTicketMessage.create({
        data: {
          ticketId: created.id,
          authorType: 'CUSTOMER',
          authorId: userId,
          body: input.description,
          isInternal: false,
        },
      });
      return created;
    });

    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      description: ticket.description,
      status: ticket.status,
      priority: ticket.priority,
      rideId: ticket.rideId,
      createdAt: ticket.createdAt.toISOString(),
    };
  }

  async listForCustomer(userId: string) {
    const rows = await this.client.supportTicket.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        ticketNumber: true,
        subject: true,
        description: true,
        status: true,
        priority: true,
        rideId: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          where: { isInternal: false },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { body: true, createdAt: true, authorType: true },
        },
        _count: { select: { messages: { where: { isInternal: false } } } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      ticketNumber: row.ticketNumber,
      subject: row.subject,
      description: row.description,
      status: row.status,
      priority: row.priority,
      rideId: row.rideId,
      messagesCount: row._count.messages,
      lastMessage: row.messages[0]
        ? {
            body: row.messages[0].body,
            authorType: row.messages[0].authorType,
            createdAt: row.messages[0].createdAt.toISOString(),
          }
        : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async listCategories() {
    const rows = await this.client.supportCategory.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, code: true, name: true, sortOrder: true },
    });
    return rows;
  }

  private async loadOwnedTicket(userId: string, ticketId: string) {
    const ticket = await this.client.supportTicket.findFirst({
      where: { id: ticketId, userId },
    });
    if (!ticket) throw new CustomerSupportTicketNotFoundError(ticketId);
    return ticket;
  }

  async getTicket(userId: string, ticketId: string) {
    const ticket = await this.loadOwnedTicket(userId, ticketId);
    const messages = await this.client.supportTicketMessage.findMany({
      where: { ticketId: ticket.id, isInternal: false },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      description: ticket.description,
      status: ticket.status,
      priority: ticket.priority,
      rideId: ticket.rideId,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      messages: messages.map(publicMessage),
    };
  }

  async listMessages(
    userId: string,
    ticketId: string,
    options: { limit?: number; before?: string } = {},
  ) {
    await this.loadOwnedTicket(userId, ticketId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const rows = await this.client.supportTicketMessage.findMany({
      where: {
        ticketId,
        isInternal: false,
        ...(options.before ? { createdAt: { lt: new Date(options.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.reverse().map(publicMessage);
  }

  async sendMessage(userId: string, ticketId: string, body: string) {
    const ticket = await this.loadOwnedTicket(userId, ticketId);
    if (ticket.status === 'CLOSED') {
      throw new SupportTicketClosedError();
    }

    const message = await this.client.$transaction(async (tx) => {
      const created = await tx.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: 'CUSTOMER',
          authorId: userId,
          body,
          isInternal: false,
        },
      });

      const update: { status?: 'IN_PROGRESS' | 'REOPENED'; reopenedCount?: number } = {};
      if (ticket.status === 'WAITING_CUSTOMER') update.status = 'IN_PROGRESS';
      if (ticket.status === 'RESOLVED') {
        update.status = 'REOPENED';
        update.reopenedCount = ticket.reopenedCount + 1;
      }
      await tx.supportTicket.update({
        where: { id: ticket.id },
        data: Object.keys(update).length ? update : { updatedAt: new Date() },
      });
      return created;
    });

    return publicMessage(message);
  }
}

export class CustomerSupportController {
  constructor(private readonly customerSupportService: CustomerSupportService) {}

  async create(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = createTicketSchema.parse(req.body);
    const data = await this.customerSupportService.createForCustomer(callerId(req), body);
    reply.status(201).send({ data });
  }

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.customerSupportService.listForCustomer(callerId(req));
    reply.send({ data });
  }

  async listCategories(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const data = await this.customerSupportService.listCategories();
    reply.send({ data });
  }

  async getTicket(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const data = await this.customerSupportService.getTicket(callerId(req), id);
    reply.send({ data });
  }

  async listMessages(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const query = (req.query ?? {}) as { limit?: string; before?: string };
    const data = await this.customerSupportService.listMessages(callerId(req), id, {
      ...(query.limit ? { limit: Number(query.limit) } : {}),
      ...(query.before ? { before: query.before } : {}),
    });
    reply.send({ data });
  }

  async sendMessage(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const body = sendMessageSchema.parse(req.body);
    const data = await this.customerSupportService.sendMessage(callerId(req), id, body.body);
    reply.status(201).send({ data });
  }
}

export function registerSupportModule(c: AwilixContainer): void {
  c.register({
    customerSupportService: asClass(CustomerSupportService).singleton(),
    customerSupportController: asClass(CustomerSupportController).singleton(),
  });
}

export async function supportRoutes(fastify: FastifyInstance): Promise<void> {
  const controller = container.resolve<CustomerSupportController>('customerSupportController');
  const writeLimit = { preHandler: fastify.rateLimit(rateLimits.supportWrite) };
  const uuidParams = {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'string',
            pattern:
              '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
          },
        },
      },
    },
  } as const;

  fastify.get('/categories', (req, reply) => controller.listCategories(req, reply));
  fastify.post('/tickets', writeLimit, (req, reply) => controller.create(req, reply));
  fastify.get('/tickets', (req, reply) => controller.list(req, reply));
  fastify.get('/tickets/:id', uuidParams, (req, reply) => controller.getTicket(req, reply));
  fastify.get('/tickets/:id/messages', uuidParams, (req, reply) =>
    controller.listMessages(req, reply),
  );
  fastify.post('/tickets/:id/messages', { ...uuidParams, ...writeLimit }, (req, reply) =>
    controller.sendMessage(req, reply),
  );
}
