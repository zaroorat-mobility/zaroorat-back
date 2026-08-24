import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
const ACTIVE_RIDE_STATES = [
  'REQUESTED',
  'SEARCHING',
  'ACCEPTED',
  'DRIVER_ARRIVING',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
] as const;
const OPEN_TICKET_STATES = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'REOPENED'] as const;
export interface Obligation {
  module: string;
  code: string;
}
export class ObligationRepository extends BaseRepository {
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }
  async findOpenObligations(userId: string, tx?: TransactionClient): Promise<Obligation[]> {
    const client = tx ?? this.client;
    const [ride, wallet, receivable, ticket] = await Promise.all([
      client.ride.findFirst({
        where: { customerId: userId, status: { in: [...ACTIVE_RIDE_STATES] } },
        select: { id: true },
      }),
      client.customerWallet.findFirst({
        where: { userId, NOT: { balance: 0, lockedBalance: 0 } },
        select: { id: true },
      }),
      // Money the customer owes the platform. It used to be representable as a
      // negative wallet balance; the balance floor added for FR-003 makes that
      // impossible, and an outstanding fare is now the obligation state
      // `Ride.paymentStatus = FAILED` with no write-off attempt behind it
      // (data-model §2A). A written-off receivable is closed (BD-1c) and must
      // not hold an account open forever.
      client.ride.findFirst({
        where: {
          customerId: userId,
          paymentStatus: 'FAILED',
          NOT: { payments: { some: { status: 'WRITTEN_OFF' } } },
        },
        select: { id: true },
      }),
      client.supportTicket.findFirst({
        where: { userId, status: { in: [...OPEN_TICKET_STATES] } },
        select: { id: true },
      }),
    ]);
    const obligations: Obligation[] = [];
    if (ride) obligations.push({ module: 'rides', code: 'RIDE_IN_PROGRESS' });
    if (wallet) obligations.push({ module: 'wallet', code: 'BALANCE_UNSETTLED' });
    if (receivable) obligations.push({ module: 'payments', code: 'PAYMENT_UNSETTLED' });
    if (ticket) obligations.push({ module: 'support', code: 'DISPUTE_OPEN' });
    return obligations;
  }
}
export const ObligationsRepository = ObligationRepository;
export type ObligationsRepository = ObligationRepository;
