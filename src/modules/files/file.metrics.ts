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
   * A read URL was minted. `actor` is `owner` or `ops` (doc 09 §2.2).
   */
  readSigned(fields?: FileMetricFields): void {
    this.emit('read.signed', fields);
  }

  /**
   * A read was refused.
   *
   * The metric exists precisely **because the response reveals nothing** — a
   * denial is byte-identical to an absent file (doc 04 §4), so the enumeration
   * signal has to live somewhere, and telemetry is where it is safe (doc 09 §2.2).
   */
  readDenied(fields?: FileMetricFields): void {
    this.emit('read.denied', fields);
  }

  /** Reservations the sweeper reclaimed this run (doc 09 §2.4). */
  sweeperReclaimed(fields?: FileMetricFields): void {
    this.emit('sweeper.reclaimed', fields);
  }

  /** Files moved to cold storage, keeping the bytes (R-FILE-21). */
  retentionArchived(fields?: FileMetricFields): void {
    this.emit('retention.archived', fields);
  }

  /** Files whose every version was destroyed (R-FILE-23). */
  retentionErased(fields?: FileMetricFields): void {
    this.emit('retention.erased', fields);
  }

  /**
   * Retention could not proceed on a file.
   *
   * Either the owning module still holds a reference (R-FILE-19) or the work
   * failed its last attempt and was dead-lettered. **Sustained, this is an
   * alert** (doc 09 §2.5): a consumer that never releases a reference means a
   * compliance window closes with the bytes still there.
   */
  retentionBlocked(fields?: FileMetricFields): void {
    this.emit('retention.blocked', fields);
  }

  /**
   * The four gauges in doc 09 §2.4, emitted **by the jobs, per run**.
   *
   * Not computed on a scrape: a `sum(size_bytes) GROUP BY purpose` every fifteen
   * seconds is a table scan on a table that only grows. Once a night, from a job
   * already reading those rows, is free — and until a job runtime exists these
   * are dark, which is a real consequence of doc 01 §13.4 rather than an
   * oversight.
   */
  storageGauge(gauge: string, fields?: FileMetricFields): void {
    this.emit(gauge, fields);
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
