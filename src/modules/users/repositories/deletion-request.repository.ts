import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';

/** A row of the deletion ledger, as the service and the job need it. */
export interface DeletionRequest {
  id: string;
  userId: string;
  status: string;
  requestedAt: Date;
  scheduledFor: Date;
  erasedAt: Date | null;
  cancelledAt: Date | null;
}

/**
 * Data access for `account_deletion_requests` — the ledger the erasure job reads
 * (user doc 02 §2.8, doc 03 §6, R-USER-18/19). Prisma-only, no business rules.
 *
 * Before this table, `POST /me/delete-request` recorded its promise **only** as
 * an outbox event. That is a dispatch queue: append-only by platform policy, with
 * no "erased yet?" state to set and nothing to index a due-date scan on. The
 * endpoint was correct and audited and still accepted an obligation that nothing
 * in the system could discharge.
 */
export class DeletionRequestRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Record a request, or return the one already open.
   *
   * A repeat is the **same** request, not a second one: `scheduledFor` is the
   * date the user was told, and a second call must not quietly move it. The
   * partial unique index makes that structural — this is the read that turns the
   * constraint into an idempotent answer instead of a `500`.
   *
   * @param userId The departing account.
   * @param scheduledFor The earliest the erasure job may act.
   * @param tx Transaction client to join, so the row and its audit event commit
   *           together (omit for a standalone write).
   * @returns The open request — the existing one when there already was one.
   */
  async open(userId: string, scheduledFor: Date, tx?: TransactionClient): Promise<DeletionRequest> {
    const client = tx ?? this.client;
    const existing = await client.accountDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
    });
    if (existing) return existing;

    return client.accountDeletionRequest.create({ data: { userId, scheduledFor } });
  }

  /**
   * The open request for an account, if any.
   * @param userId Account UUID.
   * @param tx Transaction client to join (omit for a standalone read).
   * @returns The pending request, or `null`.
   */
  async findPending(userId: string, tx?: TransactionClient): Promise<DeletionRequest | null> {
    return (tx ?? this.client).accountDeletionRequest.findFirst({
      where: { userId, status: 'PENDING' },
    });
  }

  /**
   * Requests whose window has closed, oldest promise first.
   * @param now Reference instant.
   * @param limit Batch ceiling.
   * @returns Due requests.
   */
  async findDue(now: Date, limit: number): Promise<DeletionRequest[]> {
    return this.client.accountDeletionRequest.findMany({
      where: { status: 'PENDING', scheduledFor: { lte: now } },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
    });
  }

  /**
   * Mark a request discharged.
   *
   * Conditional on it still being `PENDING`, so two runners that both picked up
   * the same row produce one `ERASED` transition and one audit event between
   * them — the same `updateMany`-count pattern the session and file revocations
   * use.
   *
   * @param id Request UUID.
   * @param erasedAt When the erasure completed.
   * @param tx Transaction client to join.
   * @returns `true` if this call performed the transition.
   */
  async markErased(id: string, erasedAt: Date, tx?: TransactionClient): Promise<boolean> {
    const { count } = await (tx ?? this.client).accountDeletionRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'ERASED', erasedAt },
    });
    return count === 1;
  }

  /**
   * Cancel every open request for an account (an operator restored it).
   *
   * Plural because it costs nothing and asserts nothing: the partial unique index
   * already permits only one, and a cancel that quietly missed a second row would
   * erase a live account.
   *
   * @param userId Account UUID.
   * @param cancelledAt When the restore happened.
   * @param tx Transaction client to join, so the cancel and the restore commit
   *           together.
   * @returns Count of requests cancelled.
   */
  async cancelForUser(userId: string, cancelledAt: Date, tx?: TransactionClient): Promise<number> {
    const { count } = await (tx ?? this.client).accountDeletionRequest.updateMany({
      where: { userId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt },
    });
    return count;
  }
}
