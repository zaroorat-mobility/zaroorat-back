import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { RideError } from '../../errors/ride.errors.js';
import { RideRepository } from '../../repositories/ride.repository.js';

export class ChatForbiddenError extends RideError {
  constructor(message = 'You are not a party to this ride chat') {
    super(message, 'CHAT_FORBIDDEN', 403);
    this.name = 'ChatForbiddenError';
  }
}

export interface RideChatMessageDto {
  id: string;
  conversationId: string;
  senderId: string | null;
  content: string | null;
  messageType: string;
  status: string;
  createdAt: string;
  rideId: string;
}

export class RideChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly rideRepository: RideRepository,
  ) {}

  async ensureConversationForRide(
    rideId: string,
    customerUserId: string,
    driverUserId: string,
    tx?: TransactionClient,
  ) {
    const client = tx ?? this.db.client;
    const existing = await client.chatConversation.findFirst({
      where: { rideId, type: 'RIDE', status: 'ACTIVE' },
    });
    if (existing) return existing;

    return client.chatConversation.create({
      data: {
        type: 'RIDE',
        rideId,
        status: 'ACTIVE',
        participants: {
          create: [
            { userId: customerUserId, role: 'CUSTOMER' },
            { userId: driverUserId, role: 'DRIVER' },
          ],
        },
      },
    });
  }

  private async assertParty(rideId: string, userId: string) {
    const ride = await this.rideRepository.findById(rideId);
    if (!ride) throw new RideError(`Ride '${rideId}' was not found`, 'RIDE_NOT_FOUND', 404);
    const driver = await this.db.client.driver.findUnique({
      where: { id: ride.driverId },
      select: { userId: true },
    });
    const isCustomer = ride.customerId === userId;
    const isDriver = driver?.userId === userId;
    if (!isCustomer && !isDriver) throw new ChatForbiddenError();
    return {
      ride,
      driverUserId: driver?.userId ?? null,
    };
  }

  async listMessages(rideId: string, userId: string, limit = 50, before?: string) {
    const { ride, driverUserId } = await this.assertParty(rideId, userId);
    if (!driverUserId) throw new ChatForbiddenError();
    const conversation = await this.ensureConversationForRide(
      rideId,
      ride.customerId,
      driverUserId,
    );
    const messages = await this.db.client.chatMessage.findMany({
      where: {
        conversationId: conversation.id,
        isDeleted: false,
        ...(before ? { createdAt: { lt: await this.messageCreatedAt(before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return {
      conversationId: conversation.id,
      messages: messages.reverse().map((m) => ({
        id: m.id,
        senderId: m.senderId,
        messageType: m.messageType,
        content: m.content,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async sendMessage(rideId: string, userId: string, content: string): Promise<RideChatMessageDto> {
    const { ride, driverUserId } = await this.assertParty(rideId, userId);
    if (!driverUserId) throw new ChatForbiddenError();
    const conversation = await this.ensureConversationForRide(
      rideId,
      ride.customerId,
      driverUserId,
    );
    const message = await this.db.client.$transaction(async (tx) => {
      const created = await tx.chatMessage.create({
        data: {
          conversationId: conversation.id,
          senderId: userId,
          messageType: 'TEXT',
          content,
          status: 'SENT',
        },
      });
      await tx.chatConversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: created.createdAt },
      });
      return created;
    });

    return {
      id: message.id,
      conversationId: conversation.id,
      senderId: message.senderId,
      content: message.content,
      messageType: message.messageType,
      status: message.status,
      createdAt: message.createdAt.toISOString(),
      rideId,
    };
  }

  private async messageCreatedAt(messageId: string): Promise<Date> {
    const msg = await this.db.client.chatMessage.findUnique({
      where: { id: messageId },
      select: { createdAt: true },
    });
    return msg?.createdAt ?? new Date(0);
  }
}
