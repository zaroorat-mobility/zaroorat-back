import { BaseRepository, DatabaseService } from '@core/database';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { RefreshToken } from '@core/database/types';

/** Fields needed to persist a refresh token. Only the HASH is ever stored — the
 *  raw token exists solely on the client (auth doc 02 §3.2). */
export interface CreateRefreshTokenInput {
  userId: string;
  sessionId: string;
  /** HMAC-SHA256(token, pepper) computed by the token service — never the raw token. */
  tokenHash: string;
  expiresAt: Date;
  /** Predecessor token id when this row is the successor of a rotation. */
  rotatedFrom?: string | null;
}

/**
 * Data access for `RefreshToken` (rotating, hash-only).
 *
 * Tokens form a per-session family via the `rotatedFrom`/`rotatedTo` lineage.
 * Reuse detection and the decision to revoke a family are service concerns; this
 * layer only reads/writes rows. All revocations here are session-scoped, which is
 * exactly the family boundary (auth doc 02 §3.2). Prisma-only, no business rules.
 */
export class RefreshTokenRepository extends BaseRepository {
  /** @param databaseService Resolved singleton facade over the Prisma client. */
  constructor(databaseService: DatabaseService) {
    super(databaseService);
  }

  /**
   * Persist a new refresh token (hash only).
   * @param input Owner, session, token hash, expiry, and optional predecessor.
   * @returns The created token row.
   */
  async create(input: CreateRefreshTokenInput, tx?: TransactionClient): Promise<RefreshToken> {
    return (tx ?? this.client).refreshToken.create({
      data: {
        userId: input.userId,
        sessionId: input.sessionId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ...(input.rotatedFrom != null ? { rotatedFrom: input.rotatedFrom } : {}),
      },
    });
  }

  /**
   * Look a token up by its stored hash (the presented token, hashed by the caller).
   * @param tokenHash HMAC digest of the presented refresh token.
   * @returns The matching row, or `null` if unknown.
   */
  async findByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.client.refreshToken.findUnique({ where: { tokenHash } });
  }

  /**
   * Atomically rotate a token: create the successor and mark the predecessor
   * consumed (linked via `rotatedTo`) in a single transaction, so a partial
   * failure can never leave both usable (AUTH-INV-5). The *decision* to rotate
   * and reuse detection remain in the service; this is the atomic write.
   * @param oldId The predecessor token's UUID (becomes `rotatedFrom`).
   * @param input Owner, session, successor hash, and expiry.
   * @param tx Transaction client to join (e.g. to also enqueue an event atomically);
   *           when omitted the two writes run in their own transaction.
   * @returns The created successor token row.
   */
  async rotate(
    oldId: string,
    input: Omit<CreateRefreshTokenInput, 'rotatedFrom'>,
    tx?: TransactionClient,
  ): Promise<RefreshToken> {
    const run = async (client: TransactionClient): Promise<RefreshToken> => {
      const created = await client.refreshToken.create({
        data: {
          userId: input.userId,
          sessionId: input.sessionId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          rotatedFrom: oldId,
        },
      });
      await client.refreshToken.update({
        where: { id: oldId },
        data: { rotatedTo: created.id, revokedAt: new Date(), revokedReason: 'rotated' },
      });
      return created;
    };
    return tx ? run(tx) : this.client.$transaction(run);
  }

  /**
   * Mark a token consumed by rotation, linking it to its successor.
   * @param id The consumed token's UUID.
   * @param rotatedToId The successor token's UUID.
   * @param revokedAt Consumption timestamp (defaults to now).
   */
  async markRotated(id: string, rotatedToId: string, revokedAt: Date = new Date()): Promise<void> {
    await this.client.refreshToken.update({
      where: { id },
      data: { rotatedTo: rotatedToId, revokedAt, revokedReason: 'rotated' },
    });
  }

  /**
   * Revoke a single refresh token.
   * @param id Token UUID.
   * @param reason Revocation reason.
   * @param revokedAt Revocation timestamp (defaults to now).
   */
  async revoke(id: string, reason: string, revokedAt: Date = new Date()): Promise<void> {
    await this.client.refreshToken.update({
      where: { id },
      data: { revokedAt, revokedReason: reason },
    });
  }

  /**
   * Revoke every active token in a session's family (reuse detection / logout).
   * @param sessionId The session whose token family to revoke.
   * @param reason Revocation reason.
   * @param revokedAt Revocation timestamp (defaults to now).
   * @param tx Transaction client to join, so the family revoke and its audit event
   *           commit atomically (omit for a standalone write).
   * @returns Count of tokens revoked.
   */
  async revokeBySession(
    sessionId: string,
    reason: string,
    revokedAt: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await (tx ?? this.client).refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt, revokedReason: reason },
    });
    return count;
  }

  /**
   * Revoke every active token for a user (suspension / logout-all).
   * @param userId Owner user UUID.
   * @param reason Revocation reason.
   * @param revokedAt Revocation timestamp (defaults to now).
   * @param tx Transaction client to join (omit for a standalone write).
   * @returns Count of tokens revoked.
   */
  async revokeAllByUser(
    userId: string,
    reason: string,
    revokedAt: Date = new Date(),
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await (tx ?? this.client).refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt, revokedReason: reason },
    });
    return count;
  }

  /**
   * Purge expired, non-revoked tokens (retention R-AUTH-27).
   * @param now Rows with `expiresAt` strictly before this are deleted.
   * @returns Count of rows removed.
   */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const { count } = await this.client.refreshToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  }
}
