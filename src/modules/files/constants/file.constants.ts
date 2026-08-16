export const MAX_FILENAME_BYTES = 255;
export const RESERVED_FILENAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
export const RETENTION_DEAD_LETTER_KEY = 'files:retention:dead-letter';
export const FILE_READ_SCOPE = 'file:read';
export const FILE_UPLOAD_USER_SCOPE = 'file:upload:user';
export const FILE_UPLOAD_PURPOSE_SCOPE = 'file:upload:purpose';
