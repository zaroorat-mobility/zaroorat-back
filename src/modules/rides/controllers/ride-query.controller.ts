import type { FastifyReply, FastifyRequest } from 'fastify';
import { assertRideParty, callerHasRole, callerId } from '@core/auth';
import { RideRepository } from '../repositories/ride.repository.js';
import { ReceiptService } from '../services/receipt/receipt.service.js';
import { RideNotFoundError } from '../errors/ride.errors.js';

export class RideQueryController {
  constructor(
    private readonly rideRepo: RideRepository,
    private readonly receiptService: ReceiptService,
  ) {}

  async getActive(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const userId = callerId(req);

    if (callerHasRole(req, 'driver')) {
      const driverRide = await this.rideRepo.findActiveByDriverUserId(userId);
      return reply.send({ data: driverRide });
    }

    const activeRide = await this.rideRepo.findActiveByCustomer(userId);
    return reply.send({ data: activeRide });
  }

  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const ride = await this.rideRepo.findById(id);
    if (!ride) throw new RideNotFoundError(id);

    assertRideParty(req, {
      customerId: ride.customerId,
      driverUserId: (ride as { driver?: { userId?: string } }).driver?.userId ?? null,
    });

    reply.send({ data: ride });
  }

  async getReceipt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };

    const ride = await this.rideRepo.findById(id);
    if (!ride) throw new RideNotFoundError(id);
    assertRideParty(req, {
      customerId: ride.customerId,
      driverUserId: (ride as { driver?: { userId?: string } }).driver?.userId ?? null,
    });

    const receipt = await this.receiptService.generateReceipt(id);
    reply.send({ data: receipt });
  }

  async listHistory(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const rides = await this.rideRepo.listCustomerRides(callerId(req));
    reply.send({ data: rides });
  }
}
