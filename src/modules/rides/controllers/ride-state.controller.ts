import { RideNotFoundError, RideCustomerMismatchError } from '../errors/ride.errors.js';
import { RIDE_REQUEST_IDEMPOTENCY_TTL_SECONDS } from '../constants/ride.constants.js';
import { RedisService, IDEMPOTENCY_OPERATIONS } from '@core/cache';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerId } from '@core/auth';
import { DatabaseService } from '@core/database';
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
import { toClientOfferView, toClientRideView } from '../presenters/ride-client.presenter.js';
export class RideStateController {
  constructor(
    private readonly rideService: RideService,
    private readonly driverRepository: DriverRepository,
    private readonly dispatchRepo: RideDispatchRepository,
    private readonly dispatchService: DispatchService,
    private readonly rideRepo: RideRepository,
    private readonly db: DatabaseService,
    private readonly redisService?: RedisService,
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
    const customerIds = [
      ...new Set(
        offers
          .map((o) => o.request?.customerId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    const profiles =
      customerIds.length === 0
        ? []
        : await this.db.client.userProfile.findMany({
            where: { userId: { in: customerIds } },
            select: { userId: true, firstName: true, lastName: true },
          });
    const customerById = new Map(
      profiles.map((p) => [p.userId, { firstName: p.firstName, lastName: p.lastName }]),
    );
    reply.send({
      data: offers.map((offer) => toClientOfferView(offer, customerById)),
    });
  }
  async accept(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const body = acceptRideRequestSchema.parse(req.body);
    const result = await this.rideService.lifecycle.acceptRideRequest({
      requestId: body.requestId,
      driverId,
      vehicleId: body.vehicleId,
    });
    // Re-fetch enriched ride so the driver app gets customer name immediately.
    const enriched = result?.ride?.id ? await this.rideRepo.findById(result.ride.id) : null;
    reply.send({
      data: enriched ? { ...result, ride: toClientRideView(enriched) } : result,
    });
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
    await this.rideService.lifecycle.markDriverArriving(id, driverId);
    const enriched = await this.rideRepo.findById(id);
    reply.send({ data: enriched ? toClientRideView(enriched) : null });
  }
  async arrive(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    await this.rideService.lifecycle.markDriverArrived(id, driverId);
    const enriched = await this.rideRepo.findById(id);
    reply.send({ data: enriched ? toClientRideView(enriched) : null });
  }

  async arriveDropoff(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    await this.rideService.lifecycle.markDriverArrivedAtDropoff(id, driverId);
    const enriched = await this.rideRepo.findById(id);
    reply.send({ data: enriched ? toClientRideView(enriched) : null });
  }
  async start(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    const body = startRideSchema.parse(req.body);
    await this.rideService.lifecycle.startRide(id, driverId, body.pin);
    const enriched = await this.rideRepo.findById(id);
    reply.send({ data: enriched ? toClientRideView(enriched) : null });
  }
  async complete(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const driverId = await this.actingDriverId(req);
    const { id } = req.params as {
      id: string;
    };
    const body = completeRideSchema.parse(req.body);
    await this.rideService.lifecycle.completeRide(
      id,
      driverId,
      body.actualDistanceKm,
      body.actualDurationMin,
      {
        ...(body.endReasonCode !== undefined ? { endReasonCode: body.endReasonCode } : {}),
        ...(body.endReasonText !== undefined ? { endReasonText: body.endReasonText } : {}),
      },
    );
    const enriched = await this.rideRepo.findById(id);
    reply.send({ data: enriched ? toClientRideView(enriched) : null });
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
    if (!ride) throw new RideNotFoundError(id);

    const party = rideParty(callerId(req), ride);
    if (party !== 'DRIVER' && party !== 'CUSTOMER') {
      throw new RideCustomerMismatchError(id);
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const cancelFn = async () => {
      if (party === 'DRIVER') {
        const driverId = await this.actingDriverId(req);
        return this.rideService.lifecycle.cancelRide(
          id,
          'DRIVER',
          driverId,
          body.reasonCode,
          body.reasonText,
        );
      }
      return this.rideService.lifecycle.cancelRide(
        id,
        'CUSTOMER',
        callerId(req),
        body.reasonCode,
        body.reasonText,
      );
    };

    if (this.redisService && idempotencyKey) {
      await this.redisService.idempotency.runOnce(
        IDEMPOTENCY_OPERATIONS.RIDE_CANCEL,
        `cancel:${callerId(req)}:${idempotencyKey}`,
        RIDE_REQUEST_IDEMPOTENCY_TTL_SECONDS,
        cancelFn,
      );
    } else {
      await cancelFn();
    }

    const enriched = await this.rideRepo.findById(id);
    return reply.send({ data: enriched ? toClientRideView(enriched) : null });
  }
}
