import type { DatabaseService } from '@core/database';
import { TransactionManager, type TransactionClient } from '@core/database/TransactionManager.js';
import { Decimal } from '@modules/payments/types/index.js';
import { WalletService } from '@modules/payments/services/wallet/wallet.service.js';
import { SettlementWalletRepository } from '@modules/payments/repositories/settlement-wallet.repository.js';
import type {
  ReferralQualifyingEvent,
  ReferralProgramAudience,
} from '../../generated/prisma/index.js';
import { logger } from '@shared/logger/index.js';
import { Prisma } from '../../generated/prisma/index.js';
import { ReferralMetrics } from './referral.metrics.js';
import { ReferralRewardWalletMissingError } from './referral.errors.js';

/// A unique violation reaches this module as P2002 from the query engine, or as
/// P2010 carrying a driver-adapter cause when it comes from a raw statement.
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === 'P2002') return true;
  if (err.code !== 'P2010') return false;
  const meta = err.meta as { driverAdapterError?: { cause?: { kind?: string } } } | undefined;
  return meta?.driverAdapterError?.cause?.kind === 'UniqueConstraintViolation';
}

type DbClient = DatabaseService['client'] | TransactionClient;

const RIDE_EVENTS: ReferralQualifyingEvent[] = ['FIRST_RIDE', 'NTH_RIDE'];
const DRIVER_RIDE_EVENTS: ReferralQualifyingEvent[] = ['DRIVER_FIRST_RIDE', 'DRIVER_NTH_RIDE'];

function toNum(value: { toString(): string } | number): number {
  return typeof value === 'number' ? value : Number(value.toString());
}

export class ReferralRuntimeService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly transactionManager: TransactionManager,
    private readonly walletService: WalletService,
    private readonly settlementWalletRepository: SettlementWalletRepository,
    private readonly referralMetrics: ReferralMetrics,
  ) {}

  async onReferralApplied(referralId: string, tx?: DbClient): Promise<void> {
    const client = tx ?? this.databaseService.client;
    const referral = await client.referral.findUnique({
      where: { id: referralId },
      include: { program: true },
    });
    if (!referral || referral.program.qualifyingEvent !== 'SIGNUP') return;
    if (tx) {
      await this.qualifyAndReward(referral.id, tx);
      return;
    }
    await this.transactionManager.execute(async (innerTx) => {
      await this.qualifyAndReward(referralId, innerTx);
    });
  }

  async handleRideCompleted(rideId: string): Promise<void> {
    const ride = await this.databaseService.client.ride.findUnique({
      where: { id: rideId },
      include: { driver: { select: { userId: true } } },
    });
    if (!ride || ride.status !== 'COMPLETED') return;

    await this.processRideForReferee(ride.customerId, 'RIDER', rideId);
    if (ride.driver?.userId) {
      await this.processRideForReferee(ride.driver.userId, 'DRIVER', rideId);
    }
  }

  async handleDriverVerified(userId: string): Promise<void> {
    const referrals = await this.databaseService.client.referral.findMany({
      where: {
        refereeId: userId,
        status: 'SIGNED_UP',
        program: { audience: 'DRIVER', qualifyingEvent: 'DRIVER_APPROVED' },
      },
      select: { id: true },
    });
    for (const row of referrals) {
      try {
        await this.transactionManager.execute(async (tx) => {
          await this.qualifyAndReward(row.id, tx);
        });
      } catch (err) {
        logger.error(
          { err, referralId: row.id, userId },
          '[referral] driver approved reward failed',
        );
      }
    }
  }

  private async processRideForReferee(
    refereeUserId: string,
    audience: ReferralProgramAudience,
    rideId: string,
  ): Promise<void> {
    const events = audience === 'RIDER' ? RIDE_EVENTS : DRIVER_RIDE_EVENTS;
    const referrals = await this.databaseService.client.referral.findMany({
      where: {
        refereeId: refereeUserId,
        status: 'SIGNED_UP',
        program: { audience, qualifyingEvent: { in: events } },
      },
      include: { program: true },
    });

    for (const referral of referrals) {
      try {
        await this.transactionManager.execute(async (tx) => {
          const fresh = await tx.referral.findUnique({
            where: { id: referral.id },
            include: { program: true },
          });
          if (!fresh || fresh.status !== 'SIGNED_UP') return;
          if (this.isExpired(fresh.expiresAt)) {
            await tx.referral.update({ where: { id: fresh.id }, data: { status: 'EXPIRED' } });
            return;
          }

          // FR-022. Claim this ride for this referral first. The unique
          // constraint on (referral_id, ride_id) is what makes the consumer safe
          // to run twice — `ride.completed` is delivered at least once, and the
          // old bare increment counted a redelivered ride again every time.
          try {
            await tx.referralQualifyingRide.create({
              data: { referralId: fresh.id, rideId },
            });
          } catch (err) {
            if (isUniqueViolation(err)) {
              // Already counted. Not an error — this is the redelivery the
              // constraint exists to absorb.
              return;
            }
            throw err;
          }

          // Derived from the rows, not incremented, so the counter cannot drift
          // from the set of rides that actually qualified.
          const nextCount = await tx.referralQualifyingRide.count({
            where: { referralId: fresh.id },
          });
          await tx.referral.update({
            where: { id: fresh.id },
            data: { qualifyingRides: nextCount },
          });

          if (nextCount >= fresh.program.qualifyingThreshold) {
            await this.qualifyAndReward(fresh.id, tx);
          }
        });
      } catch (err) {
        logger.error({ err, referralId: referral.id }, '[referral] ride qualification failed');
      }
    }
  }

  private isExpired(expiresAt: Date | null): boolean {
    return expiresAt != null && expiresAt.getTime() < Date.now();
  }

  private async qualifyAndReward(referralId: string, tx: TransactionClient): Promise<void> {
    const referral = await tx.referral.findUnique({
      where: { id: referralId },
      include: { program: true, rewards: true },
    });
    if (!referral) return;
    if (referral.status === 'REWARDED' || referral.status === 'EXPIRED') return;
    if (this.isExpired(referral.expiresAt)) {
      await tx.referral.update({ where: { id: referralId }, data: { status: 'EXPIRED' } });
      return;
    }

    const now = new Date();
    if (referral.status !== 'QUALIFIED') {
      await tx.referral.update({
        where: { id: referralId },
        data: { status: 'QUALIFIED', qualifiedAt: now },
      });
    }

    const program = referral.program;
    const referrerAmount = toNum(program.referrerReward);
    const refereeAmount = toNum(program.refereeReward);

    if (referrerAmount > 0 && !referral.rewards.some((r) => r.beneficiary === 'REFERRER')) {
      await this.grantReward({
        tx,
        referralId,
        beneficiary: 'REFERRER',
        userId: referral.referrerId,
        amount: referrerAmount,
        program,
        description: `Referral reward — ${program.code}`,
      });
    }

    if (
      refereeAmount > 0 &&
      referral.refereeId &&
      !referral.rewards.some((r) => r.beneficiary === 'REFEREE')
    ) {
      await this.grantReward({
        tx,
        referralId,
        beneficiary: 'REFEREE',
        userId: referral.refereeId,
        amount: refereeAmount,
        program,
        description: `Welcome referral reward — ${program.code}`,
      });
    }

    await tx.referral.update({
      where: { id: referralId },
      data: { status: 'REWARDED', rewardedAt: now },
    });

    await this.processMilestones(referral.referrerId, program.id, referralId, program, tx);
  }

  private async grantReward(input: {
    tx: TransactionClient;
    referralId: string;
    beneficiary: 'REFERRER' | 'REFEREE' | 'MILESTONE';
    userId: string;
    amount: number;
    program: { code: string; rewardWallet: 'CUSTOMER' | 'DRIVER' };
    description: string;
    milestoneId?: string;
  }): Promise<void> {
    const amount = new Decimal(input.amount);
    const reward = await input.tx.referralReward.create({
      data: {
        referralId: input.referralId,
        beneficiary: input.beneficiary,
        userId: input.userId,
        amount: input.amount,
        rewardType: 'WALLET',
        status: 'PENDING',
      },
    });

    let walletTxnId: string | null;
    if (input.program.rewardWallet === 'DRIVER') {
      const driver = await input.tx.driver.findUnique({ where: { userId: input.userId } });
      if (!driver) {
        // FR-023. This used to `return`, so `qualifyAndReward` carried on and set
        // the referral to REWARDED while the ReferralReward row it had just
        // created stayed PENDING. The status guard at the top of that method then
        // short-circuited forever and no job swept pending rewards: money owed,
        // booked as paid, and unrecoverable without someone noticing by hand.
        //
        // Throwing rolls the whole transaction back — reward row included — so
        // the referral stays QUALIFIED and is retried rather than silently lost.
        this.referralMetrics.rewardWalletMissing({ beneficiary: input.beneficiary });
        throw new ReferralRewardWalletMissingError(
          `No driver wallet for user ${input.userId}; referral reward cannot be credited`,
        );
      }
      const wallet = await this.settlementWalletRepository.credit(
        {
          driverId: driver.id,
          amount,
          referenceType: 'REFERRAL',
          referenceId: reward.id,
          description: input.description,
          txnType: 'BONUS',
        },
        input.tx,
      );
      const txn = await input.tx.driverWalletTransaction.findFirst({
        where: { walletId: wallet.id, referenceId: reward.id },
        orderBy: { createdAt: 'desc' },
      });
      walletTxnId = txn?.id ?? null;
    } else {
      await this.walletService.creditInTx(input.userId, amount, input.tx, {
        referenceType: 'REFERRAL',
        referenceId: reward.id,
        description: input.description,
        txnType: 'REFERRAL',
      });
      const txn = await input.tx.customerWalletTransaction.findFirst({
        where: { userId: input.userId, referenceId: reward.id },
        orderBy: { createdAt: 'desc' },
      });
      walletTxnId = txn?.id ?? null;
    }

    if (walletTxnId === null) {
      // The credit call returned without a transaction row to point at. That
      // should not happen, and leaving the reward PENDING while the referral is
      // marked REWARDED is exactly the silent loss FR-023 exists to stop.
      this.referralMetrics.rewardCreditUnverified({ beneficiary: input.beneficiary });
    }

    await input.tx.referralReward.update({
      where: { id: reward.id },
      data: {
        status: 'CREDITED',
        creditedAt: new Date(),
        walletTransactionId: walletTxnId,
      },
    });
    this.referralMetrics.rewardCredited({ beneficiary: input.beneficiary });

    if (input.beneficiary === 'MILESTONE' && input.milestoneId) {
      await input.tx.referralMilestoneAchievement.create({
        data: {
          milestoneId: input.milestoneId,
          userId: input.userId,
          referralId: input.referralId,
          rewardId: reward.id,
        },
      });
    }
  }

  private async processMilestones(
    referrerId: string,
    programId: string,
    triggeringReferralId: string,
    program: { code: string; rewardWallet: 'CUSTOMER' | 'DRIVER' },
    tx: TransactionClient,
  ): Promise<void> {
    const rewardedCount = await tx.referral.count({
      where: { referrerId, programId, status: 'REWARDED' },
    });

    const milestones = await tx.referralMilestone.findMany({
      where: { programId, isActive: true, requiredReferrals: { lte: rewardedCount } },
      orderBy: { requiredReferrals: 'asc' },
    });

    for (const milestone of milestones) {
      const existing = await tx.referralMilestoneAchievement.findUnique({
        where: { milestoneId_userId: { milestoneId: milestone.id, userId: referrerId } },
      });
      if (existing) continue;

      await this.grantReward({
        tx,
        referralId: triggeringReferralId,
        beneficiary: 'MILESTONE',
        userId: referrerId,
        amount: toNum(milestone.bonusAmount),
        program,
        description: `Referral milestone "${milestone.name}" — ${program.code}`,
        milestoneId: milestone.id,
      });
    }
  }
}
