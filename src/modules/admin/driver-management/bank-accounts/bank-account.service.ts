import { DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import { SystemSettingService } from '@modules/admin/system-settings/services/system-setting.service.js';
import {
  BANK_ENCRYPTION_VERIFIED_SETTING,
  maskAccountNumber,
} from '@shared/crypto/bank-account-crypto.js';
import type {
  BankAccountStatus,
  DriverBankAccount,
  Prisma,
} from '../../../../generated/prisma/index.js';
import { recordAdminAction } from '../../audit/index.js';
import {
  AdminDriverConflictError,
  BankAccountNotFoundError,
  BankAccountSameActorError,
  BankAccountSecurityNotReadyError,
  BankAccountTransitionError,
} from '../driver.errors.js';

/// The only shape a bank account ever leaves the API in: last four digits,
/// masked. Neither the legacy plaintext column nor the ciphertext nor the hash
/// is ever included.
export interface BankAccountDto {
  id: string;
  driverId: string;
  accountHolderName: string | null;
  bankName: string | null;
  ifscCode: string | null;
  accountNumberMasked: string | null;
  upiId: string | null;
  status: BankAccountStatus;
  verificationStatus: string;
  payoutEnabled: boolean;
  isActive: boolean;
  isDefault: boolean;
  verifiedAt: string | null;
  payoutEnabledAt: string | null;
  createdAt: string;
}

export function toBankAccountDto(account: DriverBankAccount): BankAccountDto {
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
    isActive: account.isActive,
    isDefault: account.isDefault,
    verifiedAt: account.verifiedAt?.toISOString() ?? null,
    payoutEnabledAt: account.payoutEnabledAt?.toISOString() ?? null,
    createdAt: account.createdAt.toISOString(),
  };
}

interface TransitionSpec {
  action: string;
  from: readonly BankAccountStatus[];
  data: Prisma.DriverBankAccountUpdateManyMutationInput;
  summary: string;
  guard?: (account: DriverBankAccount, tx: TransactionClient) => Promise<void>;
}

/// Phase 1 bank-account verification gate.
///
///   ENTERED ─verify─▶ VERIFIED ─enable payouts─▶ PAYOUT_ENABLED
///      │                 │  ◀──disable payouts──────┘
///      └──reject──▶ REJECTED        any ─deactivate─▶ DEACTIVATED
///
/// Approving a driver application no longer verifies the bank account — it
/// only enters it. Every transition is a conditional UPDATE on the state it
/// was read in (so two admins cannot race it), is audited in the same
/// transaction, and a DB CHECK keeps `payoutEnabled` true exactly on an active
/// PAYOUT_ENABLED account.
export class AdminBankAccountService {
  constructor(
    private readonly db: DatabaseService,
    private readonly systemSettingService: SystemSettingService,
  ) {}

  async list(driverId: string): Promise<BankAccountDto[]> {
    const rows = await this.db.client.driverBankAccount.findMany({
      where: { driverId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toBankAccountDto);
  }

  async verify(driverId: string, accountId: string, actorId: string): Promise<BankAccountDto> {
    return this.transition(driverId, accountId, actorId, {
      action: 'verify',
      from: ['ENTERED', 'PROVISIONED'],
      summary: 'Bank account verified',
      guard: async (account) => {
        assertEncrypted(account);
        // Separation of duties: whoever entered the details cannot vouch for them.
        if (account.enteredBy != null && account.enteredBy === actorId) {
          throw new BankAccountSameActorError();
        }
      },
      data: {
        status: 'VERIFIED',
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
        verifiedBy: actorId,
        statusReason: null,
      },
    });
  }

  async reject(
    driverId: string,
    accountId: string,
    actorId: string,
    reason: string,
  ): Promise<BankAccountDto> {
    return this.transition(driverId, accountId, actorId, {
      action: 'reject',
      from: ['ENTERED', 'PROVISIONED', 'VERIFIED'],
      summary: 'Bank account rejected',
      data: {
        status: 'REJECTED',
        verificationStatus: 'REJECTED',
        payoutEnabled: false,
        statusReason: reason,
      },
    });
  }

  async enablePayouts(
    driverId: string,
    accountId: string,
    actorId: string,
  ): Promise<BankAccountDto> {
    return this.transition(driverId, accountId, actorId, {
      action: 'enable payouts on',
      from: ['VERIFIED'],
      summary: 'Bank account enabled for payouts',
      guard: async (account, tx) => {
        assertEncrypted(account);
        if (
          !(await this.systemSettingService.getSettingValue(BANK_ENCRYPTION_VERIFIED_SETTING, tx))
        ) {
          throw new BankAccountSecurityNotReadyError(
            'Payouts stay closed until the bank-account encryption backfill has been verified',
          );
        }
        // "Blocked" is the driver's user account being DEACTIVATED — the same
        // reading the admin driver list uses.
        const driver = await tx.driver.findUnique({
          where: { id: account.driverId },
          select: { isSuspended: true, user: { select: { status: true } } },
        });
        if (!driver || driver.isSuspended || driver.user.status === 'DEACTIVATED') {
          throw new AdminDriverConflictError(
            'A suspended or blocked driver cannot receive payouts',
          );
        }
      },
      data: {
        status: 'PAYOUT_ENABLED',
        payoutEnabled: true,
        payoutEnabledAt: new Date(),
        statusReason: null,
      },
    });
  }

  async disablePayouts(
    driverId: string,
    accountId: string,
    actorId: string,
    reason: string,
  ): Promise<BankAccountDto> {
    return this.transition(driverId, accountId, actorId, {
      action: 'disable payouts on',
      from: ['PAYOUT_ENABLED'],
      summary: 'Bank account payouts disabled',
      data: { status: 'VERIFIED', payoutEnabled: false, statusReason: reason },
    });
  }

  async deactivate(
    driverId: string,
    accountId: string,
    actorId: string,
    reason: string,
  ): Promise<BankAccountDto> {
    return this.transition(driverId, accountId, actorId, {
      action: 'deactivate',
      from: ['ENTERED', 'PROVISIONED', 'VERIFIED', 'PAYOUT_ENABLED', 'REJECTED'],
      summary: 'Bank account deactivated',
      data: {
        status: 'DEACTIVATED',
        isActive: false,
        payoutEnabled: false,
        deactivatedAt: new Date(),
        statusReason: reason,
      },
    });
  }

  private async transition(
    driverId: string,
    accountId: string,
    actorId: string,
    spec: TransitionSpec,
  ): Promise<BankAccountDto> {
    return this.db.client.$transaction(async (tx) => {
      const account = await tx.driverBankAccount.findFirst({ where: { id: accountId, driverId } });
      if (!account) throw new BankAccountNotFoundError();
      if (!spec.from.includes(account.status)) {
        throw new BankAccountTransitionError(account.status, spec.action);
      }
      await spec.guard?.(account, tx);
      const { count } = await tx.driverBankAccount.updateMany({
        where: { id: accountId, driverId, status: account.status },
        data: { ...spec.data, statusChangedAt: new Date(), statusChangedBy: actorId },
      });
      // Someone else moved it between the read and the write.
      if (count !== 1) throw new BankAccountTransitionError(account.status, spec.action);
      const updated = await tx.driverBankAccount.findUniqueOrThrow({ where: { id: accountId } });
      await recordAdminAction(tx, {
        actorId,
        action: 'UPDATE',
        entityType: 'driver_bank_account',
        entityId: accountId,
        summary: spec.summary,
        before: { status: account.status, payoutEnabled: account.payoutEnabled },
        after: {
          status: updated.status,
          payoutEnabled: updated.payoutEnabled,
          reason: updated.statusReason,
        },
      });
      return toBankAccountDto(updated);
    });
  }
}

function assertEncrypted(account: DriverBankAccount): void {
  if (!account.accountNumberCiphertext) {
    throw new BankAccountSecurityNotReadyError(
      'This account number is not encrypted yet; run the bank-account encryption backfill first',
    );
  }
}
