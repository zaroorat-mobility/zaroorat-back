import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { callerId } from '@core/auth';
import type { EventPublisher } from '@core/events';
import type { RealtimeGateway } from '@modules/realtime/realtime.gateway.js';
import { SOCKET_EVENT, room, socketEnvelope } from '@modules/realtime/events.js';
import { maskAccountNumber } from '@shared/crypto/bank-account-crypto.js';
import { DriverRepository } from '../repositories/driver.repository.js';
import { DriverBankRepository } from '../repositories/driver-bank.repository.js';
import { submitDriverBankAccountSchema } from '../schemas/driver.schemas.js';
import { actingDriverId } from './driver-identity.js';
import { driverEvent, DRIVER_EVENT_CATALOG } from '../events/catalog.js';
import type { DriverBankAccount } from '../types/index.js';

export function toDriverBankAccountView(account: DriverBankAccount) {
  return {
    id: account.id,
    driverId: account.driverId,
    accountHolderName: account.accountHolderName,
    bankName: account.bankName,
    ifscCode: account.ifscCode,
    accountNumberMasked: maskAccountNumber(account.accountNumberLast4),
    upiId: account.upiId,
    status: account.status,
    verificationStatus: account.verificationStatus,
    payoutEnabled: account.payoutEnabled,
    isDefault: account.isDefault,
    createdAt: account.createdAt.toISOString(),
  };
}

export class DriverBankController {
  constructor(
    private readonly driverRepository: DriverRepository,
    private readonly driverBankRepository: DriverBankRepository,
    private readonly eventPublisher?: EventPublisher,
    private readonly realtimeGateway?: RealtimeGateway,
  ) {}

  async getBankAccount(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const accounts = await this.driverBankRepository.findByDriverId(driverId);
    if (!accounts || accounts.length === 0) {
      reply.send({ data: null });
      return;
    }
    const defaultOrFirst = accounts.find((a) => a.isDefault) ?? accounts[0]!;
    reply.send({ data: toDriverBankAccountView(defaultOrFirst) });
  }

  async saveBankAccount(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await actingDriverId(req, this.driverRepository);
    const userId = callerId(req);
    const body = submitDriverBankAccountSchema.parse(req.body);

    const created = await this.driverBankRepository.createAccount({
      driverId,
      accountHolderName: body.accountHolderName.trim(),
      bankName: body.bankName.trim(),
      ifscCode: body.ifscCode.trim().toUpperCase(),
      accountNumber: body.accountNumber.trim(),
      ...(body.upiId?.trim() ? { upiId: body.upiId.trim() } : {}),
      isDefault: true,
      enteredBy: userId,
    });

    // 1. Emit direct socket event to the admin ops + drivers rooms for 0ms instantaneous update
    try {
      this.realtimeGateway?.emitToRoom(
        [room.opsDashboard(), room.driversDashboard()],
        socketEnvelope(randomUUID(), SOCKET_EVENT.DASHBOARD_DRIVER_REGISTRATION_CHANGED, {
          driverId,
          change: 'BANK_ACCOUNT_SUBMITTED',
        }),
      );
    } catch {
      // Non-fatal if socket server not running in test/sandbox
    }

    // 2. Publish domain event to EventBus / outbox for worker and persistent event consumers
    if (this.eventPublisher) {
      try {
        await this.eventPublisher.publish(
          driverEvent(DRIVER_EVENT_CATALOG.PROFILE_UPDATED, driverId, {
            driverId,
            change: 'BANK_ACCOUNT_SUBMITTED',
            bankName: body.bankName.trim(),
            accountHolderName: body.accountHolderName.trim(),
          }),
        );
      } catch {
        // Non-fatal
      }
    }

    reply.status(201).send({ data: toDriverBankAccountView(created) });
  }
}
