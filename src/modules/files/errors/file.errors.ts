export interface FileErrorDetail {
  field: string;
  code: string;
  limit?: number;
  allowed?: readonly string[];
}
export class FileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: FileErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class UnsupportedMediaTypeError extends FileError {
  constructor(allowed: readonly string[]) {
    super('UNSUPPORTED_MEDIA_TYPE', 'That file type is not accepted for this purpose', [
      { field: 'contentType', code: 'NOT_ALLOWED', allowed },
    ]);
  }
}
export class FileTooLargeError extends FileError {
  constructor(field: 'sizeBytes' | 'dimensions', limit: number) {
    super('FILE_TOO_LARGE', 'That file is larger than this upload allows', [
      { field, code: 'OUT_OF_RANGE', limit },
    ]);
  }
}
export class UploadNotFoundError extends FileError {
  constructor() {
    super('UPLOAD_NOT_FOUND', 'No uploaded object was found for this file');
  }
}
export class ContentMismatchError extends FileError {
  constructor() {
    super('CONTENT_MISMATCH', 'The uploaded file does not match its declared type', [
      { field: 'contentType', code: 'MISMATCH' },
    ]);
  }
}
export class ChecksumMismatchError extends FileError {
  constructor() {
    super('CHECKSUM_MISMATCH', 'The uploaded file was corrupted in transfer', [
      { field: 'checksumSha256', code: 'MISMATCH' },
    ]);
  }
}
export class ExifLocationError extends FileError {
  constructor() {
    super('EXIF_LOCATION_PRESENT', 'That image carries location metadata and cannot be accepted', [
      { field: 'file', code: 'METADATA_NOT_ALLOWED' },
    ]);
  }
}
export class UploadExpiredError extends FileError {
  constructor() {
    super('UPLOAD_EXPIRED', 'The upload window for this file has closed');
  }
}
export class FileInUseError extends FileError {
  constructor(module: string) {
    super('FILE_IN_USE', 'That file is still attached and cannot be removed', [
      { field: 'fileId', code: 'IN_USE' },
    ]);
    this.module = module;
  }
  readonly module: string;
}
export class FileStateError extends FileError {
  constructor(message: string) {
    super('CONFLICT', message);
  }
}
export class FileNotFoundError extends FileError {
  constructor() {
    super('NOT_FOUND', 'No such file');
  }
}
export class FileValidationError extends FileError {
  constructor(details: FileErrorDetail[]) {
    super('VALIDATION', 'The request could not be processed as sent', details);
  }
}
