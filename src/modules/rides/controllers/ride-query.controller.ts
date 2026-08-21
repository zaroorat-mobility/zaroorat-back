import type { FastifyReply, FastifyRequest } from 'fastify';
import { assertRideParty, callerHasRole, callerId } from '@core/auth';
import { GeoService } from '@modules/geo';
import { RideRepository } from '../repositories/ride.repository.js';
import { ReceiptService } from '../services/receipt/receipt.service.js';
import { RideNotFoundError } from '../errors/ride.errors.js';
const LIVE_TRACKING_STATUSES = new Set([
  'ACCEPTED',
  'DRIVER_ARRIVING',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
]);
export class RideQueryController {
  constructor(
    private readonly rideRepo: RideRepository,
    private readonly receiptService: ReceiptService,
    private readonly geoService: GeoService,
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
    const { id } = req.params as {
      id: string;
    };
    const ride = await this.rideRepo.findById(id);
    if (!ride) throw new RideNotFoundError(id);
    assertRideParty(req, {
      customerId: ride.customerId,
      driverUserId:
        (
          ride as {
            driver?: {
              userId?: string;
            };
          }
        ).driver?.userId ?? null,
    });
    reply.send({ data: ride });
  }
  async getReceipt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as {
      id: string;
    };
    const ride = await this.rideRepo.findById(id);
    if (!ride) throw new RideNotFoundError(id);
    assertRideParty(req, {
      customerId: ride.customerId,
      driverUserId:
        (
          ride as {
            driver?: {
              userId?: string;
            };
          }
        ).driver?.userId ?? null,
    });
    const receipt = await this.receiptService.generateReceipt(id);
    reply.send({ data: receipt });
  }
  /// The only sanctioned way for a customer to see a driver's live position:
  /// scoped to their own active ride with that exact driver, not the
  /// driver-owned `GET /drivers/:id/location` endpoint, which correctly
  /// refuses every non-driver, non-staff caller and has no ride-scoped
  /// exception of its own.
  async getDriverLocation(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as { id: string };
    const ride = await this.rideRepo.findById(id);
    if (!ride) throw new RideNotFoundError(id);
    assertRideParty(req, {
      customerId: ride.customerId,
      driverUserId:
        (
          ride as {
            driver?: {
              userId?: string;
            };
          }
        ).driver?.userId ?? null,
    });
    if (!LIVE_TRACKING_STATUSES.has(ride.status)) {
      reply.send({ data: null });
      return;
    }
    const position = await this.geoService.liveDriverPosition(ride.driverId);
    reply.send({ data: position });
  }
  async listHistory(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const rides = await this.rideRepo.listCustomerRides(callerId(req));
    reply.send({ data: rides });
  }
}
