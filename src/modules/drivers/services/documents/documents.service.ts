import { TransactionManager } from '@core/database';
import { lockForAudit, recordAdminAction, type AuditActor } from '@modules/admin/audit/index.js';
import { FileService } from '@modules/files';
import { driverConfig } from '@config';
import { DriverRepository } from '../../repositories/driver.repository.js';
import { DriverDocumentRepository } from '../../repositories/driver-document.repository.js';
import { DriverStatusRepository } from '../../repositories/driver-status.repository.js';
import { StatusService } from '../status/status.service.js';
import {
  DriverError,
  DriverNotFoundError,
  SelfReviewForbiddenError,
} from '../../errors/driver.errors.js';
import { DriverMetrics } from '../../metrics/driver.metrics.js';
import { logger } from '@shared/logger/index.js';
import type { DriverDocument, DriverDocumentType, VerificationStatus } from '../../types';
import type { NotificationService } from '@modules/notifications/notification.service.js';
import type { DatabaseService } from '@core/database';
import { EventPublisher } from '@core/events';
import { driverEvent, DRIVER_EVENT_CATALOG } from '../../events/catalog.js';

export class DocumentsService {
  constructor(
    private readonly driverRepo: DriverRepository,
    private readonly docRepo: DriverDocumentRepository,
    private readonly txManager: TransactionManager,
    private readonly driverMetrics: DriverMetrics,
    private readonly fileService: FileService,
    private readonly statusRepo: DriverStatusRepository,
    private readonly statusService: StatusService,
    private readonly notificationService: NotificationService,
    private readonly databaseService: DatabaseService,
    private readonly eventPublisher?: EventPublisher,
  ) {}

  async submitDocument(
    data: {
      driverId: string;
      documentType: DriverDocumentType;
      fileId: string;
      backFileId?: string;
      documentNumber?: string;
      expiresAt?: Date;
    },
    requestId: string | null = null,
  ): Promise<DriverDocument> {
    const driver = await this.driverRepo.findById(data.driverId);
    if (!driver) throw new DriverNotFoundError(data.driverId);
    if (data.backFileId === data.fileId) {
      throw new DriverError(
        'The back of a document must be a different file from its front',
        'DOCUMENT_BACK_IS_FRONT',
        422,
      );
    }
    // The same `<= now` that makes eligibility call a document expired: one already past it
    // could never be approved, so it is refused here rather than queued for review.
    if (data.expiresAt && data.expiresAt.getTime() <= Date.now()) {
      throw new DriverError('This document has already expired', 'DOCUMENT_EXPIRED', 422);
    }

    const isRequired = (driverConfig.requiredDocumentTypes as string[]).includes(data.documentType);
    const isProfilePhoto = data.documentType === 'PROFILE_PHOTO';

    // DRIVER_DOCUMENT admits PDFs; the photo shown on the profile must be an image.
    if (isProfilePhoto) {
      const file = await this.fileService.getMetadata(data.fileId, {
        userId: driver.userId,
        roles: [],
      });
      if (!file.contentType.startsWith('image/')) {
        throw new DriverError('Profile photo must be an image', 'PROFILE_PHOTO_NOT_IMAGE', 422);
      }
    }

    const { doc, wasVerifiedRequiredResubmit } = await this.txManager.execute(async (tx) => {
      // The driver row first, the lock admin decisions take: an upload racing a decision
      // waits for it and then acts on the status it committed, never on a stale read.
      const locked = await this.driverRepo.lockForUpdate(data.driverId, tx);
      if (!locked) throw new DriverNotFoundError(data.driverId);
      const account = await tx.user.findUnique({
        where: { id: locked.userId },
        select: { status: true },
      });
      const moderated =
        locked.isSuspended || account?.status === 'SUSPENDED' || account?.status === 'DEACTIVATED';
      const verifiedRequiredResubmit = locked.verificationStatus === 'VERIFIED' && isRequired;

      const existing = (await this.docRepo.findByDriverId(data.driverId, tx)).find(
        (d) => d.documentType === data.documentType,
      );

      // Both sides locked together, in a fixed order, before either is checked.
      await this.fileService.lockForAttach(
        [data.fileId, ...(data.backFileId ? [data.backFileId] : [])],
        tx,
      );
      await this.fileService.assertReferenceable(data.fileId, driver.userId, 'DRIVER_DOCUMENT', tx);
      if (data.backFileId) {
        await this.fileService.assertReferenceable(
          data.backFileId,
          driver.userId,
          'DRIVER_DOCUMENT',
          tx,
        );
      }

      const created = await this.docRepo.upsertDocument(data, tx);

      if (existing?.fileId && existing.fileId !== data.fileId) {
        await this.fileService.supersede(existing.fileId, data.fileId, tx, requestId);
      }
      // The old back follows the new one, or is retired when the replacement has none, so a
      // stale back never sits beside a new front.
      if (existing?.backFileId && existing.backFileId !== data.backFileId) {
        if (data.backFileId) {
          await this.fileService.supersede(existing.backFileId, data.backFileId, tx, requestId);
        } else {
          await this.fileService.releaseInTransaction(
            existing.backFileId,
            driver.userId,
            tx,
            requestId,
          );
        }
      }

      // The profile holds the file id (never a URL); readers sign it via GET /files/:id/url.
      if (isProfilePhoto) {
        await this.driverRepo.updateProfile(
          driver.userId,
          data.driverId,
          { profilePhoto: data.fileId },
          tx,
        );
      }

      // PENDING — a new application, or one sent back for corrections — enters the review
      // queue with the upload; the operator's instructions stay on the row. A final
      // rejection (REJECTED) stays final, and a suspended or blocked driver never re-enters
      // review by uploading. Re-uploading a required document after approval always goes
      // back to review: that only ever narrows what the driver may do.
      if (locked.verificationStatus === 'PENDING' && !moderated) {
        await this.driverRepo.updateVerificationStatus(
          data.driverId,
          'DOCUMENT_REVIEW',
          undefined,
          undefined,
          tx,
        );
      } else if (verifiedRequiredResubmit) {
        await this.driverRepo.updateVerificationStatus(
          data.driverId,
          'DOCUMENT_REVIEW',
          undefined,
          'Required document re-submitted',
          tx,
        );
      }

      if (this.eventPublisher) {
        await this.eventPublisher.publish(
          driverEvent(DRIVER_EVENT_CATALOG.DOCUMENT_SUBMITTED, data.driverId, {
            driverId: data.driverId,
            documentType: data.documentType,
          }),
          tx,
        );
      }

      return { doc: created, wasVerifiedRequiredResubmit: verifiedRequiredResubmit };
    });

    if (wasVerifiedRequiredResubmit) {
      const currentStatus = await this.statusRepo.getStatus(data.driverId);
      if (currentStatus?.status === 'ONLINE' || currentStatus?.status === 'BREAK') {
        await this.statusService.setOffline(data.driverId, 'DOCUMENT_RESUBMITTED');
      }
    }

    return doc;
  }

  /// The review and its audit row commit together, under a row lock, so two concurrent
  /// reviews cannot both pass the "already in this status" check and log twice. A repeated
  /// decision changes nothing and is not logged again. The row carries the document's
  /// type and statuses — never its number, file id or URL.
  async reviewDocument(
    documentId: string,
    driverId: string,
    status: VerificationStatus,
    actor: AuditActor,
    rejectionReason?: string,
  ): Promise<DriverDocument> {
    const driver = await this.driverRepo.findById(driverId);
    if (!driver) throw new DriverNotFoundError(driverId);

    if (driver.userId === actor.actorId) throw new SelfReviewForbiddenError();

    const outcome = await this.txManager.execute(async (tx) => {
      await lockForAudit(tx, 'driver_documents', documentId);
      const doc = await this.docRepo.findById(documentId, tx);
      if (!doc) {
        throw new DriverError(`Document '${documentId}' was not found`, 'DOCUMENT_NOT_FOUND', 404);
      }
      if (doc.driverId !== driverId) {
        throw new DriverError(
          'Document does not belong to the specified driver',
          'DOCUMENT_DRIVER_MISMATCH',
          409,
        );
      }
      if (doc.verificationStatus === status) return { reviewed: doc, changed: false };

      const reviewed = await this.docRepo.updateVerificationStatus(
        documentId,
        status,
        actor.actorId,
        rejectionReason,
        tx,
      );
      // Only REJECTED is a rejection: the compliance route can also return a document to
      // PENDING, which is recorded as the update it is.
      await recordAdminAction(tx, {
        ...actor,
        action: status === 'VERIFIED' ? 'APPROVE' : status === 'REJECTED' ? 'REJECT' : 'UPDATE',
        entityType: 'driver_document',
        entityId: documentId,
        summary: `Driver document ${doc.documentType} ${
          status === 'VERIFIED'
            ? 'verified'
            : status === 'REJECTED'
              ? 'rejected'
              : 'returned to pending'
        }`,
        notes: rejectionReason,
        before: { verificationStatus: doc.verificationStatus },
        after: {
          verificationStatus: reviewed.verificationStatus,
          driverId,
          documentType: doc.documentType,
        },
        result: 'SUCCESS',
      });
      if (this.eventPublisher) {
        await this.eventPublisher.publish(
          driverEvent(DRIVER_EVENT_CATALOG.DOCUMENT_SUBMITTED, driverId, {
            driverId,
            documentId,
            status,
          }),
          tx,
        );
      }
      return { reviewed, changed: true };
    });

    if (outcome.changed) {
      if (status === 'VERIFIED') {
        this.driverMetrics.documentVerified({ documentId, driverId });
      } else if (status === 'REJECTED') {
        this.driverMetrics.documentRejected({ documentId, driverId });
        // Fire-and-forget: SMS failure must never surface to the HTTP caller.
        void this.sendDocRejectedSms(driver, outcome.reviewed.documentType, rejectionReason);
      }
    }
    return outcome.reviewed;
  }

  /// Sends a rejection SMS to the driver's phone (fire-and-forget).
  /// Fetches the phone number from the linked User record.
  /// Any failure is logged and swallowed — never thrown.
  private async sendDocRejectedSms(
    driver: { id: string; userId: string },
    documentType: string,
    reason: string | undefined,
  ): Promise<void> {
    try {
      const user = await this.databaseService.client.user.findUnique({
        where: { id: driver.userId },
        select: { phoneNumber: true },
      });
      if (!user?.phoneNumber) {
        logger.warn(
          { driverId: driver.id },
          '[DocumentsService] doc-rejected SMS skipped — no phone on record',
        );
        return;
      }
      const result = await this.notificationService.sendDriverDocRejectedSms(
        user.phoneNumber,
        documentType,
        reason ?? 'No reason provided',
      );
      if (!result.accepted) {
        logger.warn(
          { driverId: driver.id, error: result.error },
          '[DocumentsService] doc-rejected SMS not accepted by provider',
        );
      }
    } catch (err) {
      logger.error(
        { driverId: driver.id, err },
        '[DocumentsService] doc-rejected SMS failed — skipping',
      );
    }
  }
}
