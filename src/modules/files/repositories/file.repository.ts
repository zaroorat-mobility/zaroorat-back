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
