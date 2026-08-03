import { TransactionManager, UniqueConstraintError } from '@core/database';
import { EventPublisher } from '@core/events';
import { RedisService } from '@core/cache';
import { logger } from '@shared/logger/index.js';
import { fileConfig, type FilePurposeName } from '@config/file/file.config.js';
import { FileRepository } from './repositories/file.repository.js';
import { FileMetrics } from './file.metrics.js';
import { fileEvent } from './events/catalog.js';
import { buildStorageKey } from './storage-key.js';
import { inspect } from './content-inspector.js';
import { decideRead } from './read-policy.js';
import {
  assertDeclaredUploadAllowed,
  assertStoredObjectAllowed,
  peekBudgetFor,
  policyFor,
  sanitizeFileName,
} from './file.policy.js';
import {
  ChecksumMismatchError,
  ContentMismatchError,
  FileInUseError,
  FileNotFoundError,
  FileStateError,
  FileTooLargeError,
  UploadExpiredError,
  UploadNotFoundError,
} from './errors.js';
import { findLiveReference } from './file-references.js';
import { RateLimitedError } from '@modules/auth/errors';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { StorageConfig } from './storage.config.js';
import type { StorageProvider } from './providers/storage.provider.js';

/** What a client declares when asking for a write permission (doc 02 §2.1). */
export interface CreateUploadInput {
  ownerUserId: string;
  purpose: FilePurposeName;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256?: string;
  requestId?: string | null;
}

/** The `201` body of `POST /files` (doc 02 §2.1). */
export interface CreateUploadResult {
  fileId: string;
  status: 'PENDING';
  upload: {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expiresAt: Date;
  };
}

/** The `200` body of `POST /files/{id}/complete` (doc 02 §2.2). */
export interface CompleteUploadResult {
  fileId: string;
  status: 'READY';
  purpose: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  createdAt: Date;
}

/**
 * A file's whole life: upload, read, delete, and replacement (files doc 02).
 *
 * **No byte passes through this service.** The client PUTs directly to storage
 * using a permission scoped to one key, one method, one content-type, and one
 * size ceiling (R-FILE-1, R-FILE-2). What happens here is validation before the
 * permission is issued, and validation of what actually arrived afterwards.
 *
 * {@link assertReferenceable} and {@link supersede} are the module-to-module
 * surface — the only two methods here with no HTTP route, called by an owning
 * module inside its own transaction (R-FILE-27).
 */
export class FileService {
  /**
   * @param fileRepository Data access for `files`.
   * @param storageProvider The configured storage backend.
   * @param storageConfig Bucket, TTLs, and peek budgets.
   * @param transactionManager Unit of work for the `READY` transition.
   * @param eventPublisher Outbox writer.
   * @param redisService Rate limiting and stored-response idempotency.
   * @param fileMetrics Upload counters.
   */
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly storageProvider: StorageProvider,
    private readonly storageConfig: StorageConfig,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redisService: RedisService,
    private readonly fileMetrics: FileMetrics,
  ) {}

  /**
   * Reserve a file and mint a write permission (doc 02 §2.1).
   *
   * Ordering is R-FILE-26 and is the recoverable one: validate, write the
   * `PENDING` row, **then** sign. If signing fails after the row exists the
   * sweeper reclaims a reservation that never received bytes. The reverse order
   * would leave a client holding a valid permission for a key nothing knows
   * about — an object nobody can find, delete, or bill for.
   *
   * @param input The declared purpose, name, type, and size.
   * @returns The file id and its scoped upload permission.
   * @throws {UnsupportedMediaTypeError} Type not permitted for the purpose.
   * @throws {FileTooLargeError} Declared size over the ceiling, or over quota.
   * @throws {RateLimitedError} A per-user or per-purpose limit was hit.
   */
  async createUpload(input: CreateUploadInput): Promise<CreateUploadResult> {
    assertDeclaredUploadAllowed(input.purpose, input.contentType, input.sizeBytes);
    await this.assertWithinLimits(input.ownerUserId, input.purpose, input.sizeBytes);

    const policy = policyFor(input.purpose);
    const storageKey = buildStorageKey(input.purpose, input.contentType);
    const uploadExpiresAt = new Date(Date.now() + this.storageConfig.uploadUrlTtlSeconds * 1000);

    const file = await this.fileRepository.create({
      ownerUserId: input.ownerUserId,
      purpose: input.purpose,
      storageKey,
      storageProvider: this.storageProvider.name,
      fileName: sanitizeFileName(input.fileName, input.contentType),
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      uploadExpiresAt,
      ...(input.checksumSha256 != null ? { checksumSha256: input.checksumSha256 } : {}),
    });

    const signed = await this.storageProvider.signUpload({
      key: storageKey,
      contentType: input.contentType,
      maxBytes: policy.maxBytes,
      ttlSeconds: this.storageConfig.uploadUrlTtlSeconds,
      ...(input.checksumSha256 != null ? { checksumSha256: input.checksumSha256 } : {}),
    });

    this.fileMetrics.uploadRequested({ purpose: input.purpose });

    return {
      fileId: file.id,
      status: 'PENDING',
      upload: {
        method: signed.method,
        url: signed.url,
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      },
    };
  }

  /**
   * Verify the stored bytes and publish the file (doc 02 §2.2).
   *
   * Checks run cheapest-first, each a hard gate: real size, then declared type
   * against magic bytes, then decoded pixel count, then checksum. Nothing
   * expensive runs until everything cheap has passed.
   *
   * On any content failure the object is **deleted** and the row marked
   * `EXPIRED` — a reservation whose bytes were refused must not linger as
   * something a retry could complete.
   *
   * @param fileId The reserved file.
   * @param ownerUserId The caller, applied in the query's `WHERE` clause.
   * @param requestId Correlation id for the event envelope.
   * @returns The published file.
   * @throws {FileNotFoundError} No such file, or not the caller's.
   * @throws {FileStateError} The file is not awaiting completion.
   * @throws {UploadExpiredError} The permission window closed.
   * @throws {UploadNotFoundError} No object is at the key yet.
   * @throws {ContentMismatchError} The bytes are not the declared type.
   * @throws {ChecksumMismatchError} The declared digest does not match.
   * @throws {FileTooLargeError} The real size or pixel count is over the ceiling.
   */
  async completeUpload(
    fileId: string,
    ownerUserId: string,
    requestId: string | null = null,
  ): Promise<CompleteUploadResult> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId);
    if (!file) throw new FileNotFoundError();

    // Idempotent without a key: completing an already-READY file returns the
    // same body and emits nothing further (doc 02 §2.2).
    if (file.status === 'READY') return this.toResult(file);
    if (file.status !== 'PENDING') {
      throw new FileStateError('That file is not awaiting completion');
    }
    if (file.uploadExpiresAt.getTime() <= Date.now()) {
      await this.rejectUpload(file.id, file.storageKey, file.purpose, 'UPLOAD_EXPIRED');
      throw new UploadExpiredError();
    }

    const purpose = file.purpose as FilePurposeName;
    const peekBytes = peekBudgetFor(
      file.contentType,
      this.storageConfig.peekBytes,
      this.storageConfig.imagePeekBytes,
    );

    const head = await this.storageProvider.head(file.storageKey, peekBytes);
    if (!head) {
      // Recoverable: the row stays PENDING so the client can re-PUT and retry.
      this.fileMetrics.uploadRejected({ purpose, reason: 'UPLOAD_NOT_FOUND' });
      throw new UploadNotFoundError();
    }

    await this.verifyStoredObject(file.id, file.storageKey, purpose, file, head);

    const inspection = inspect(file.contentType, head.peek);
    if (!inspection.ok) {
      await this.rejectUpload(file.id, file.storageKey, purpose, 'CONTENT_MISMATCH');
      throw new ContentMismatchError();
    }
    try {
      assertStoredObjectAllowed(purpose, file.contentType, head.sizeBytes, inspection.dimensions);
    } catch (error) {
      await this.rejectUpload(file.id, file.storageKey, purpose, 'FILE_TOO_LARGE');
      throw error;
    }

    const completedAt = new Date();
    const transitioned = await this.publishReady(file, ownerUserId, head, completedAt, requestId);

    if (!transitioned) {
      // The other caller won. Return its result rather than an error: from the
      // client's side this retry succeeded, which is what idempotency means.
      const settled = await this.fileRepository.findOwned(fileId, ownerUserId);
      if (!settled) throw new FileNotFoundError();
      return this.toResult(settled);
    }

    this.fileMetrics.uploadCompleted({ purpose, sizeBytes: head.sizeBytes });
    this.fileMetrics.uploadDuration({
      purpose,
      ms: completedAt.getTime() - file.createdAt.getTime(),
    });

    return this.toResult({
      id: file.id,
      purpose: file.purpose,
      contentType: file.contentType,
      createdAt: file.createdAt,
      sizeBytes: head.sizeBytes,
      checksumSha256: head.checksumSha256 ?? file.checksumSha256,
    });
  }

  /**
   * Mint a short-lived signed read URL (doc 02 §2.3).
   *
   * Every call signs a **new** URL. Nothing is cached and no file has a stable
   * URL, ever (R-FILE-12) — a cached URL would carry somebody else's expiry and
   * nothing would revoke it when their session ended.
   *
   * When the caller is not the owner the audit event is written **before** the
   * URL is returned, and a failure to audit fails the read (doc 05 §3.2). This
   * is the one place in the module where an audit sits on the critical path,
   * and deliberately so: an unauditable privileged read must not happen.
   *
   * @param fileId The file to read.
   * @param caller The requesting user and their roles.
   * @param disposition How the client intends to render it.
   * @param requestId Correlation id for the audit envelope.
   * @returns The URL, its expiry, and the content-type.
   * @throws {FileNotFoundError} No such file, not readable, or not `READY` —
   *         all indistinguishable (FILE-INV-4).
   * @throws {RateLimitedError} The per-minute mint limit was hit.
   */
  async getReadUrl(
    fileId: string,
    caller: { userId: string; roles: readonly string[] },
    disposition: 'inline' | 'attachment' = 'inline',
    requestId: string | null = null,
  ): Promise<{ url: string; expiresAt: Date; contentType: string }> {
    const limit = await this.redisService.rateLimit.hit(
      'file:read',
      caller.userId,
      fileConfig.readUrlsPerUserPerMinute,
      60,
    );
    if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSeconds);

    const file = await this.loadReadable(fileId);
    const purpose = file.purpose as FilePurposeName;
    const grant = decideRead({ ownerUserId: file.ownerUserId, purpose }, caller);

    // Denial is indistinguishable from absence (doc 04 §4). Given a file id,
    // telling those apart would confirm a document exists for a specific driver.
    // The metric is where that signal lives instead (doc 09 §2.2).
    if (!grant.granted) {
      this.fileMetrics.readDenied({ purpose });
      throw new FileNotFoundError();
    }

    if (grant.actor === 'ops') {
      await this.transactionManager.execute(async (tx) => {
        await this.eventPublisher.publish(
          fileEvent('file.read', {
            aggregateId: file.id,
            subjectUserId: file.ownerUserId,
            requestId,
            data: {
              fileId: file.id,
              ownerUserId: file.ownerUserId,
              actorUserId: caller.userId,
              purpose,
              scope: grant.scope,
            },
          }),
          tx,
        );
      });
    }

    const signed = await this.storageProvider.signDownload({
      key: file.storageKey,
      ttlSeconds: policyFor(purpose).readTtlSeconds,
      contentType: file.contentType,
      disposition,
      fileName: file.fileName,
    });

    this.fileMetrics.readSigned({ purpose, actor: grant.actor });
    return { url: signed.url, expiresAt: signed.expiresAt, contentType: file.contentType };
  }

  /**
   * File metadata, without minting anything (doc 02 §2.4).
   *
   * Same visibility rules as {@link getReadUrl}, but nothing is signed and
   * nothing is audited — metadata is not the sensitive payload. Useful for a
   * client rendering a review queue that needs names and sizes only.
   *
   * @param fileId The file to describe.
   * @param caller The requesting user and their roles.
   * @returns The same shape a completion returns.
   * @throws {FileNotFoundError} Absent, unreadable, or not `READY`.
   */
  async getMetadata(
    fileId: string,
    caller: { userId: string; roles: readonly string[] },
  ): Promise<CompleteUploadResult> {
    const file = await this.loadReadable(fileId);
    const grant = decideRead(
      { ownerUserId: file.ownerUserId, purpose: file.purpose as FilePurposeName },
      caller,
    );
    if (!grant.granted) throw new FileNotFoundError();
    return this.toResult(file);
  }

  /**
   * Perform the `PENDING → READY` transition and its event, in one transaction.
   *
   * Split out from {@link completeUpload} for one reason: the transition is the
   * only place a **database** invariant can refuse a file whose bytes were
   * entirely valid. `uq_files_one_live_profile_image` (doc 03 §4.4) allows a
   * user one live avatar, so a replacement cannot become `READY` while the
   * previous one still is — and the raw violation escaping produced a `500`
   * carrying Prisma's own text in Fastify's default envelope, which doc 04 §1
   * and §5 both forbid.
   *
   * The row stays `PENDING`, so the client can release the previous file and
   * retry within its upload window. That the release is required at all is a
   * documented contradiction, not a design decision made here — see the phase-4
   * report; this method only ensures the refusal is a `409` in the platform
   * envelope either way.
   *
   * @returns `true` when this caller performed the transition.
   * @throws {FileStateError} A live file already occupies this purpose's slot.
   */
  private async publishReady(
    file: { id: string; purpose: string; contentType: string },
    ownerUserId: string,
    head: { sizeBytes: number; checksumSha256: string | null },
    completedAt: Date,
    requestId: string | null,
  ): Promise<boolean> {
    try {
      return await this.transactionManager.execute(async (tx) => {
        const won = await this.fileRepository.markReady(
          file.id,
          {
            sizeBytes: head.sizeBytes,
            completedAt,
            ...(head.checksumSha256 != null ? { checksumSha256: head.checksumSha256 } : {}),
          },
          tx,
        );
        // FILE-INV-6: of two concurrent completions exactly one transitions, and
        // only the winner writes the event — so exactly one `file.uploaded` exists.
        if (!won) return false;

        await this.eventPublisher.publish(
          fileEvent('file.uploaded', {
            aggregateId: file.id,
            subjectUserId: ownerUserId,
            requestId,
            data: {
              fileId: file.id,
              ownerUserId,
              purpose: file.purpose,
              contentType: file.contentType,
              sizeBytes: head.sizeBytes,
            },
          }),
          tx,
        );
        return true;
      });
    } catch (err) {
      // The storage key was inserted at reservation, so the only unique index
      // this write can violate is the one-live-file-per-purpose rule. Same
      // translation `saved-place.service.ts` applies to `uq_saved_places_user_label`.
      if (err instanceof UniqueConstraintError) {
        this.fileMetrics.uploadRejected({ purpose: file.purpose, reason: 'CONFLICT' });
        throw new FileStateError('A live file of this purpose already exists');
      }
      throw err;
    }
  }

  /**
   * Soft-delete a file (doc 02 §2.5).
   *
   * **The object is never touched here.** `deleted_at` is set, the row leaves
   * every read path in the same instant, and the bytes survive until the
   * retention job's window closes (R-FILE-18). Erasing inline would destroy
   * evidence at the moment a user asks for it to disappear, which is exactly the
   * sequence a dispute later needs reconstructed.
   *
   * A file a live domain row still references is refused (R-FILE-19,
   * FILE-INV-5), naming the holding module and nothing else.
   *
   * Only `READY → DELETED` is a defined transition (doc 01 §7). Every other
   * state answers `404`: a `PENDING` reservation is not a file yet, and a
   * `SUPERSEDED` one is retained evidence a user cannot withdraw (R-FILE-32).
   * Repeating a delete is `204`, because a converged request succeeded.
   *
   * @param fileId The file to remove.
   * @param ownerUserId The caller, applied in the query's `WHERE` clause.
   * @param requestId Correlation id for the audit envelope.
   * @throws {FileNotFoundError} Absent, not the caller's, or not deletable.
   * @throws {FileInUseError} A live domain row still references it.
   */
  async remove(
    fileId: string,
    ownerUserId: string,
    requestId: string | null = null,
  ): Promise<void> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId);
    if (!file) throw new FileNotFoundError();
    // Converged, not a refusal — doc 02 §2.5 makes the repeat idempotent.
    if (file.status === 'DELETED') return;
    if (file.status !== 'READY') throw new FileNotFoundError();

    const purpose = file.purpose as FilePurposeName;
    const holder = await findLiveReference(purpose, file.id);
    if (holder) throw new FileInUseError(holder);

    const deletedAt = new Date();
    await this.transactionManager.execute(async (tx) => {
      const won = await this.fileRepository.softDelete(file.id, deletedAt, tx);
      // The other caller transitioned it and emitted the event. Emitting a
      // second one would make a single deletion look like two in the audit
      // trail — the one place that must not be approximate.
      if (!won) return;

      await this.eventPublisher.publish(
        fileEvent('file.deleted', {
          aggregateId: file.id,
          subjectUserId: file.ownerUserId,
          requestId,
          data: {
            fileId: file.id,
            ownerUserId: file.ownerUserId,
            purpose,
            // Always `self` in v1: this path is owner-scoped and `admin` cannot
            // delete at all (doc 02 §6A) — an ops actor who could destroy
            // evidence is the threat model, not a feature.
            actor: 'self',
            actorUserId: ownerUserId,
          },
        }),
        tx,
      );
    });
  }

  /**
   * Refuse unless a file may be attached to a domain row (R-FILE-27, FLOW §5).
   *
   * The whole of the boundary between `files` and every module that stores a
   * file id: the caller passes a uuid and gets a yes or a throw, and neither side
   * learns anything else. Called **inside the caller's own transaction**, so the
   * check and the write that depends on it commit or roll back together — a
   * check that committed separately would be a claim about the past by the time
   * the row landed.
   *
   * Without it a client could attach a `PENDING` id and produce a KYC record
   * pointing at bytes that were never verified, or never arrived (FILE-INV-3).
   * It is also what closes the 03 §4A.2 race: an approval naming a file that has
   * since been `SUPERSEDED` fails loudly rather than landing on a version nobody
   * is presenting any more.
   *
   * @param fileId The file the caller intends to reference.
   * @param ownerUserId The user the referencing row belongs to.
   * @param purpose The purpose that row expects.
   * @param tx The caller's transaction.
   * @throws {FileNotFoundError} Absent, not that user's, or the wrong purpose.
   * @throws {FileStateError} Present and the caller's, but not `READY`.
   * @throws {FileInUseError} Already referenced by a live row (R-FILE-33).
   */
  async assertReferenceable(
    fileId: string,
    ownerUserId: string,
    purpose: FilePurposeName,
    tx: TransactionClient,
  ): Promise<void> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId, tx);
    // Purpose joins owner in the non-disclosure merge: a caller guessing ids
    // must not be able to learn what a file it cannot use is for (doc 04 §4).
    if (!file || file.purpose !== purpose) throw new FileNotFoundError();

    if (file.status !== 'READY' || file.deletedAt !== null) {
      throw new FileStateError('That file is not available to attach');
    }

    const holder = await findLiveReference(purpose, fileId, tx);
    if (holder) throw new FileInUseError(holder);
  }

  /**
   * Replace one file with a newer version (R-FILE-31, doc 03 §4A).
   *
   * **Replacement is never a deletion.** A driver's previous licence is the
   * document that was on file for every trip taken before the renewal; a
   * regulator asking what was valid in March needs an answer, and a row
   * indistinguishable from a user-initiated deletion cannot give one. So the
   * previous version becomes `SUPERSEDED`, keeps its bytes for the purpose's
   * full window measured from here (R-FILE-32), and names its successor.
   *
   * Runs in the **attaching module's** transaction: a failed attach must leave
   * the previous version current and announce nothing. If the swap committed and
   * the supersession did not, two files would be `READY` and "which licence is
   * current?" would have two answers.
   *
   * @param previousFileId The file being replaced.
   * @param replacementFileId The file replacing it.
   * @param tx The caller's transaction.
   * @param requestId Correlation id for the audit envelope.
   * @throws {FileNotFoundError} Either file is absent.
   * @throws {FileStateError} They disagree on owner or purpose, the replacement
   *         is not `READY`, or the previous is no longer the current version.
   */
  async supersede(
    previousFileId: string,
    replacementFileId: string,
    tx: TransactionClient,
    requestId: string | null = null,
  ): Promise<void> {
    if (previousFileId === replacementFileId) {
      throw new FileStateError('A file cannot supersede itself');
    }

    const previous = await this.fileRepository.findById(previousFileId, tx);
    const replacement = await this.fileRepository.findById(replacementFileId, tx);
    if (!previous || !replacement) throw new FileNotFoundError();

    // A chain that crossed owners or purposes would move a file between read
    // policies and retention classes — the same thing FILE-INV-7 forbids doing
    // to `purpose` directly.
    if (previous.ownerUserId !== replacement.ownerUserId) {
      throw new FileStateError('A replacement must belong to the same owner');
    }
    if (previous.purpose !== replacement.purpose) {
      throw new FileStateError('A replacement must share the previous purpose');
    }
    if (replacement.status !== 'READY') {
      throw new FileStateError('The replacement file is not available to attach');
    }

    const won = await this.fileRepository.markSuperseded(previousFileId, replacementFileId, tx);
    // Already superseded, deleted, or never `READY`. Refusing rather than
    // silently converging is the point: two concurrent replacements must not
    // both believe they are the current version (FILE-INV-8).
    if (!won) throw new FileStateError('That file is no longer the current version');

    await this.eventPublisher.publish(
      fileEvent('file.superseded', {
        aggregateId: previous.id,
        subjectUserId: previous.ownerUserId,
        requestId,
        data: {
          fileId: previous.id,
          replacementFileId: replacement.id,
          ownerUserId: previous.ownerUserId,
          purpose: previous.purpose,
        },
      }),
      tx,
    );
  }

  /**
   * Load a file that is eligible to be read at all.
   *
   * Not owner-scoped at the query, unlike every write path — an ops reader is a
   * legitimate non-owner, so ownership is decided by {@link decideRead} once the
   * row is in hand. **Only `READY` is readable**: a `SUPERSEDED` or `DELETED`
   * file is retained as evidence (R-FILE-32), not served.
   */
  private async loadReadable(fileId: string): Promise<{
    id: string;
    ownerUserId: string;
    purpose: string;
    storageKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string | null;
    createdAt: Date;
  }> {
    const file = await this.fileRepository.findReadable(fileId);
    if (!file) throw new FileNotFoundError();
    return file;
  }

  /**
   * Compare the stored object against the declared checksum.
   *
   * Separate from the type and size gates because its remedy differs: a corrupt
   * transfer is worth retrying, a wrong file is not (doc 04 §3).
   */
  private async verifyStoredObject(
    fileId: string,
    storageKey: string,
    purpose: FilePurposeName,
    file: { checksumSha256: string | null },
    head: { checksumSha256: string | null },
  ): Promise<void> {
    if (
      file.checksumSha256 != null &&
      head.checksumSha256 != null &&
      file.checksumSha256 !== head.checksumSha256
    ) {
      await this.rejectUpload(fileId, storageKey, purpose, 'CHECKSUM_MISMATCH');
      throw new ChecksumMismatchError();
    }
  }

  /**
   * Remove a refused object and retire its reservation.
   *
   * Best-effort on the storage side: if the delete fails the sweeper collects
   * the object later, and failing the request because cleanup failed would tell
   * the client to retry something that is already correctly refused.
   */
  private async rejectUpload(
    fileId: string,
    storageKey: string,
    purpose: FilePurposeName,
    reason: string,
  ): Promise<void> {
    this.fileMetrics.uploadRejected({ purpose, reason });
    try {
      await this.storageProvider.delete(storageKey);
    } catch (err) {
      logger.warn({ err, fileId }, '[Files] failed to remove a refused object');
    }
    await this.fileRepository.markExpired(fileId);
  }

  /**
   * Enforce the request-rate limits and the byte quotas (R-FILE-9, R-FILE-30).
   *
   * Both, because they bound different things: a rate limit bounds requests, and
   * thirty 50 MB clips an hour is inside the rate limit and is 1.5 GB
   * (FILES-OD-11).
   */
  private async assertWithinLimits(
    ownerUserId: string,
    purpose: FilePurposeName,
    sizeBytes: number,
  ): Promise<void> {
    const perUser = await this.redisService.rateLimit.hit(
      'file:upload:user',
      ownerUserId,
      fileConfig.uploadsPerUserPerHour,
      3600,
    );
    if (!perUser.allowed) {
      this.fileMetrics.uploadThrottled({ purpose, axis: 'user' });
      throw new RateLimitedError(perUser.retryAfterSeconds);
    }

    const perPurpose = await this.redisService.rateLimit.hit(
      'file:upload:purpose',
      `${ownerUserId}:${purpose}`,
      fileConfig.uploadsPerPurposePerHour,
      3600,
    );
    if (!perPurpose.allowed) {
      this.fileMetrics.uploadThrottled({ purpose, axis: 'purpose' });
      throw new RateLimitedError(perPurpose.retryAfterSeconds);
    }

    // Quotas are checked before signing, so an over-quota upload never creates
    // an object (doc 08 §5).
    const [userBytes, purposeBytes] = await Promise.all([
      this.fileRepository.totalBytesForUser(ownerUserId),
      this.fileRepository.totalBytesForUser(ownerUserId, purpose),
    ]);

    if (userBytes + sizeBytes > fileConfig.maxTotalBytesPerUser) {
      this.fileMetrics.uploadThrottled({ purpose, axis: 'quota_user' });
      throw new FileTooLargeError('sizeBytes', fileConfig.maxTotalBytesPerUser);
    }
    if (purposeBytes + sizeBytes > fileConfig.maxTotalBytesPerPurpose) {
      this.fileMetrics.uploadThrottled({ purpose, axis: 'quota_purpose' });
      throw new FileTooLargeError('sizeBytes', fileConfig.maxTotalBytesPerPurpose);
    }
  }

  /** Render a row as the doc 02 §2.2 response body. */
  private toResult(file: {
    id: string;
    purpose: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string | null;
    createdAt: Date;
  }): CompleteUploadResult {
    return {
      fileId: file.id,
      status: 'READY',
      purpose: file.purpose,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256,
      createdAt: file.createdAt,
    };
  }
}
