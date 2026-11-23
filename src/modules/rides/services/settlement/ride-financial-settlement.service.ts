import { randomUUID } from 'node:crypto';
import type { TransactionClient } from '@core/database/TransactionManager';
import { EventPublisher } from '@core/events';
import {
  CommissionService,
  FeatureFlagDependencyValidator,
  GstRecoveryService,
  NonRecoveryGstContraUnapprovedError,
  REV5_PRICING_FLAGS,
  TaxService,
  calculateCommission,
  calculateGstRecovery,
  calculatePassengerGst,
  type CommissionSnapshot,
  type FeatureFlagReader,
  type GstRecoverySnapshot,
  type ItemizedFareResult,
  type PassengerGstSnapshot,
  type PricingSnapshot,
} from '@modules/pricing';
import { CommissionWalletService } from '@modules/payments/services/commission-wallet/commission-wallet.service.js';
import { LedgerService } from '@modules/payments/services/ledger/ledger.service.js';
import { LEDGER_ACCOUNTS } from '@modules/payments/constants/payment.constants.js';
import { paymentEvent, PAYMENT_EVENT_CATALOG } from '@modules/payments/events/catalog.js';
import { DriverSubscriptionRepository } from '@modules/subscriptions/repositories/driver-subscription.repository.js';
import { logger } from '@shared/logger/index.js';
import type { Prisma } from '../../../../generated/prisma/index.js';
import { Decimal, type Ride, type RideRequest } from '../../types';
import {
  DriverSubscriptionRequiredError,
  InsufficientCommissionBalanceError,
  PaymentModelNotSelectedError,
} from '../../errors/ride.errors.js';

export interface AcceptFinancialPlan {
  path: 'A' | 'B';
  driverPaymentModel: 'SUBSCRIPTION' | 'COMMISSION';
  driverSubscriptionId: string | null;
  commissionAmount: Decimal | null;
  commissionSnapshot: CommissionSnapshot | null;
  passengerGstSnapshot: PassengerGstSnapshot | null;
  gstRecoverySnapshot: GstRecoverySnapshot | null;
  reservation: {
    enabled: boolean;
    commissionAmount: Decimal;
    gstRecoveryAmount: Decimal;
  } | null;
}

export interface Rev5CompletionOutcome {
  handledByRev5: boolean;
  skipLegacyTripLedger: boolean;
  adjustedTaxAmount: Decimal | null;
}

/// Phase 4 (Rev 5 §1.5, §1.6, §1.7, §4.1–§4.4):
/// Owns DriverEligibilityRouter (Path A grandfathered subscriber vs. Path B commission),
/// accept-time immutable snapshots & atomic wallet reservations, post-accept append-only
/// pricing revisions, and the atomic completion settlement transaction (G1 / G2 / G3).
export class RideFinancialSettlementService {
  constructor(
    private readonly commissionService: CommissionService,
    private readonly taxService: TaxService,
    private readonly gstRecoveryService: GstRecoveryService,
    private readonly featureFlagDependencyValidator: FeatureFlagDependencyValidator,
    private readonly featureFlagService: FeatureFlagReader,
    private readonly commissionWalletService: CommissionWalletService,
    private readonly ledgerService: LedgerService,
    private readonly driverSubscriptionRepository: DriverSubscriptionRepository,
    private readonly eventPublisher: EventPublisher,
  ) {}

  private async readFlagFlags() {
    const [
      commissionConfigSource,
      walletReservationEnabled,
      commissionWalletDeduction,
      passengerGstEnabled,
      gstRecoveryEnabled,
    ] = await Promise.all([
      this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.COMMISSION_CONFIG_SOURCE),
      this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.WALLET_RESERVATION_ENABLED),
      this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.COMMISSION_WALLET_DEDUCTION),
      this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.PASSENGER_GST_ENABLED),
      this.featureFlagService.isEnabledReadOnly(REV5_PRICING_FLAGS.GST_RECOVERY_ENABLED),
    ]);
    return {
      commissionConfigSource,
      walletReservationEnabled,
      commissionWalletDeduction,
      passengerGstEnabled,
      gstRecoveryEnabled,
      anyRev5FinancialFlagOn:
        commissionConfigSource ||
        walletReservationEnabled ||
        commissionWalletDeduction ||
        passengerGstEnabled ||
        gstRecoveryEnabled,
    };
  }

  /// DriverEligibilityRouter + Accept-time snapshot builder (Rev 5 §1.5 & §1.6).
  /// Runs inside `acceptRideRequest`'s PostgreSQL transaction.
  async prepareAcceptFinancials(
    input: {
      driverId: string;
      driverPaymentModel: string | null;
      request: RideRequest;
      legacyCommissionEstimator: () => Promise<number>;
    },
    tx: TransactionClient,
  ): Promise<AcceptFinancialPlan> {
    if (!input.driverPaymentModel) {
      throw new PaymentModelNotSelectedError();
    }

    const driverPaymentModel = input.driverPaymentModel as 'SUBSCRIPTION' | 'COMMISSION';

    // Path A — Grandfathered Active Unexpired Subscription Driver (Rev 5 R5-2)
    // Strictly bypasses ALL commission-wallet, GST, and reservation checks!
    if (driverPaymentModel === 'SUBSCRIPTION') {
      const activeSub = await this.driverSubscriptionRepository.findActive(input.driverId, tx);
      if (!activeSub || !activeSub.expiryDate || activeSub.expiryDate <= new Date()) {
        throw new DriverSubscriptionRequiredError();
      }
      return {
        path: 'A',
        driverPaymentModel: 'SUBSCRIPTION',
        driverSubscriptionId: activeSub.id,
        commissionAmount: null,
        commissionSnapshot: null,
        passengerGstSnapshot: null,
        gstRecoverySnapshot: null,
        reservation: null,
      };
    }

    // Path B — Commission-Model Driver
    const flags = await this.readFlagFlags();
    const rawSnap =
      input.request.pricingSnapshot && typeof input.request.pricingSnapshot === 'object'
        ? (input.request.pricingSnapshot as Partial<PricingSnapshot>)
        : null;
    const cityCode =
      typeof rawSnap?.cityCode === 'string' && rawSnap.cityCode !== 'GLOBAL'
        ? rawSnap.cityCode
        : null;
    const rawSnapObj = rawSnap as Record<string, unknown> | null;
    const serviceZoneId =
      typeof rawSnapObj?.serviceZoneId === 'string' ? rawSnapObj.serviceZoneId : null;
    const quotedFare = input.request.quotedFare != null ? Number(input.request.quotedFare) : 0;
    const _baseFare =
      typeof rawSnap?.rateCard?.baseFare === 'number' ? rawSnap.rateCard.baseFare : 0;
    const minimumFare =
      typeof rawSnap?.rateCard?.minimumFare === 'number' ? rawSnap.rateCard.minimumFare : 0;
    const bookingFee =
      typeof rawSnap?.rateCard?.bookingFee === 'number' ? rawSnap.rateCard.bookingFee : 0;
    const promoDiscount =
      typeof rawSnap?.promoDiscountAmount === 'number' ? rawSnap.promoDiscountAmount : 0;
    const estimatedRideSubtotal = Math.max(0, quotedFare - bookingFee);

    let commissionSnapshot: CommissionSnapshot | null = null;
    let commissionAmountNum: number;

    if (flags.commissionConfigSource) {
      const commConfig = await this.commissionService.resolve(
        {
          cityCode,
          serviceZoneId,
          vehicleTypeId: input.request.vehicleTypeId,
        },
        tx,
      );
      commissionSnapshot = calculateCommission(commConfig, {
        baseFare: estimatedRideSubtotal,
        distanceFare: 0,
        timeFare: 0,
        surgeAmount: 0,
        waitingCharge: 0,
        bookingFee,
        minimumFare,
        discountAmount: promoDiscount,
      });
      commissionAmountNum = commissionSnapshot.commissionAmount;
    } else {
      commissionAmountNum = await input.legacyCommissionEstimator();
    }

    let passengerGstSnapshot: PassengerGstSnapshot | null = null;
    if (flags.passengerGstEnabled) {
      const taxConfig = await this.taxService.resolveConfig(
        {
          kind: 'PASSENGER_RIDE_GST',
          cityCode,
          serviceZoneId,
          vehicleTypeId: input.request.vehicleTypeId,
        },
        tx,
      );
      const jurisdiction = await this.taxService.resolveJurisdiction(
        {
          cityCode: cityCode ?? 'GLOBAL',
          supplyKind: 'PASSENGER_RIDE',
        },
        tx,
      );
      passengerGstSnapshot = calculatePassengerGst(taxConfig, jurisdiction, {
        rideSubtotal: estimatedRideSubtotal,
        waitingCharge: 0,
        bookingFee,
      });
    }

    let gstRecoverySnapshot: GstRecoverySnapshot | null = null;
    let gstRecoveryAmountNum = 0;
    if (flags.gstRecoveryEnabled) {
      const recConfig = await this.gstRecoveryService.resolve(
        {
          cityCode,
          serviceZoneId,
          vehicleTypeId: input.request.vehicleTypeId,
        },
        tx,
      );
      gstRecoverySnapshot = calculateGstRecovery(recConfig, {
        passengerGstAmount: passengerGstSnapshot?.totalTaxAmount ?? 0,
        taxableValue: passengerGstSnapshot?.taxableValue ?? estimatedRideSubtotal,
        rideSubtotalBeforeDiscount: estimatedRideSubtotal,
      });
      gstRecoveryAmountNum = gstRecoverySnapshot.recoveryAmount;
    }

    const commissionAmount = new Decimal(commissionAmountNum);
    const gstRecoveryAmount = new Decimal(gstRecoveryAmountNum);

    // Coverage check: when wallet reservation is ON, reservation itself locks & verifies
    // availableBalance atomically right after the ride row is minted (same ACID tx!).
    // When wallet reservation is OFF, preserve existing pre-check (which also respects any active reservations).
    const totalRequired = commissionAmount.add(gstRecoveryAmount);
    if (!flags.walletReservationEnabled) {
      const sufficient = await this.commissionWalletService.hasSufficientBalance(
        input.driverId,
        totalRequired,
      );
      if (!sufficient) {
        throw new InsufficientCommissionBalanceError();
      }
    }

    return {
      path: 'B',
      driverPaymentModel: 'COMMISSION',
      driverSubscriptionId: null,
      commissionAmount,
      commissionSnapshot,
      passengerGstSnapshot,
      gstRecoverySnapshot,
      reservation: flags.walletReservationEnabled
        ? {
            enabled: true,
            commissionAmount: flags.commissionWalletDeduction ? commissionAmount : new Decimal(0),
            gstRecoveryAmount: flags.gstRecoveryEnabled ? gstRecoveryAmount : new Decimal(0),
          }
        : null,
    };
  }

  /// Creates the atomic `driver_wallet_reservations` row right after `rides` row creation inside `acceptRideRequest`.
  async lockAcceptReservation(
    rideId: string,
    driverId: string,
    plan: AcceptFinancialPlan,
    tx: TransactionClient,
  ): Promise<void> {
    if (plan.path !== 'B' || !plan.reservation?.enabled) return;
    await this.commissionWalletService.reserveForRideInTx(
      {
        driverId,
        rideId,
        commissionAmount: plan.reservation.commissionAmount,
        gstRecoveryAmount: plan.reservation.gstRecoveryAmount,
      },
      tx,
    );
  }

  /// Releases any ACTIVE reservation when a ride is cancelled (Rev 5 §4.4).
  async releaseOnCancellation(rideId: string, tx: TransactionClient): Promise<void> {
    await this.commissionWalletService.releaseReservationInTx(rideId, tx);
  }

  /// Rev 5 R5-5: Appends an immutable post-accept pricing revision row (`ride_pricing_revisions`)
  /// referencing ONLY original accept-time config IDs (`NEW_RIDES_ONLY`) and updating the
  /// wallet reservation atomically when applicable.
  async appendPricingRevision(
    input: {
      ride: Ride;
      reason: 'DESTINATION_CHANGE' | 'STOP_ADDED' | 'ROUTE_CHANGE' | 'COMPLETION_FINALIZATION';
      calculationDetails: Record<string, unknown>;
      newCommissionAmount?: Decimal;
      newGstRecoveryAmount?: Decimal;
      customerConfirmedAt?: Date | null;
      driverConfirmedAt?: Date | null;
      confirmedByActorId?: string | null;
    },
    tx: TransactionClient,
  ) {
    const latest = await tx.ridePricingRevision.aggregate({
      where: { rideId: input.ride.id },
      _max: { revisionNumber: true },
    });
    const nextRevision = (latest._max.revisionNumber ?? 0) + 1;

    let previousReserved = new Decimal(0);
    let newReserved = new Decimal(0);
    let deltaReserved = new Decimal(0);
    let walletReservationId: string | null = null;

    if (
      input.ride.driverPaymentModel === 'COMMISSION' &&
      input.newCommissionAmount !== undefined &&
      input.newGstRecoveryAmount !== undefined
    ) {
      const updated = await this.commissionWalletService.updateReservationDeltaInTx(
        {
          driverId: input.ride.driverId,
          rideId: input.ride.id,
          newCommissionAmount: input.newCommissionAmount,
          newGstRecoveryAmount: input.newGstRecoveryAmount,
        },
        tx,
      );
      previousReserved = updated.previousReserved;
      newReserved = updated.newReserved;
      deltaReserved = updated.deltaReserved;
      walletReservationId = updated.reservationId;
    }

    const commSnap = input.ride.commissionSnapshot as { configId?: string } | null;
    const taxSnap = input.ride.passengerGstSnapshot as { configId?: string } | null;
    const recSnap = input.ride.gstRecoverySnapshot as { configId?: string } | null;

    return tx.ridePricingRevision.create({
      data: {
        rideId: input.ride.id,
        revisionNumber: nextRevision,
        reason: input.reason,
        originalCommissionCfgId: commSnap?.configId ?? null,
        originalTaxCfgId: taxSnap?.configId ?? null,
        originalRecoveryCfgId: recSnap?.configId ?? null,
        calculationDetailsJson: input.calculationDetails as Prisma.InputJsonValue,
        previousReservedAmount: previousReserved,
        newReservedAmount: newReserved,
        deltaReservedAmount: deltaReserved,
        walletReservationId,
        customerConfirmedAt: input.customerConfirmedAt ?? null,
        driverConfirmedAt: input.driverConfirmedAt ?? null,
        confirmedByActorId: input.confirmedByActorId ?? null,
      },
    });
  }

  /// Rev 5 §4.3: Exact atomic completion settlement transaction (Path A vs. Path B; Mode A vs. Mode B).
  /// Runs inside `LifecycleService.completeRide`'s PostgreSQL ACID transaction.
  /// When ALL Rev 5 financial flags are OFF (default), returns `{ handledByRev5: false }` so
  /// legacy behavior remains 100% untouched.
  async settleCompletedRide(
    input: {
      ride: Ride;
      itemizedFare: ItemizedFareResult;
    },
    tx: TransactionClient,
  ): Promise<Rev5CompletionOutcome> {
    const flags = await this.readFlagFlags();
    const hasRev5RideData =
      input.ride.commissionSnapshot !== null ||
      input.ride.passengerGstSnapshot !== null ||
      input.ride.gstRecoverySnapshot !== null;

    if (!flags.anyRev5FinancialFlagOn && !hasRev5RideData) {
      return { handledByRev5: false, skipLegacyTripLedger: false, adjustedTaxAmount: null };
    }

    const { ride, itemizedFare } = input;

    // ─── PATH A: Grandfathered Subscription Ride (Rev 5 R5-2) ────────────────
    // Until D-11b has written Owner + CA approval: ZERO commission, ZERO TAX_PAYABLE,
    // ZERO GST recovery, ZERO wallet lock/reservation touch, 3 explicit audit step rows.
    if (ride.driverPaymentModel === 'SUBSCRIPTION') {
      const steps = ['COMMISSION_DEBIT', 'PASSENGER_GST_LIABILITY', 'GST_RECOVERY_DEBIT'] as const;
      for (const stepType of steps) {
        await tx.rideSettlementStep.upsert({
          where: { rideId_stepType: { rideId: ride.id, stepType } },
          update: {},
          create: {
            rideId: ride.id,
            stepType,
            status: 'SKIPPED_GRANDFATHERED_SUBSCRIPTION',
            amount: new Decimal(0),
          },
        });
      }
      return {
        handledByRev5: true,
        skipLegacyTripLedger: true,
        adjustedTaxAmount: new Decimal(0),
      };
    }

    // ─── PATH B: Commission-Model Ride (Rev 5 §4.1 & §4.3) ───────────────────
    if (ride.driverPaymentModel !== 'COMMISSION') {
      return { handledByRev5: false, skipLegacyTripLedger: false, adjustedTaxAmount: null };
    }

    // Consume active wallet reservation inside this ACID transaction (rolls back to ACTIVE on crash)
    await this.commissionWalletService.consumeReservationInTx(ride.id, tx);

    // Determine exact commission, passenger GST, and GST recovery amounts from immutable accept-time snapshots
    const commSnap = ride.commissionSnapshot as CommissionSnapshot | null;
    const taxSnap = ride.passengerGstSnapshot as PassengerGstSnapshot | null;
    const recSnap = ride.gstRecoverySnapshot as GstRecoverySnapshot | null;

    const commissionAmount = new Decimal(
      commSnap?.commissionAmount ?? (ride.commissionAmount ? Number(ride.commissionAmount) : 0),
    );
    const passengerGstAmount = new Decimal(taxSnap?.totalTaxAmount ?? 0);
    const gstRecoveryAmount = new Decimal(recSnap?.recoveryAmount ?? 0);

    // Record completion finalization revision (append-only, never mutates accept-time snapshots)
    await this.appendPricingRevision(
      {
        ride,
        reason: 'COMPLETION_FINALIZATION',
        calculationDetails: {
          finalTotalFare: itemizedFare.totalFare,
          commissionAmount: commissionAmount.toNumber(),
          passengerGstAmount: passengerGstAmount.toNumber(),
          gstRecoveryAmount: gstRecoveryAmount.toNumber(),
        },
      },
      tx,
    );

    // ── STEP G2: Passenger GST Liability (ONCE ONLY — never duplicated) ──────
    if (!flags.passengerGstEnabled || passengerGstAmount.lte(0)) {
      await tx.rideSettlementStep.upsert({
        where: {
          rideId_stepType: { rideId: ride.id, stepType: 'PASSENGER_GST_LIABILITY' },
        },
        update: {},
        create: {
          rideId: ride.id,
          stepType: 'PASSENGER_GST_LIABILITY',
          status: 'SKIPPED_DISABLED',
          amount: new Decimal(0),
        },
      });
    } else if (flags.gstRecoveryEnabled) {
      // Mode A (passenger_gst_enabled = ON, gst_recovery_enabled = ON):
      // Dr DRIVER_GST_RECOVERY_CLEARING / Cr TAX_PAYABLE (1x ONLY)
      const g2GroupId = randomUUID();
      await this.ledgerService.postTransactionGroup(
        [
          {
            account: LEDGER_ACCOUNTS.DRIVER_GST_RECOVERY_CLEARING,
            accountRefId: ride.driverId,
            direction: 'DEBIT',
            amount: passengerGstAmount,
            referenceType: 'RIDE',
            referenceId: ride.id,
            description: `Passenger GST clearing receivable for ride ${ride.id}`,
          },
          {
            account: LEDGER_ACCOUNTS.TAX_PAYABLE,
            direction: 'CREDIT',
            amount: passengerGstAmount,
            referenceType: 'RIDE',
            referenceId: ride.id,
            description: `Passenger ride GST liability (1x) for ride ${ride.id}`,
          },
        ],
        tx,
        g2GroupId,
      );
      await tx.rideSettlementStep.create({
        data: {
          rideId: ride.id,
          stepType: 'PASSENGER_GST_LIABILITY',
          status: 'POSTED',
          ledgerGroupId: g2GroupId,
          amount: passengerGstAmount,
        },
      });
    } else {
      // Mode B (passenger_gst_enabled = ON, gst_recovery_enabled = OFF — Rev 5 R5-1 / D-20):
      // NEVER touches DRIVER_GST_RECOVERY_CLEARING!
      const d20 = await this.featureFlagDependencyValidator.readNonRecoveryGstMode(tx);
      if (d20.mode === 'DRIVER_LIABLE_INFORMATIONAL') {
        await tx.rideSettlementStep.create({
          data: {
            rideId: ride.id,
            stepType: 'PASSENGER_GST_LIABILITY',
            status: 'SKIPPED_DRIVER_LIABLE',
            amount: passengerGstAmount,
          },
        });
      } else if (d20.mode === 'ZAROORAT_CONTRA_ACCOUNT' && d20.contraAccount) {
        const g2GroupId = randomUUID();
        await this.ledgerService.postTransactionGroup(
          [
            {
              account: d20.contraAccount,
              direction: 'DEBIT',
              amount: passengerGstAmount,
              referenceType: 'RIDE',
              referenceId: ride.id,
              description: `Mode B approved non-recovery GST contra for ride ${ride.id}`,
            },
            {
              account: LEDGER_ACCOUNTS.TAX_PAYABLE,
              direction: 'CREDIT',
              amount: passengerGstAmount,
              referenceType: 'RIDE',
              referenceId: ride.id,
              description: `Passenger ride GST liability (Mode B, 1x) for ride ${ride.id}`,
            },
          ],
          tx,
          g2GroupId,
        );
        await tx.rideSettlementStep.create({
          data: {
            rideId: ride.id,
            stepType: 'PASSENGER_GST_LIABILITY',
            status: 'POSTED',
            ledgerGroupId: g2GroupId,
            amount: passengerGstAmount,
          },
        });
      } else {
        throw new NonRecoveryGstContraUnapprovedError(
          'Mode B ride completion aborted: Finance/CA Decision D-20 non-recovery GST mode is unapproved.',
        );
      }
    }

    // ── STEP G1: Independent Commission Wallet Debit ─────────────────────────
    if (!flags.commissionWalletDeduction || commissionAmount.lte(0)) {
      await tx.rideSettlementStep.upsert({
        where: { rideId_stepType: { rideId: ride.id, stepType: 'COMMISSION_DEBIT' } },
        update: {},
        create: {
          rideId: ride.id,
          stepType: 'COMMISSION_DEBIT',
          status: 'SKIPPED_DISABLED',
          amount: new Decimal(0),
        },
      });
    } else {
      const commResult = await this.commissionWalletService.deductInTx(
        ride.driverId,
        ride.id,
        commissionAmount,
        tx,
      );
      if (commResult.outcome === 'DEDUCTED') {
        const g1GroupId = randomUUID();
        await this.ledgerService.postTransactionGroup(
          [
            {
              account: LEDGER_ACCOUNTS.DRIVER_COMMISSION_WALLET,
              accountRefId: ride.driverId,
              direction: 'DEBIT',
              amount: commResult.amount,
              referenceType: 'RIDE',
              referenceId: ride.id,
              description: `Ride commission deducted for ride ${ride.id}`,
            },
            {
              account: LEDGER_ACCOUNTS.PLATFORM_COMMISSION,
              direction: 'CREDIT',
              amount: commResult.amount,
              referenceType: 'RIDE',
              referenceId: ride.id,
              description: `Platform commission for ride ${ride.id}`,
            },
          ],
          tx,
          g1GroupId,
        );
        await tx.rideSettlementStep.create({
          data: {
            rideId: ride.id,
            stepType: 'COMMISSION_DEBIT',
            status: 'POSTED',
            ledgerGroupId: g1GroupId,
            walletTxnId: commResult.transaction.id,
            amount: commResult.amount,
          },
        });
        await this.eventPublisher.publish(
          paymentEvent(PAYMENT_EVENT_CATALOG.DRIVER_COMMISSION_WALLET_DEBITED, ride.driverId, {
            driverId: ride.driverId,
            rideId: ride.id,
            amount: commResult.amount.toNumber(),
          }),
          tx,
        );
      } else if (commResult.outcome === 'INSUFFICIENT_BALANCE') {
        await tx.commissionCollectionFailure.create({
          data: {
            rideId: ride.id,
            driverId: ride.driverId,
            kind: 'COMMISSION',
            amount: commResult.commissionAmount,
            balanceAtAttempt: commResult.actualBalance,
            status: 'OPEN',
          },
        });
        await tx.rideSettlementStep.create({
          data: {
            rideId: ride.id,
            stepType: 'COMMISSION_DEBIT',
            status: 'FAILED_INSUFFICIENT_BALANCE',
            amount: commResult.commissionAmount,
          },
        });
        logger.error(
          {
            rideId: ride.id,
            driverId: ride.driverId,
            commissionAmount: commResult.commissionAmount.toNumber(),
            actualBalance: commResult.actualBalance.toNumber(),
          },
          '[rides] Rev 5 G1 commission debit failed — recorded OPEN failure for recovery',
        );
        await this.eventPublisher.publish(
          paymentEvent(
            PAYMENT_EVENT_CATALOG.DRIVER_COMMISSION_WALLET_COLLECTION_FAILED,
            ride.driverId,
            {
              driverId: ride.driverId,
              rideId: ride.id,
              commissionAmount: commResult.commissionAmount.toNumber(),
              actualBalance: commResult.actualBalance.toNumber(),
            },
          ),
          tx,
        );
      }
    }

    // ── STEP G3: Independent Driver GST Wallet Recovery Debit ────────────────
    // Never runs in Mode B (gst_recovery_enabled = OFF) -> zero failure row created!
    if (!flags.gstRecoveryEnabled || gstRecoveryAmount.lte(0)) {
      await tx.rideSettlementStep.upsert({
        where: { rideId_stepType: { rideId: ride.id, stepType: 'GST_RECOVERY_DEBIT' } },
        update: {},
        create: {
          rideId: ride.id,
          stepType: 'GST_RECOVERY_DEBIT',
          status: 'SKIPPED_DISABLED',
          amount: new Decimal(0),
        },
      });
    } else {
      const recResult = await this.commissionWalletService.deductGstRecoveryInTx(
        ride.driverId,
        ride.id,
        gstRecoveryAmount,
        tx,
      );
      if (recResult.outcome === 'DEDUCTED') {
        const g3GroupId = randomUUID();
        // Clears DRIVER_GST_RECOVERY_CLEARING to ₹0.00 — NEVER re-credits TAX_PAYABLE!
        await this.ledgerService.postTransactionGroup(
          [
            {
              account: LEDGER_ACCOUNTS.DRIVER_COMMISSION_WALLET,
              accountRefId: ride.driverId,
              direction: 'DEBIT',
              amount: recResult.amount,
              referenceType: 'RIDE',
              referenceId: ride.id,
              description: `Driver wallet GST recovery for ride ${ride.id}`,
            },
            {
              account: LEDGER_ACCOUNTS.DRIVER_GST_RECOVERY_CLEARING,
              accountRefId: ride.driverId,
              direction: 'CREDIT',
              amount: recResult.amount,
              referenceType: 'RIDE',
              referenceId: ride.id,
              description: `Cleared passenger GST recovery receivable for ride ${ride.id}`,
            },
          ],
          tx,
          g3GroupId,
        );
        await tx.rideSettlementStep.create({
          data: {
            rideId: ride.id,
            stepType: 'GST_RECOVERY_DEBIT',
            status: 'POSTED',
            ledgerGroupId: g3GroupId,
            walletTxnId: recResult.transaction.id,
            amount: recResult.amount,
          },
        });
      } else if (recResult.outcome === 'INSUFFICIENT_BALANCE') {
        await tx.commissionCollectionFailure.create({
          data: {
            rideId: ride.id,
            driverId: ride.driverId,
            kind: 'GST_RECOVERY',
            amount: recResult.commissionAmount,
            balanceAtAttempt: recResult.actualBalance,
            status: 'OPEN',
          },
        });
        await tx.rideSettlementStep.create({
          data: {
            rideId: ride.id,
            stepType: 'GST_RECOVERY_DEBIT',
            status: 'FAILED_INSUFFICIENT_BALANCE',
            amount: recResult.commissionAmount,
          },
        });
        logger.error(
          {
            rideId: ride.id,
            driverId: ride.driverId,
            gstRecoveryAmount: recResult.commissionAmount.toNumber(),
            actualBalance: recResult.actualBalance.toNumber(),
          },
          '[rides] Rev 5 G3 GST recovery debit failed — recorded OPEN failure for recovery',
        );
        await this.eventPublisher.publish(
          paymentEvent(PAYMENT_EVENT_CATALOG.GST_RECOVERY_COLLECTION_FAILED, ride.driverId, {
            driverId: ride.driverId,
            rideId: ride.id,
            gstRecoveryAmount: recResult.commissionAmount.toNumber(),
            actualBalance: recResult.actualBalance.toNumber(),
          }),
          tx,
        );
      }
    }

    return {
      handledByRev5: true,
      skipLegacyTripLedger: true,
      adjustedTaxAmount: flags.passengerGstEnabled ? passengerGstAmount : new Decimal(0),
    };
  }
}
