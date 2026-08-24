import { Decimal } from '../../types/index.js';

/// The only payment vocabulary a client ever sees.
///
/// Neither internal `FAILED` appears here — not the attempt-level one, not the
/// obligation-level one (FR-041). `UNPAID` is what an open receivable looks
/// like from outside, and it says what the rider can act on rather than what
/// the collector last tried.
export type CollectionState =
  | 'AWAITING_COLLECTION'
  | 'AWAITING_CASH_CONFIRMATION'
  | 'RETRYING'
  | 'PAID'
  | 'UNPAID'
  | 'WRITTEN_OFF';

export interface CollectionProjection {
  collectionState: CollectionState;
  amountOwed: Decimal;
}

export interface CollectionInput {
  paymentStatus: 'PENDING' | 'AUTHORIZED' | 'PAID' | 'FAILED' | 'REFUNDED';
  method: string;
  // `ride_payments.status` is a plain String column, so this takes the
  // column's type rather than a narrowed union the database does not enforce.
  attempts: readonly { status: string }[];
  totalFare: Decimal;
}

/// Derives the public collection state from state that is already stored
/// (data-model §2.2).
///
/// Pure and computed per request on purpose: a stored copy of this is a second
/// source of truth for whether a rider owes money, and the two would drift the
/// first time a transition committed without touching the projection.
export function projectCollectionState(input: CollectionInput): CollectionProjection {
  const has = (status: string): boolean =>
    input.attempts.some((attempt) => attempt.status === status);

  if (input.paymentStatus === 'FAILED') {
    // A written-off receivable is closed, so nothing is owed on it (BD-1c).
    return has('WRITTEN_OFF')
      ? { collectionState: 'WRITTEN_OFF', amountOwed: new Decimal(0) }
      : { collectionState: 'UNPAID', amountOwed: input.totalFare };
  }

  if (input.paymentStatus === 'PAID') {
    return { collectionState: 'PAID', amountOwed: new Decimal(0) };
  }

  const zero = { amountOwed: new Decimal(0) };

  // Cash waits on a person, not on a gateway, so the retry budget never
  // applies to it. Reachable only while BD-5's flag is on; with the flag off
  // a cash ride is already PAID by the time anyone can ask.
  if (input.method === 'CASH' && !has('SUCCEEDED')) {
    return { collectionState: 'AWAITING_CASH_CONFIRMATION', ...zero };
  }

  // No attempt cap here on purpose. Exhausting the budget is what moves the
  // obligation to FAILED, and that branch is handled above — so while the
  // obligation is still PENDING, budget by definition remains.
  return has('FAILED')
    ? { collectionState: 'RETRYING', ...zero }
    : { collectionState: 'AWAITING_COLLECTION', ...zero };
}
