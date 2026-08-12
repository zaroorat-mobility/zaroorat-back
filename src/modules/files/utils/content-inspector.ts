export interface ImageDimensions {
  width: number;
  height: number;
}

export type LocationVerdict = 'ABSENT' | 'PRESENT' | 'UNKNOWN';

export type InspectionFailure = 'MAGIC_MISMATCH' | 'DIMENSIONS_UNREADABLE';

export type InspectionResult =
  | { ok: true; dimensions: ImageDimensions | null; location: LocationVerdict }
  | { ok: false; reason: InspectionFailure };

const SIGNATURES: Readonly<Record<string, readonly (number | null)[]>> = Object.freeze({
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'video/mp4': [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
});

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const DIMENSIONED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function hasEnforceableDimensions(contentType: string): boolean {
  return DIMENSIONED.has(contentType);
}

export function inspect(declared: string, header: Buffer): InspectionResult {
  if (!matchesSignature(declared, header)) return { ok: false, reason: 'MAGIC_MISMATCH' };
  if (!DIMENSIONED.has(declared)) return { ok: true, dimensions: null, location: 'ABSENT' };

  const dimensions = readDimensions(declared, header);
  if (!dimensions) return { ok: false, reason: 'DIMENSIONS_UNREADABLE' };

  const exif = readExif(declared, header);
  return {
    ok: true,
    dimensions: applyOrientation(dimensions, exif.orientation),
    location: exif.location,
  };
}

function applyOrientation(
  dimensions: ImageDimensions,
  orientation: number | null,
): ImageDimensions {
  if (orientation === null || orientation < 5 || orientation > 8) return dimensions;
  return { width: dimensions.height, height: dimensions.width };
}

export function matchesSignature(declared: string, header: Buffer): boolean {
  const signature = SIGNATURES[declared];
  if (!signature) return false;
  if (header.length < signature.length) return false;
  return signature.every((byte, index) => byte === null || header[index] === byte);
}

const TAG_GPS_IFD = 0x8825;

const TAG_ORIENTATION = 0x0112;

const IFD_ENTRY_BYTES = 12;

interface ExifFacts {
  location: LocationVerdict;
  orientation: number | null;
}

const NO_EXIF: ExifFacts = { location: 'ABSENT', orientation: null };

const INCONCLUSIVE: ExifFacts = { location: 'UNKNOWN', orientation: null };

function readExif(declared: string, header: Buffer): ExifFacts {
  if (declared === 'image/jpeg') return readJpegExif(header);
  if (declared === 'image/png') return readPngExif(header);
  if (declared === 'image/webp') return readWebpExif(header);
  return NO_EXIF;
}

function readJpegExif(header: Buffer): ExifFacts {
  let offset = 2;
  while (offset + 4 <= header.length) {
    if (header[offset] !== 0xff) return INCONCLUSIVE;
    const marker = header[offset + 1];
    if (marker === undefined) return INCONCLUSIVE;

    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return NO_EXIF;

    const length = header.readUInt16BE(offset + 2);
    if (length < 2) return INCONCLUSIVE;
    const payloadStart = offset + 4;
    const payloadEnd = offset + 2 + length;

    if (marker === 0xe1 && payloadEnd <= header.length) {
      if (header.toString('ascii', payloadStart, payloadStart + 6) === 'Exif\0\0') {
        return readTiff(header.subarray(payloadStart + 6, payloadEnd));
      }
    }
    if (marker === 0xe1 && payloadEnd > header.length) return INCONCLUSIVE;

    offset = payloadEnd;
  }
  return INCONCLUSIVE;
}

function readPngExif(header: Buffer): ExifFacts {
  let offset = 8;
  while (offset + 8 <= header.length) {
    const length = header.readUInt32BE(offset);
    const type = header.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;

    if (type === 'IDAT') return NO_EXIF;
    if (type === 'eXIf') {
      if (dataStart + length > header.length) return INCONCLUSIVE;
      return readTiff(header.subarray(dataStart, dataStart + length));
    }
    offset = dataStart + length + 4;
  }
  return INCONCLUSIVE;
}

function readWebpExif(header: Buffer): ExifFacts {
  if (header.length < 16) return INCONCLUSIVE;
  if (header.toString('ascii', 12, 16) !== 'VP8X') return NO_EXIF;

  let offset = 12;
  while (offset + 8 <= header.length) {
    const fourcc = header.toString('ascii', offset, offset + 4);
    const size = header.readUInt32LE(offset + 4);
    const dataStart = offset + 8;

    if (fourcc === 'EXIF') {
      if (dataStart + size > header.length) return INCONCLUSIVE;
      const block = header.subarray(dataStart, dataStart + size);
      return block.toString('ascii', 0, 6) === 'Exif\0\0'
        ? readTiff(block.subarray(6))
        : readTiff(block);
    }
    offset = dataStart + size + (size % 2);
  }
  return NO_EXIF;
}

function readTiff(tiff: Buffer): ExifFacts {
  if (tiff.length < 8) return INCONCLUSIVE;

  const byteOrder = tiff.toString('ascii', 0, 2);
  if (byteOrder !== 'II' && byteOrder !== 'MM') return INCONCLUSIVE;
  const little = byteOrder === 'II';

  const u16 = (at: number): number => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number): number => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));

  const ifdOffset = u32(4);
  if (ifdOffset + 2 > tiff.length) return INCONCLUSIVE;

  const entries = u16(ifdOffset);
  const end = ifdOffset + 2 + entries * IFD_ENTRY_BYTES;
  if (end > tiff.length) return INCONCLUSIVE;

  let orientation: number | null = null;
  let hasLocation = false;
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdOffset + 2 + index * IFD_ENTRY_BYTES;
    const tag = u16(entry);
    if (tag === TAG_GPS_IFD) hasLocation = true;
    if (tag === TAG_ORIENTATION) orientation = u16(entry + 8);
  }

  return { location: hasLocation ? 'PRESENT' : 'ABSENT', orientation };
}

function readDimensions(declared: string, header: Buffer): ImageDimensions | null {
  if (declared === 'image/png') return readPngDimensions(header);
  if (declared === 'image/jpeg') return readJpegDimensions(header);
  if (declared === 'image/webp') return readWebpDimensions(header);
  return null;
}

function readPngDimensions(header: Buffer): ImageDimensions | null {
  if (header.length < 24) return null;
  if (header.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function readJpegDimensions(header: Buffer): ImageDimensions | null {
  let offset = 2;
  while (offset + 9 < header.length) {
    if (header[offset] !== 0xff) return null;
    const marker = header[offset + 1];
    if (marker === undefined) return null;

    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }

    const length = header.readUInt16BE(offset + 2);
    if (length < 2) return null;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > header.length) return null;
      return { height: header.readUInt16BE(offset + 5), width: header.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebpDimensions(header: Buffer): ImageDimensions | null {
  if (header.length < 30) return null;
  const chunk = header.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    if (header.length < 30) return null;
    if (header[23] !== 0x9d || header[24] !== 0x01 || header[25] !== 0x2a) return null;
    return {
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    if (header.length < 25 || header[20] !== 0x2f) return null;
    const bits = header.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === 'VP8X') {
    if (header.length < 30) return null;
    return {
      width: header.readUIntLE(24, 3) + 1,
      height: header.readUIntLE(27, 3) + 1,
    };
  }

  return null;
}
