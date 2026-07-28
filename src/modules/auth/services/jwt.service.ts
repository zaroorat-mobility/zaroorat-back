import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { JwtConfig } from '@config/jwt/jwt.config';
import { TokenInvalidError } from '../errors';

/** Claims carried by an access token (auth doc 02 §3.1). */
export interface AccessTokenClaims {
  /** Subject — user id. */
  sub: string;
  /** Session id this token is bound to. */
  sid: string;
  /** Role slugs snapshot (re-validated via epoch on each request). */
  roles: string[];
  /** User session epoch at mint time. */
  epoch: number;
  /** Unique token id. */
  jti: string;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
  /** Issuer. */
  iss: string;
}

/** Inputs required to mint an access token. */
export interface MintAccessTokenInput {
  userId: string;
  sessionId: string;
  roles: string[];
  epoch: number;
}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

/**
 * Stateless HS256 access-token minting and verification.
 *
 * Implemented with `node:crypto` (no external JWT dependency): the same process
 * both signs and verifies in this modular monolith, so a shared secret is the
 * right trade-off (doc 02 §3.1). Verification pins `alg=HS256` (no algorithm
 * confusion), compares signatures in constant time, and enforces `exp`/`iss`.
 * This service performs no I/O — epoch/session state live elsewhere.
 */
export class JwtService {
  private readonly secret: string;
  private readonly ttlSeconds: number;
  private readonly issuer: string;

  /** @param jwtConfig Access secret, access TTL, and issuer. */
  constructor(jwtConfig: JwtConfig) {
    this.secret = jwtConfig.accessSecret;
    this.ttlSeconds = jwtConfig.accessTtlSeconds;
    this.issuer = jwtConfig.issuer;
  }

  /**
   * Mint a signed access token.
   * @param input Subject, session, roles snapshot, and current epoch.
   * @returns The compact JWT string.
   */
  sign(input: MintAccessTokenInput): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: AccessTokenClaims = {
      sub: input.userId,
      sid: input.sessionId,
      roles: input.roles,
      epoch: input.epoch,
      jti: randomUUID(),
      iat: now,
      exp: now + this.ttlSeconds,
      iss: this.issuer,
    };
    const signingInput = `${this.encode(HEADER)}.${this.encode(payload)}`;
    return `${signingInput}.${this.signature(signingInput)}`;
  }

  /**
   * Verify a token's signature and temporal/issuer claims.
   * @param token The compact JWT string.
   * @returns The decoded claims when valid.
   * @throws {TokenInvalidError} On malformed input, bad algorithm, signature
   *         mismatch, expiry, or issuer mismatch.
   */
  verify(token: string): AccessTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenInvalidError();
    const [encHeader, encPayload, signature] = parts as [string, string, string];

    const signingInput = `${encHeader}.${encPayload}`;
    if (!this.signatureMatches(signature, this.signature(signingInput))) {
      throw new TokenInvalidError();
    }

    const header = this.decode<{ alg?: string }>(encHeader);
    if (header?.alg !== HEADER.alg) throw new TokenInvalidError();

    const payload = this.decode<AccessTokenClaims>(encPayload);
    if (!payload) throw new TokenInvalidError();

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) {
      throw new TokenInvalidError('The access token has expired');
    }
    if (payload.iss !== this.issuer) throw new TokenInvalidError();

    return payload;
  }

  private encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }

  private decode<T>(segment: string): T | null {
    try {
      return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  private signature(signingInput: string): string {
    return createHmac('sha256', this.secret).update(signingInput).digest('base64url');
  }

  private signatureMatches(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
