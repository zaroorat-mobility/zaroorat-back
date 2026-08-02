import { logger } from '@shared/logger/index.js';

/**
 * Fields attached to a FILES metric event.
 *
 * **Never a file id, a storage key, a URL, or a filename.** A metric label is a
 * high-cardinality leak waiting to happen, and FILE-INV-2 applies to telemetry
 * exactly as it applies to responses and logs (doc 09 §2).
 */
export type FileMetricFields = Record<string, string | number | boolean>;

/**
 * Emits FILES counters for monitoring and alerting (files doc 09 §2).
 *
 * Log-based, following `OtpMetrics` and `UserMetrics`: one structured
 * `metric: file.*` line per event, a drop-in seam for Prometheus or
 * OpenTelemetry later.
 *
 * Phase 2 instruments the upload path only; read, lifecycle, and provider
 * metrics arrive with the phases that create those paths.
 */
export class FileMetrics {
  /** A write permission was issued. */
  uploadRequested(fields?: FileMetricFields): void {
    this.emit('upload.requested', fields);
  }

  /** Bytes were verified and the file became referenceable. */
  uploadCompleted(fields?: FileMetricFields): void {
    this.emit('upload.completed', fields);
  }

  /**
   * An upload was refused, at declaration or at completion.
   *
   * `reason` carries the doc 04 §2.2 code. A sustained rise in
   * `reason=CONTENT_MISMATCH` is the one to alert on (doc 09 §2.5): it means
   * either a broken client or somebody probing the magic-byte check.
   */
  uploadRejected(fields?: FileMetricFields): void {
    this.emit('upload.rejected', fields);
  }

  /** How long a client took between receiving a permission and completing. */
  uploadDuration(fields?: FileMetricFields): void {
    this.emit('upload.duration_ms', fields);
  }

  /** A request was refused by a rate limit or a byte quota. */
  uploadThrottled(fields?: FileMetricFields): void {
    this.emit('upload.throttled', fields);
  }

  /**
   * Emit one structured metric line.
   * @param event The metric suffix, appended to `file.`.
   * @param fields Low-cardinality labels.
   */
  private emit(event: string, fields?: FileMetricFields): void {
    logger.info({ metric: `file.${event}`, ...fields }, `[FileMetrics] ${event}`);
  }
}
