import { TransactionManager } from '@core/database';
import { EventPublisher } from '@core/events';
import type { TransactionClient } from '@core/database/TransactionManager';
import type { FilePurposeName } from '@config/file/file.config.js';
import { FileRepository } from '../repositories/file.repository.js';
import { fileEvent } from '../events/catalog.js';
import { FileInUseError, FileNotFoundError, FileStateError } from '../errors/file.errors.js';
import { findLiveReference } from './file-reference.service.js';
export class FileLifecycleService {
  constructor(
    private readonly fileRepository: FileRepository,
    private readonly transactionManager: TransactionManager,
    private readonly eventPublisher: EventPublisher,
  ) {}
  async remove(
    fileId: string,
    ownerUserId: string,
    requestId: string | null = null,
  ): Promise<void> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId);
    if (!file) throw new FileNotFoundError();
    if (file.status === 'DELETED') return;
    if (file.status !== 'READY') throw new FileNotFoundError();
    const purpose = file.purpose as FilePurposeName;
    const holder = await findLiveReference(purpose, file.id);
    if (holder) throw new FileInUseError(holder);
    const deletedAt = new Date();
    await this.transactionManager.execute(async (tx) => {
      const won = await this.fileRepository.softDelete(file.id, deletedAt, tx);
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
            actor: 'self',
            actorUserId: ownerUserId,
          },
        }),
        tx,
      );
    });
  }
  async releaseInTransaction(
    fileId: string,
    ownerUserId: string,
    tx: TransactionClient,
    requestId: string | null = null,
  ): Promise<boolean> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId, tx);
    if (!file || file.status !== 'READY') return false;
    const won = await this.fileRepository.softDelete(file.id, new Date(), tx);
    if (!won) return false;
    await this.eventPublisher.publish(
      fileEvent('file.deleted', {
        aggregateId: file.id,
        subjectUserId: file.ownerUserId,
        requestId,
        data: {
          fileId: file.id,
          ownerUserId: file.ownerUserId,
          purpose: file.purpose,
          actor: 'self',
          actorUserId: ownerUserId,
        },
      }),
      tx,
    );
    return true;
  }
  async assertReferenceable(
    fileId: string,
    ownerUserId: string,
    purpose: FilePurposeName,
    tx: TransactionClient,
  ): Promise<void> {
    const file = await this.fileRepository.findOwned(fileId, ownerUserId, tx);
    if (!file || file.purpose !== purpose) throw new FileNotFoundError();
    if (file.status !== 'READY' || file.deletedAt !== null) {
      throw new FileStateError('That file is not available to attach');
    }
    const holder = await findLiveReference(purpose, fileId, tx);
    if (holder) throw new FileInUseError(holder);
  }
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
}
