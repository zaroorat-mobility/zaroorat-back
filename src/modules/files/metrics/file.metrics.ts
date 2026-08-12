import { logger } from '@shared/logger/index.js';
import { incrementCounter } from '@core/metrics';

export type FileMetricFields = Record<string, string | number | boolean>;

export class FileMetrics {
  uploadRequested(fields?: FileMetricFields): void {
    this.emit('upload.requested', fields);
  }

  uploadCompleted(fields?: FileMetricFields): void {
    this.emit('upload.completed', fields);
  }

  uploadRejected(fields?: FileMetricFields): void {
    this.emit('upload.rejected', fields);
  }

  uploadDuration(fields?: FileMetricFields): void {
    this.emit('upload.duration_ms', fields);
  }

  uploadThrottled(fields?: FileMetricFields): void {
    this.emit('upload.throttled', fields);
  }

  readSigned(fields?: FileMetricFields): void {
    this.emit('read.signed', fields);
  }

  readDenied(fields?: FileMetricFields): void {
    this.emit('read.denied', fields);
  }

  sweeperReclaimed(fields?: FileMetricFields): void {
    this.emit('sweeper.reclaimed', fields);
  }

  retentionArchived(fields?: FileMetricFields): void {
    this.emit('retention.archived', fields);
  }

  retentionErased(fields?: FileMetricFields): void {
    this.emit('retention.erased', fields);
  }

  retentionBlocked(fields?: FileMetricFields): void {
    this.emit('retention.blocked', fields);
  }

  storageGauge(gauge: string, fields?: FileMetricFields): void {
    this.emit(gauge, fields);
  }

  private emit(event: string, fields?: FileMetricFields): void {
    incrementCounter(`file_${event}`, fields);
    logger.info({ metric: `file.${event}`, ...fields }, `[FileMetrics] ${event}`);
  }
}
