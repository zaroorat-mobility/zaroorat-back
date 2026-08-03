/**
 * FILES domain errors (files doc 04 §2).
 *
 * Each carries a stable `code` from the error catalog; the HTTP mapping is
 * applied by the controller via `fileErrorStatus`. Throwing these keeps the
 * service transport-agnostic, matching `AuthError` and `UserError`.
 *
 * **Nothing here ever carries a signed URL, a storage key, a bucket or provider
 * name, or a provider's own error text** (doc 04 §5, FILE-INV-2). `details`
 * carries the offending field name, a machine code, and where useful a numeric
 * limit or an allowed list — never a submitted value.
 */

/** A field-level error detail. Carries no submitted value, by rule. */
export interface FileErrorDetail {
  /** The offending field name. */
  field: string;
  /** A code from the doc 04 §6 vocabulary. */
  code: string;
  /** The configured ceiling, on size and dimension failures. */
  limit?: number;
  /** The permitted values, on `UNSUPPORTED_MEDIA_TYPE`. */
  allowed?: readonly string[];
}

/** Base class for every FILES domain failure. */
export class FileError extends Error {
  /**
   * @param code Stable machine code (e.g. `CONTENT_MISMATCH`).
   * @param message Human-readable summary; never contains a key, URL, or value.
   * @param details Optional field-level breakdown.
   */
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: FileErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The declared content-type is not permitted for this purpose (doc 04 §2.2).
 *
 * Carries the allow-list so the client can tell the user what *is* accepted
 * rather than making them guess one type at a time.
 */
export class UnsupportedMediaTypeError extends FileError {
  /**
   * @param allowed The purpose's permitted content-types.
   */
  constructor(allowed: readonly string[]) {
    super('UNSUPPORTED_MEDIA_TYPE', 'That file type is not accepted for this purpose', [
      { field: 'contentType', code: 'NOT_ALLOWED', allowed },
    ]);
  }
}

/**
 * The declared or actual size exceeds the purpose ceiling (doc 04 §2.2).
 *
 * Also raised for a pixel-count ceiling (R-FILE-35): both are "this is bigger
 * than we accept", and splitting them would make a client branch on a
 * distinction it cannot act on differently.
 */
export class FileTooLargeError extends FileError {
  /**
   * @param field Which ceiling was exceeded — `sizeBytes` or `dimensions`.
   * @param limit The configured ceiling.
   */
  constructor(field: 'sizeBytes' | 'dimensions', limit: number) {
    super('FILE_TOO_LARGE', 'That file is larger than this upload allows', [
      { field, code: 'OUT_OF_RANGE', limit },
    ]);
  }
}

/**
 * Completion was called but no object is at the key (doc 04 §2.2).
 *
 * The row stays `PENDING` and the client may re-PUT and retry — this is a
 * recoverable ordering problem, not a rejection of the file.
 */
export class UploadNotFoundError extends FileError {
  constructor() {
    super('UPLOAD_NOT_FOUND', 'No uploaded object was found for this file');
  }
}

/**
 * The stored bytes are not the declared type (doc 04 §2.2, §3).
 *
 * `422` rather than `400`: the request that failed is an empty POST, so nothing
 * about it was malformed. What is wrong is the state the client created out of
 * band, and a `400` would invite resending the same request forever.
 *
 * **Do not retry.** The client must pick a different file.
 */
export class ContentMismatchError extends FileError {
  constructor() {
    super('CONTENT_MISMATCH', 'The uploaded file does not match its declared type', [
      { field: 'contentType', code: 'MISMATCH' },
    ]);
  }
}

/**
 * The declared checksum does not match the stored object (doc 04 §2.2).
 *
 * Distinct from {@link ContentMismatchError} precisely so the client can tell
 * them apart: a corrupt transfer is worth retrying, a wrong file is not.
 */
export class ChecksumMismatchError extends FileError {
  constructor() {
    super('CHECKSUM_MISMATCH', 'The uploaded file was corrupted in transfer', [
      { field: 'checksumSha256', code: 'MISMATCH' },
    ]);
  }
}

/** The write permission lapsed before completion (doc 04 §2.2). Start over. */
export class UploadExpiredError extends FileError {
  constructor() {
    super('UPLOAD_EXPIRED', 'The upload window for this file has closed');
  }
}

/**
 * A live domain row still references this file (doc 04 §2.2, FILE-INV-5).
 *
 * Names the owning module so the client knows where to detach it, and nothing
 * else — not the row, not the id.
 */
export class FileInUseError extends FileError {
  /** @param module The module holding the reference. */
  constructor(module: string) {
    super('FILE_IN_USE', 'That file is still attached and cannot be removed', [
      { field: 'fileId', code: 'IN_USE' },
    ]);
    this.module = module;
  }

  /** The owning module, for the `details.module` field doc 04 §2.2 describes. */
  readonly module: string;
}

/**
 * The file is not in a state this operation accepts (doc 04 §2.1).
 *
 * Not merged into `NOT_FOUND`: by the time a state is checked the caller has
 * already proved ownership, so there is nothing left to disclose (doc 04 §4).
 */
export class FileStateError extends FileError {
  /** @param message What was expected, without naming internal state names. */
  constructor(message: string) {
    super('CONFLICT', message);
  }
}

/** No such file, or one the read policy denies — indistinguishable (doc 04 §4). */
export class FileNotFoundError extends FileError {
  constructor() {
    super('NOT_FOUND', 'No such file');
  }
}

/** A request-shape failure raised before the service is reached. */
export class FileValidationError extends FileError {
  /** @param details The offending fields. */
  constructor(details: FileErrorDetail[]) {
    super('VALIDATION', 'The request could not be processed as sent', details);
  }
}
