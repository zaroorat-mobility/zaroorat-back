import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { JwtConfig } from '@config/jwt/jwt.config';
import { TokenInvalidError } from '../../errors/auth.errors';
export interface AccessTokenClaims {
  sub: string;
  sid: string;
  roles: string[];
  epoch: number;
  jti: string;
  iat: number;
  exp: number;
  iss: string;
}
export interface MintAccessTokenInput {
  userId: string;
  sessionId: string;
  roles: string[];
  epoch: number;
}
export interface JwtHeader {
  alg: string;
  typ: string;
  kid?: string;
}
const ALG = 'HS256' as const;
const TYP = 'JWT' as const;
export class JwtService {
  private readonly primaryKid: string;
  private readonly accessSecrets: Record<string, string>;
  private readonly ttlSeconds: number;
  private readonly issuer: string;
  constructor(jwtConfig: JwtConfig) {
    this.primaryKid = jwtConfig.primaryKid ?? 'v1';
    this.accessSecrets = jwtConfig.accessSecrets ?? { [this.primaryKid]: jwtConfig.accessSecret };
    this.ttlSeconds = jwtConfig.accessTtlSeconds;
    this.issuer = jwtConfig.issuer;
  }
  sign(input: MintAccessTokenInput): string {
    const now = Math.floor(Date.now() / 1000);
    const header: JwtHeader = {
      alg: ALG,
      typ: TYP,
      kid: this.primaryKid,
    };
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
    const signingInput = `${this.encode(header)}.${this.encode(payload)}`;
    const secret = this.accessSecrets[this.primaryKid] ?? this.accessSecrets.v1;
    if (!secret) throw new TokenInvalidError('Primary signing secret not configured');
    return `${signingInput}.${this.signature(signingInput, secret)}`;
  }
  verify(token: string): AccessTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenInvalidError();
    const [encHeader, encPayload, signature] = parts as [string, string, string];
    const header = this.decode<JwtHeader>(encHeader);
    if (!header || header.alg !== ALG) throw new TokenInvalidError();
    const kid = header.kid ?? this.primaryKid;
    const secret = this.accessSecrets[kid];
    if (!secret) throw new TokenInvalidError();
    const signingInput = `${encHeader}.${encPayload}`;
    if (!this.signatureMatches(signature, this.signature(signingInput, secret))) {
      throw new TokenInvalidError();
    }
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
  private signature(signingInput: string, secret: string): string {
    return createHmac('sha256', secret).update(signingInput).digest('base64url');
  }
  private signatureMatches(provided: string, expected: string): boolean {
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
  }
}
