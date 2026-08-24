import type { FastifyReply, FastifyRequest } from 'fastify';
import { callerHasRole, requireCaller } from '@core/auth';
import { RideRepository } from '@modules/rides/repositories/ride.repository.js';
import { DriverRepository } from '@modules/drivers/repositories/driver.repository.js';
import { RideFareRepository } from '@modules/rides/repositories/ride-fare.repository.js';
import { Decimal } from '../types/index.js';
import { RidePaymentRepository } from '../repositories/ride-payment.repository.js';
import { RideCollectionService } from '../services/collection/collection.service.js';
import { DebtService } from '../services/debt/debt.service.js';
import { projectCollectionState } from '../services/collection/collection-state.js';
import { PaymentService } from '../services/payment.service.js';
import {
  CashConfirmationNotApplicableError,
  CollectionNotRetryableError,
  ObligationWrittenOffError,
  RidePaymentNotFoundError,
} from '../errors/payment.errors.js';

interface RidePaymentView {
  rideId: string;
  collectionState: string;
  method: string;
  amount: number;
  settledAt: Date | null;
  attempts: number;
  amountOwed: number;
}

export class RidePaymentController {
  constructor(
    private readonly rideRepository: RideRepository,
    private readonly rideFareRepository: RideFareRepository,
    private readonly ridePaymentRepository: RidePaymentRepository,
    private readonly rideCollectionService: RideCollectionService,
    private readonly driverRepository: DriverRepository,
    private readonly debtService: DebtService,
    private readonly paymentService: PaymentService,
  ) {}

  async getRidePayment(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { rideId } = req.params as { rideId: string };
    reply.send({ data: await this.view(req, rideId) });
  }

  async retry(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { rideId } = req.params as { rideId: string };
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const caller = requireCaller(req);
    // Outside the idempotency wrapper: a caller who is not the rider gets a
    // 404 on every attempt, cached or not.
    await this.view(req, rideId, { riderOnly: true });

    const result = await this.paymentService.withIdempotency(
      caller.userId,
      '/rides/payment/retry',
      idempotencyKey,
      // Deliberately not the request body: the body carries no amount, and
      // what is being retried is fully identified by the ride.
      { rideId },
      async () => {
        // Inside, so a replayed key returns the first call's response rather
        // than a 409 for an obligation that first call has just settled.
        //
        // BD-2's debt threshold is deliberately not consulted anywhere here.
        // It blocks new ride requests; refusing someone permission to pay what
        // they owe would be self-defeating.
        const before = await this.view(req, rideId, { riderOnly: true });
        if (before.collectionState === 'WRITTEN_OFF') throw new ObligationWrittenOffError();
        if (before.collectionState !== 'RETRYING' && before.collectionState !== 'UNPAID') {
          throw new CollectionNotRetryableError();
        }
        // UNPAID is a standing receivable and settles through transition 7b,
        // which must not re-recognise earnings. RETRYING is still an open
        // first-time collection.
        if (before.collectionState === 'UNPAID') {
          await this.rideCollectionService.settleReceivable(rideId);
        } else {
          await this.rideCollectionService.collect(rideId);
        }
        return this.view(req, rideId, { riderOnly: true });
      },
    );
    reply.send({ data: result });
  }

  /// BD-5 transition 4a — the driver says the cash changed hands.
  ///
  /// The route only exists while the flag is on, so reaching this method at
  /// all already means the flow is enabled.
  async confirmCash(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { rideId } = req.params as { rideId: string };
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const caller = requireCaller(req);
    const driver = await this.driverRepository.findByUserId(caller.userId);
    if (!driver) throw new RidePaymentNotFoundError(rideId);

    const result = await this.paymentService.withIdempotency(
      caller.userId,
      '/rides/payment/confirm-cash',
      idempotencyKey,
      { rideId },
      async () => {
        const outcome = await this.rideCollectionService.confirmCash(rideId, {
          expectedDriverId: driver.id,
        });
        // A driver who is not on this ride, a ride that is not cash, and a
        // ride that is not awaiting confirmation are one answer on purpose:
        // distinguishing them would let a driver probe other people's rides.
        if (outcome === 'NOT_COLLECTABLE') throw new RidePaymentNotFoundError(rideId);
        if (outcome !== 'COLLECTED' && outcome !== 'ALREADY_SETTLED') {
          throw new CashConfirmationNotApplicableError();
        }
        return this.view(req, rideId);
      },
    );
    reply.send({ data: result });
  }

  /// The rider's own outstanding balance (BD-2), or a driver's outstanding
  /// commission (BD-3).
  async getMyDebt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const caller = requireCaller(req);
    const driver = await this.driverRepository.findByUserId(caller.userId);
    const rider = await this.debtService.riderDebt(caller.userId);
    reply.send({
      data: {
        rider: {
          outstanding: rider.outstanding.toNumber(),
          limit: rider.limit.toNumber(),
          blocked: rider.blocked,
        },
        // No limit and no blocked flag: BD-3 approved no driver blocking, and
        // shipping those fields would be an invitation to start enforcing them.
        ...(driver
          ? {
              driver: {
                outstanding: (await this.debtService.driverOutstanding(driver.id)).toNumber(),
              },
            }
          : {}),
      },
    });
  }

  /// Resolves the ride and checks the caller is party to it.
  ///
  /// A caller who is not party gets the same `404` as a ride that does not
  /// exist. A `403` would confirm the ride is real, which is exactly the
  /// enumeration the platform avoids everywhere else.
  private async view(
    req: FastifyRequest,
    rideId: string,
    options: { riderOnly?: boolean } = {},
  ): Promise<RidePaymentView> {
    const ride = await this.rideRepository.findById(rideId);
    if (!ride) throw new RidePaymentNotFoundError(rideId);

    const caller = requireCaller(req);
    const isRider = ride.customerId === caller.userId;
    const driverUserId = (ride as { driver?: { userId?: string } }).driver?.userId;
    const isParty = options.riderOnly
      ? isRider
      : isRider || (driverUserId != null && driverUserId === caller.userId);
    if (!isParty && !callerHasRole(req, 'admin', 'support')) {
      throw new RidePaymentNotFoundError(rideId);
    }

    const [fare, attempts] = await Promise.all([
      this.rideFareRepository.findByRideId(rideId),
      this.ridePaymentRepository.findByRideId(rideId),
    ]);
    const succeeded = attempts.find((attempt) => attempt.status === 'SUCCEEDED');
    const projection = projectCollectionState({
      paymentStatus: ride.paymentStatus,
      method: ride.paymentMethod,
      attempts,
      totalFare: fare?.totalFare ?? new Decimal(0),
    });

    return {
      rideId,
      collectionState: projection.collectionState,
      method: ride.paymentMethod,
      amount: (fare?.totalFare ?? new Decimal(0)).toNumber(),
      settledAt: succeeded?.settledAt ?? null,
      attempts: attempts.filter((attempt) => attempt.status === 'FAILED').length,
      amountOwed: projection.amountOwed.toNumber(),
    };
  }
}
