import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { RideService } from '../services/ride.service.js';
import { RideDispatchRepository } from '../repositories/ride-dispatch.repository.js';
import { RideRepository } from '../repositories/ride.repository.js';
import { rideParty } from '../types/ride-party.js';
import { DispatchService } from '../services/dispatch/dispatch.service.js';
import {
  acceptRideRequestSchema,
  rejectOfferSchema,
  startRideSchema,
  completeRideSchema,
  cancelRideSchema,
} from '../schemas/ride.schemas.js';
import { DriverNotFoundError } from '@modules/drivers/errors/driver.errors.js';
export class RideStateController {
  constructor(
    private readonly rideService: RideService,
    private readonly driverRepository: DriverRepository,
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly dispatchService: DispatchService,
    private readonly rideRepo: RideRepository,
  ) {}
  private async actingDriverId(req: FastifyRequest): Promise<string> {
    const userId = callerId(req);
    const driver = await this.driverRepository.findByUserId(userId);
    if (!driver) throw new DriverNotFoundError(userId);
    return driver.id;
  }
  async listOffers(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const offers = await this.dispatchRepo.findPendingForDriver(driverId);
    reply.send({ data: offers });
  }
  async accept(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const body = acceptRideRequestSchema.parse(req.body);
    const result = await this.rideService.lifecycle.acceptRideRequest({
      requestId: body.requestId,
      driverId,
      vehicleId: body.vehicleId,
    });
    reply.send({ data: result });
  }
  /// Declining an offer, so the next drivers are asked immediately instead of
  /// a timeout window later. The dispatch id comes from the path; ownership is
  /// checked against the token's driver, never taken from the request.
  async rejectOffer(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as { id: string };
    const body = rejectOfferSchema.parse(req.body ?? {});
    const offer = await this.dispatchService.rejectOffer({
      dispatchId: id,
      driverId,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    });
    reply.send({ data: offer });
  }
  /// Driver has started travelling to the pickup point.
  async arriving(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    const ride = await this.rideService.lifecycle.markDriverArriving(id, driverId);
    reply.send({ data: ride });
  }
  async arrive(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    const ride = await this.rideService.lifecycle.markDriverArrived(id, driverId);
    reply.send({ data: ride });
  }
  async start(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    const body = startRideSchema.parse(req.body);
    const ride = await this.rideService.lifecycle.startRide(id, driverId, body.otpCode);
    reply.send({ data: ride });
  }
  async complete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    const body = completeRideSchema.parse(req.body);
    const ride = await this.rideService.lifecycle.completeRide(
      id,
      driverId,
      body.actualDistanceKm,
      body.actualDurationMin,
    );
    reply.send({ data: ride });
  }
  /// Which side of the ride is cancelling comes from the ride, not from the
  /// caller's roles.
  ///
  /// This branched on `callerHasRole(req, 'driver')`. A verified driver keeps
  /// that role off duty, so a driver riding as a passenger was routed down the
  /// driver path, `lockAndValidate` found the ride assigned to somebody else,
  /// and they were refused with 403 RIDE_DRIVER_MISMATCH — permanently unable
  /// to cancel their own ride.
  ///
  /// Everyone else is unaffected, including a caller who is party to nothing:
  /// `rideParty` returns null, the customer path runs exactly as before, and
  /// `cancelRide` refuses it with the same RIDE_CUSTOMER_MISMATCH. A missing
  /// ride likewise still reaches `cancelRide` and still 404s there, so this
  /// read adds no new failure mode of its own.
  async cancel(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { id } = req.params as {
      id: string;
    };
    const body = cancelRideSchema.parse(req.body);
    const ride = await this.rideRepo.findById(id);
    if (ride && rideParty(callerId(req), ride) === 'DRIVER') {
      const cancelled = await this.rideService.lifecycle.cancelRide(
        id,
        'DRIVER',
        await this.actingDriverId(req),
        body.reasonCode,
        body.reasonText,
      );
      return reply.send({ data: cancelled });
    }
    const cancelled = await this.rideService.lifecycle.cancelRide(
      id,
      'CUSTOMER',
      callerId(req),
      body.reasonCode,
      body.reasonText,
    );
    return reply.send({ data: cancelled });
  }
}
