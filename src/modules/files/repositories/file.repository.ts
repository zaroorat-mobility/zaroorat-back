import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { File, FilePurpose } from '@core/database/types';

/** Fields required to reserve a `PENDING` row before signing (R-FILE-26). */
export interface CreateFileInput {
  ownerUserId: string;
  purpose: FilePurpose;
  storageKey: string;
  storageProvider: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadExpiresAt: Date;
  checksumSha256?: string | null;
}

/** The verified facts written when a file becomes `READY`. */
export interface CompleteFileInput {
  sizeBytes: number;
  completedAt: Date;
  checksumSha256?: string | null;
}

/**
 * Data access for `files` (files doc 03). Prisma only, no business rules —
 * validation lives in the service and the policy module.
 *
 * **Every read that a caller can reach is scoped by `ownerUserId`.** That is
 * doc 02 §4's rule and the reason FILE-INV-4 is a property of the queries rather
 * than of each handler: a wrong id returns no row, so there is no fetched object
 * to forget to compare. The same discipline the USER collections use.
 */
export class FileRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Reserve a `PENDING` row.
   *
   * Written **before** the upload URL is signed (R-FILE-26): if signing then
   * fails, the sweeper reclaims a row that never received bytes — harmless. The
   * reverse order would leave a client holding a valid write permission for a
   * key the system has no record of.
   * @param input The reservation fields.
   * @param tx Optional transaction client.
   * @returns The created row.
   */
  async create(input: CreateFileInput, tx?: TransactionClient): Promise<File> {
    return (tx ?? this.client).file.create({
      data: {
        ownerUserId: input.ownerUserId,
        purpose: input.purpose,
        storageKey: input.storageKey,
        storageProvider: input.storageProvider,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        uploadExpiresAt: input.uploadExpiresAt,
        ...(input.checksumSha256 != null ? { checksumSha256: input.checksumSha256 } : {}),
      },
    });
  }

  /**
   * Load one file, scoped to its owner.
   * @param id The file id.
   * @param ownerUserId The caller, applied in the `WHERE` clause.
   * @param tx Optional transaction client.
   * @returns The row, or `null` when absent or owned by someone else.
   */
  async findOwned(id: string, ownerUserId: string, tx?: TransactionClient): Promise<File | null> {
    return (tx ?? this.client).file.findFirst({ where: { id, ownerUserId } });
  }

  /**
   * Load a file eligible to be read at all, **not** scoped to an owner.
   *
   * The only query in this module that is not owner-scoped, and deliberately:
   * an ops reviewer is a legitimate non-owner, so ownership is a policy decision
   * made once the row is in hand (doc 02 §4). Everything the policy then denies
   * returns the same `404` an absent id would (FILE-INV-4).
   *
   * **Only `READY` is returned.** A `SUPERSEDED` or `DELETED` file is retained as
   * evidence (R-FILE-32), not served — reading history is an `admin` capability
   * that does not exist yet.
   * @param id The file id.
   * @returns The row, or `null` when absent or not readable.
   */
  async findReadable(id: string): Promise<File | null> {
    return this.client.file.findFirst({ where: { id, status: 'READY', deletedAt: null } });
  }

  /**
   * Load one file by id alone, for the module-to-module surface.
   *
   * The other query in this module that is not owner-scoped, alongside
   * {@link findReadable} — and for the same kind of reason: `supersede` is called
   * by an owning module with two file ids and no caller, so ownership is checked
   * by comparing the two rows rather than by the `WHERE` clause. **Not reachable
   * from any HTTP handler.**
   * @param id The file id.
   * @param tx Optional transaction client.
   * @returns The row, or `null`.
   */
  async findById(id: string, tx?: TransactionClient): Promise<File | null> {
    return (tx ?? this.client).file.findUnique({ where: { id } });
  }

  /**
   * Transition `PENDING → READY`, conditionally.
   *
   * The `status: 'PENDING'` predicate is what makes FILE-INV-6 structural: of
   * two concurrent completions exactly one updates a row, and the loser observes
   * `false` rather than emitting a second event. Same `updateMany`-returns-count
   * pattern AUTH uses for OTP outcomes.
   * @param id The file id.
   * @param input The verified size, completion time, and checksum.
   * @param tx Transaction client — the event commits with this write (R-FILE-24).
   * @returns `true` when this caller performed the transition.
   */
  async markReady(id: string, input: CompleteFileInput, tx: TransactionClient): Promise<boolean> {
    const { count } = await tx.file.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'READY',
        sizeBytes: input.sizeBytes,
        completedAt: input.completedAt,
        ...(input.checksumSha256 != null ? { checksumSha256: input.checksumSha256 } : {}),
      },
    });
    return count === 1;
  }

  /**
   * Mark a reservation dead after its bytes failed validation.
   *
   * `EXPIRED` rather than a delete: the row is evidence that an upload was
   * attempted and refused, and the sweeper removes it on its own schedule.
   * @param id The file id.
   * @returns `true` when a `PENDING` row was marked.
   */
  async markExpired(id: string): Promise<boolean> {
    const { count } = await this.client.file.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    return count === 1;
  }

  /**
   * Transition `READY → DELETED`, conditionally (R-FILE-18).
   *
   * Soft only: `deleted_at` is set and the row leaves every read path, but the
   * **object is not touched**. Erasure is the retention job's, never inline.
   *
   * Conditional for the same reason {@link markReady} is: of two concurrent
   * deletes exactly one updates a row, so exactly one `file.deleted` exists.
   * @param id The file id.
   * @param deletedAt The soft-delete instant, which starts the retention clock.
   * @param tx Transaction client — the event commits with this write (R-FILE-24).
   * @returns `true` when this caller performed the transition.
   */
  async softDelete(id: string, deletedAt: Date, tx: TransactionClient): Promise<boolean> {
    const { count } = await tx.file.updateMany({
      where: { id, status: 'READY' },
      data: { status: 'DELETED', deletedAt },
    });
    return count === 1;
  }

  /**
   * Transition `READY → SUPERSEDED`, conditionally (R-FILE-31).
   *
   * Status and successor are written **together** because
   * `ck_files_superseded_has_successor` makes either one alone illegal, and
   * `WHERE status = 'READY'` is what keeps the version chain a line under
   * concurrency: of two replacements of the same file exactly one transitions and
   * the other is told it is no longer current (FILE-INV-8). The `@unique` on
   * `superseded_by_id` is the database's backstop for the same thing.
   * @param id The file being replaced.
   * @param replacementId The file replacing it.
   * @param tx The **attaching module's** transaction (R-FILE-27).
   * @returns `true` when this caller performed the transition.
   */
  async markSuperseded(id: string, replacementId: string, tx: TransactionClient): Promise<boolean> {
    const { count } = await tx.file.updateMany({
      where: { id, status: 'READY' },
      data: { status: 'SUPERSEDED', supersededById: replacementId },
    });
    return count === 1;
  }

  /**
   * Reservations whose upload window has closed (R-FILE-22, doc 09 §4.1).
   *
   * `EXPIRED` is included alongside `PENDING` because doc 01 §7 ends that state
   * at the sweeper too — a row refused at completion is evidence an upload was
   * attempted, and nothing else ever collects it. Doc 09 §4.1's query names only
   * `PENDING`; see the phase-6 report.
   * @param now The sweep instant.
   * @param limit Batch size.
   * @returns Rows to reclaim, oldest first.
   */
  async findSweepable(now: Date, limit: number): Promise<File[]> {
    return this.client.file.findMany({
      where: { status: { in: ['PENDING', 'EXPIRED'] }, uploadExpiresAt: { lt: now } },
      orderBy: { uploadExpiresAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Remove a row outright — the sweeper's second step, and the only hard delete
   * in this module.
   *
   * Safe only for a reservation that never became `READY`: it was never
   * referenceable (R-FILE-6), so nothing can be pointing at it. Every other
   * disappearance in this module is a soft delete.
   * @param id The file id.
   * @returns `true` when a row was removed.
   */
  async deleteReservation(id: string): Promise<boolean> {
    const { count } = await this.client.file.deleteMany({
      where: { id, status: { in: ['PENDING', 'EXPIRED'] } },
    });
    return count === 1;
  }

  /**
   * Files whose retention window has closed (doc 09 §4.2).
   *
   * The clock starts at the **close**, not at upload: `deleted_at` for a deleted
   * file, and supersession for a superseded one (doc 03 §4A). A job that started
   * every clock at upload would archive an active driver's licence out from
   * under them on its eighth anniversary.
   *
   * Supersession has no column of its own, so `updated_at` stands in for it —
   * sound only because nothing writes to a `SUPERSEDED` row except retention,
   * which removes it from this query. Reported in phase 6 rather than papered
   * over.
   * @param due One cutoff per purpose; a file closed at or before its purpose's
   *        cutoff is eligible.
   * @param limit Batch size.
   * @returns Rows to process, longest-closed first.
   */
  async findRetainable(
    due: readonly { purpose: FilePurpose; closedBefore: Date }[],
    limit: number,
  ): Promise<File[]> {
    if (due.length === 0) return [];
    return this.client.file.findMany({
      where: {
        erasedAt: null,
        archivedAt: null,
        OR: due.map(({ purpose, closedBefore }) => ({
          purpose,
          OR: [
            { deletedAt: { lte: closedBefore } },
            { status: 'SUPERSEDED' as const, updatedAt: { lte: closedBefore } },
          ],
        })),
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Record a terminal retention outcome (FILE-INV-9).
   *
   * One method for both outcomes because they are mutually exclusive and the
   * database enforces it — `ck_files_archive_xor_erase` rejects a row carrying
   * both, which is what makes the `action` field in `file.erased` trustworthy.
   * @param id The file id.
   * @param outcome Which terminal outcome occurred.
   * @param at When it occurred.
   * @param tx Transaction client — the event commits with this write.
   * @returns `true` when this caller recorded the outcome.
   */
  async markRetired(
    id: string,
    outcome: 'ARCHIVED' | 'ERASED',
    at: Date,
    tx: TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.file.updateMany({
      where: { id, archivedAt: null, erasedAt: null },
      data: outcome === 'ARCHIVED' ? { archivedAt: at } : { erasedAt: at },
    });
    return count === 1;
  }

  /** How many reservations are outstanding — the `file.objects.pending` gauge. */
  async countPending(): Promise<number> {
    return this.client.file.count({ where: { status: 'PENDING' } });
  }

  /** How many closed files are still awaiting a terminal outcome (doc 09 §2.4). */
  async countAwaitingRetention(): Promise<number> {
    return this.client.file.count({
      where: {
        erasedAt: null,
        archivedAt: null,
        OR: [{ deletedAt: { not: null } }, { status: 'SUPERSEDED' }],
      },
    });
  }

  /**
   * Live object count and byte total per purpose (doc 09 §2.4).
   *
   * Emitted by the retention job once a night rather than computed on a scrape:
   * `sum(size_bytes) GROUP BY purpose` every fifteen seconds is a table scan on a
   * table that only grows.
   * @returns One row per purpose that has live files.
   */
  async storageByPurpose(): Promise<{ purpose: FilePurpose; files: number; bytes: number }[]> {
    const grouped = await this.client.file.groupBy({
      by: ['purpose'],
      where: { status: 'READY', deletedAt: null },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    return grouped.map((row) => ({
      purpose: row.purpose,
      files: row._count._all,
      bytes: row._sum.sizeBytes ?? 0,
    }));
  }

  /**
   * Total stored bytes for a user, for the quota check (R-FILE-30).
   *
   * Counts `PENDING` and `READY` and **excludes soft-deleted rows**: the bytes
   * survive until retention, but charging a user for storage they asked to
   * delete is indefensible (doc 08 §5).
   * @param ownerUserId The user.
   * @param purpose Optional, to scope the sum to one purpose.
   * @returns The byte total.
   */
  async totalBytesForUser(ownerUserId: string, purpose?: FilePurpose): Promise<number> {
    const result = await this.client.file.aggregate({
      where: {
        ownerUserId,
        deletedAt: null,
        status: { in: ['PENDING', 'READY'] },
        ...(purpose ? { purpose } : {}),
      },
      _sum: { sizeBytes: true },
    });
    return result._sum.sizeBytes ?? 0;
  }
}
