import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { callerId } from '@core/auth';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { DriverNotFoundError } from '@modules/drivers/errors/driver.errors.js';
import { RealtimeGateway } from '@modules/realtime/realtime.gateway.js';
import { SOCKET_EVENT, room, socketEnvelope } from '@modules/realtime/events.js';
import { uuidV7 } from '@shared/crypto';
import { ScheduledRideService } from '../services/scheduled/scheduled-ride.service.js';
import { RideChatService } from '../services/chat/ride-chat.service.js';
import { RideCallService } from '../services/call/ride-call.service.js';

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(2000),
});

export class RideChatController {
  constructor(
    private readonly rideChatService: RideChatService,
    private readonly realtimeGateway: RealtimeGateway,
  ) {}

  async list(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const before = (req.query as { before?: string }).before;
    const data = await this.rideChatService.listMessages(id, callerId(req), 50, before);
    reply.send({ data });
  }

  async send(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const body = sendMessageSchema.parse(req.body);
    const message = await this.rideChatService.sendMessage(id, callerId(req), body.content);
    this.realtimeGateway.emitToRoom(
      room.ride(id),
      socketEnvelope(uuidV7(), SOCKET_EVENT.CHAT_MESSAGE_NEW, {
        rideId: id,
        conversationId: message.conversationId,
        messageId: message.id,
        senderId: message.senderId,
        content: message.content,
        messageType: message.messageType,
        createdAt: message.createdAt,
      }),
    );
    reply.status(201).send({ data: message });
  }
}

export class RideCallController {
  constructor(private readonly rideCallService: RideCallService) {}

  async initiate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const data = await this.rideCallService.initiate(id, callerId(req));
    reply.send({ data });
  }
}

export class RideScheduledController {
  constructor(
    private readonly scheduledRideService: ScheduledRideService,
    private readonly driverRepository: DriverRepository,
  ) {}

  private async actingDriverId(req: FastifyRequest): Promise<string> {
    const driver = await this.driverRepository.findByUserId(callerId(req));
    if (!driver) throw new DriverNotFoundError(callerId(req));
    return driver.id;
  }

  async accept(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as { id: string };
    const data = await this.scheduledRideService.accept(id, driverId);
    reply.send({ data });
  }

  async decline(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as { id: string };
    const data = await this.scheduledRideService.decline(id, driverId);
    reply.send({ data });
  }
}
