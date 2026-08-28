import type { FastifyReply, FastifyRequest } from 'fastify';
import { assertRideParty, callerId } from '@core/auth';
import { GeoService } from '@modules/geo';
import { RideRepository } from '../repositories/ride.repository.js';
import { ReceiptService } from '../services/receipt/receipt.service.js';
import { RideNotFoundError } from '../errors/ride.errors.js';
import { ridePartyIds } from '../types/ride-party.js';
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
  /// The caller's live ride, whichever side of it they are on.
  ///
  /// This used to branch on `callerHasRole(req, 'driver')` and look the caller
  /// up only as a driver if so. Every verified driver keeps that role while
  /// off duty, so a driver taking a ride as a passenger was searched for as a
  /// driver, found nothing, and was told they had no active ride while sitting
  /// in one. One query over both sides needs no such guess.
  async getActive(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const activeRide = await this.rideRepo.findActiveForUser(callerId(req));
    return reply.send({ data: activeRide });
  }
  async getById(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as {
      id: string;
    };
    const ride = await this.rideRepo.findById(id);
    if (!ride) throw new RideNotFoundError(id);
    assertRideParty(req, ridePartyIds(ride));
    reply.send({ data: ride });
  }
  async getReceipt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as {
      id: string;
    };
    const ride = await this.rideRepo.findById(id);
    if (!ride) throw new RideNotFoundError(id);
    assertRideParty(req, ridePartyIds(ride));
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
    assertRideParty(req, ridePartyIds(ride));
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
