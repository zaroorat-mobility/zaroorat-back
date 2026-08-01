import { BaseRepository, DatabaseService } from '@core/database';

/** Ride states in which a ride is still in flight (nothing terminal). */
const ACTIVE_RIDE_STATES = [
  'REQUESTED',
  'SEARCHING',
  'ACCEPTED',
  'DRIVER_ARRIVING',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
] as const;

/** Ticket states in which a dispute is still open. */
const OPEN_TICKET_STATES = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'REOPENED'] as const;

/** A single reason an account cannot leave yet, named by its owning module. */
export interface Obligation {
  /** The module that is holding things up (`rides` | `wallet` | `support`). */
  module: string;
  /** Why, from a fixed vocabulary — never free text. */
  code: string;
}

/**
 * Answers one question for the departure flow: does this account still owe the
 * platform, or the platform this account, anything? (R-USER-21.)
 *
 * **This is a seam, not a home.** R-USER-21 is a cross-module read: USER must ask
 * `rides`, `wallet`, and `support` whether the account is clear, and it does not
 * model those obligations itself. Those modules have no services yet, so the
 * question is asked of their tables directly — one bounded existence check each,
 * no joins, no business logic about what a ride or a ticket *means*. When each
 * module ships its own service, the method below is replaced by a call to it and
 * nothing else in this module changes.
 *
 * Deliberately **fails closed on nothing**: an unreachable database throws, and
 * the caller turns that into a `500` rather than letting an account leave with an
 * open obligation.
 */
export class ObligationsRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Collect every reason this account cannot deactivate yet.
   *
   * All three checks run — the client gets the complete list rather than
   * discovering one blocker per attempt (doc 04 §3: `details` names the blocking
   * module so the client can link straight to it).
   *
   * @param userId Account UUID.
   * @returns One entry per blocking module; empty means the account is clear.
   */
  async findOpenObligations(userId: string): Promise<Obligation[]> {
    const [ride, wallet, ticket] = await Promise.all([
      this.client.ride.findFirst({
        where: { customerId: userId, status: { in: [...ACTIVE_RIDE_STATES] } },
        select: { id: true },
      }),
      // Either direction is unsettled: a positive balance is money the platform
      // owes and would strand, a locked one is a transaction still in flight.
      this.client.customerWallet.findFirst({
        where: { userId, NOT: { balance: 0, lockedBalance: 0 } },
        select: { id: true },
      }),
      this.client.supportTicket.findFirst({
        where: { userId, status: { in: [...OPEN_TICKET_STATES] } },
        select: { id: true },
      }),
    ]);

    const obligations: Obligation[] = [];
    if (ride) obligations.push({ module: 'rides', code: 'RIDE_IN_PROGRESS' });
    if (wallet) obligations.push({ module: 'wallet', code: 'BALANCE_UNSETTLED' });
    if (ticket) obligations.push({ module: 'support', code: 'DISPUTE_OPEN' });
    return obligations;
  }
}
