import { RedisService } from '@core/cache';
import type { TransactionClient, TransactionManager } from '@core/database/TransactionManager';
import type { EventPublisher } from '@core/events';
import { userConfig } from '@config/user';
import { FileService } from '@modules/files';
import type {
  DeviceRepository,
  OtpRepository,
  SessionRepository,
  UserRepository,
} from '@modules/auth/repositories';
import { logger } from '@shared/logger/index.js';
import {
  DeletionRequestRepository,
  EmergencyContactRepository,
  ObligationsRepository,
  SavedPlaceRepository,
  UserProfileRepository,
} from '../repositories';
import { userEvent } from '../events';
import { UserMetrics } from '../metrics';
const ERASURE_LOCK = 'user:erasure';
const ERASURE_LOCK_TTL_MS = 15 * 60 * 1000;
const AVATAR_DEAD_LETTER_KEY = 'user:erasure:avatar:deadletter';
export interface ErasureResult {
  ran: boolean;
  scanned: number;
  erased: number;
  blocked: number;
  failed: number;
  avatarsStranded: number;
}
interface ErasureCounts {
  emergencyContacts: number;
  savedPlaces: number;
  profile: number;
  sessions: number;
  devices: number;
  otpAttempts: number;
}
export interface StrandedAvatar {
  userId: string;
  fileId: string;
  error: string;
  at: string;
}
type Skip = 'CANCELLED' | 'BLOCKED' | 'ALREADY_ERASED' | 'NOT_DEACTIVATED' | 'GONE';
export class AccountErasureJob {
  constructor(
    private readonly deletionRequestRepository: DeletionRequestRepository,
    private readonly obligationsRepository: ObligationsRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly emergencyContactRepository: EmergencyContactRepository,
    private readonly savedPlaceRepository: SavedPlaceRepository,
    private readonly userRepository: UserRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly deviceRepository: DeviceRepository,
    private readonly otpRepository: OtpRepository,
    private readonly fileService: FileService,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
    private readonly redisService: RedisService,
    private readonly userMetrics: UserMetrics,
  ) {}
  async run(now: Date = new Date()): Promise<ErasureResult> {
    const token = await this.redisService.lock.acquire(ERASURE_LOCK, ERASURE_LOCK_TTL_MS);
    if (!token) {
      return { ran: false, scanned: 0, erased: 0, blocked: 0, failed: 0, avatarsStranded: 0 };
    }
    try {
      const due = await this.deletionRequestRepository.findDue(now, userConfig.erasureBatchSize);
      let erased = 0;
      let blocked = 0;
      let failed = 0;
      let avatarsStranded = 0;
      for (const request of due) {
        try {
          const outcome = await this.eraseAccount(request.id, request.userId, now);
          if (outcome.kind === 'SKIPPED') {
            if (outcome.reason === 'BLOCKED') blocked += 1;
            continue;
          }
          erased += 1;
          if (outcome.avatarStranded) avatarsStranded += 1;
        } catch (err) {
          failed += 1;
          logger.error(
            { err, userId: request.userId },
            '[Users] erasure failed; retrying next run',
          );
        }
      }
      this.userMetrics.accountsErased({ count: erased, blocked, failed, avatarsStranded });
      return { ran: true, scanned: due.length, erased, blocked, failed, avatarsStranded };
    } finally {
      await this.redisService.lock.release(ERASURE_LOCK, token);
    }
  }
  async strandedAvatars(): Promise<StrandedAvatar[]> {
    const entries = await this.redisService.provider.client.hgetall(AVATAR_DEAD_LETTER_KEY);
    return Object.values(entries).map((value) => JSON.parse(value) as StrandedAvatar);
  }
  private async eraseAccount(
    requestId: string,
    userId: string,
    now: Date,
  ): Promise<
    | {
        kind: 'SKIPPED';
        reason: Skip;
      }
    | {
        kind: 'ERASED';
        avatarStranded: boolean;
      }
  > {
    const decided = await this.transactionManager.execute(async (tx) => {
      await this.userRepository.lockForUpdate(userId, tx);
      const skip = (reason: Skip) => ({ kind: 'SKIPPED' as const, reason });
      const request = await this.deletionRequestRepository.findById(requestId, tx);
      if (!request || request.status !== 'PENDING') return skip('CANCELLED');
      const user = await this.userRepository.findById(userId, tx);
      if (!user) return skip('GONE');
      if (user.deletedAt !== null) return skip('ALREADY_ERASED');
      if (user.status !== 'DEACTIVATED') return skip('NOT_DEACTIVATED');
      const obligations = await this.obligationsRepository.findOpenObligations(userId, tx);
      if (obligations.length > 0) {
        this.userMetrics.erasureBlocked({ modules: obligations.map((o) => o.module).join(',') });
        return skip('BLOCKED');
      }
      const avatarFileId =
        (await this.userProfileRepository.findByUserId(userId, tx))?.profileImageFileId ?? null;
      const phoneNumber = user.phoneNumber;
      const counts = await this.scrub(userId, phoneNumber, now, tx);
      const marked = await this.deletionRequestRepository.markErased(requestId, now, tx);
      if (!marked) {
        throw new Error(
          `Deletion request ${requestId} changed state while its user row was locked`,
        );
      }
      await this.eventPublisher.publish(
        userEvent('user.account.erased', {
          subjectUserId: userId,
          data: { userId, ...counts, avatarReleased: avatarFileId !== null },
        }),
        tx,
      );
      return { kind: 'ERASED' as const, avatarFileId };
    });
    if (decided.kind === 'SKIPPED') return decided;
    const avatarStranded = decided.avatarFileId
      ? !(await this.releaseAvatar(decided.avatarFileId, userId))
      : false;
    return { kind: 'ERASED', avatarStranded };
  }
  private async scrub(
    userId: string,
    phoneNumber: string,
    at: Date,
    tx: TransactionClient,
  ): Promise<ErasureCounts> {
    const emergencyContacts = await this.emergencyContactRepository.deleteAllForUser(userId, tx);
    const savedPlaces = await this.savedPlaceRepository.deleteAllForUser(userId, tx);
    const profile = await this.userProfileRepository.deleteForUser(userId, tx);
    const otpAttempts = await this.otpRepository.deleteForUser(userId, phoneNumber, tx);
    const sessions = await this.sessionRepository.anonymizeForUser(userId, tx);
    const devices = await this.deviceRepository.anonymizeForUser(userId, tx);
    await this.userRepository.anonymize(userId, at, tx);
    return { emergencyContacts, savedPlaces, profile, sessions, devices, otpAttempts };
  }
  private async releaseAvatar(fileId: string, userId: string): Promise<boolean> {
    try {
      await this.fileService.remove(fileId, userId);
      await this.redisService.provider.client.hdel(AVATAR_DEAD_LETTER_KEY, userId);
      return true;
    } catch (err) {
      const entry: StrandedAvatar = {
        userId,
        fileId,
        error: err instanceof Error ? err.message : 'unknown error',
        at: new Date().toISOString(),
      };
      await this.redisService.provider.client.hset(
        AVATAR_DEAD_LETTER_KEY,
        userId,
        JSON.stringify(entry),
      );
      this.userMetrics.avatarReleaseFailed({ userId });
      logger.error(
        { err, userId, fileId },
        '[Users] avatar release failed after erasure; dead-lettered for retry',
      );
      return false;
    }
  }
}
