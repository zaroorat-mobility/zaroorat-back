/**
 * Content inspection from an object's leading bytes (files doc 02 §5, §5.2).
 *
 * Two jobs, both performed on a **header slice only** — nothing here decodes an
 * image:
 *
 * 1. **Magic bytes.** The declared content-type is a claim; these bytes are the
 *    evidence. A PNG renamed `.jpg`, or an ELF renamed `.pdf`, dies here.
 * 2. **Dimensions.** Every accepted image format states its own size in its
 *    header, so the pixel ceiling (R-FILE-35) is enforced *before* any decoder
 *    is entered. That ordering is the whole defence: a 5 MB PNG can legally
 *    decode to 40,000 × 40,000, which is 6.4 GB of RGBA, and a byte ceiling
 *    cannot see it coming.
 */

/** The pixel extent read out of an image header. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/** Why a header could not be accepted. */
export type InspectionFailure = 'MAGIC_MISMATCH' | 'DIMENSIONS_UNREADABLE';

/** The outcome of inspecting a header slice. */
export type InspectionResult =
  { ok: true; dimensions: ImageDimensions | null } | { ok: false; reason: InspectionFailure };

/**
 * Leading-byte signatures per content-type (doc 02 §5).
 *
 * `null` entries mark a byte that is not part of the signature — WebP carries
 * its size between `RIFF` and `WEBP`, and MP4's `ftyp` sits at offset 4.
 */
const SIGNATURES: Readonly<Record<string, readonly (number | null)[]>> = Object.freeze({
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/webp': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'video/mp4': [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
});

/** JPEG start-of-frame markers, which carry the frame's dimensions. */
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Content-types whose dimensions this module reads and enforces. */
const DIMENSIONED = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Whether a content-type carries pixel dimensions this module enforces.
 *
 * PDFs are never parsed — a PDF is a program, and rendering one to measure it
 * would be a far larger surface than the measurement is worth. MP4 dimensions
 * are not checked in v1 because nothing decodes one (doc 02 §5).
 * @param contentType The verified content-type.
 * @returns `true` when {@link inspect} will extract dimensions.
 */
export function hasEnforceableDimensions(contentType: string): boolean {
  return DIMENSIONED.has(contentType);
}

/**
 * Check a header slice against the declared content-type, and read dimensions.
 *
 * @param declared The content-type the client declared and the purpose permits.
 * @param header The object's leading bytes, from `StorageProvider.head`.
 * @returns `ok` with dimensions (or `null` for formats that carry none), or the
 *          reason the header was refused.
 */
export function inspect(declared: string, header: Buffer): InspectionResult {
  if (!matchesSignature(declared, header)) return { ok: false, reason: 'MAGIC_MISMATCH' };
  if (!DIMENSIONED.has(declared)) return { ok: true, dimensions: null };

  const dimensions = readDimensions(declared, header);
  // Fail closed. A legitimate image states its size in its header; one whose
  // size cannot be found within the peek is either truncated, malformed, or
  // padded to push the frame header out of reach — and accepting it would mean
  // accepting an image whose decoded cost is unknown (R-FILE-35).
  if (!dimensions) return { ok: false, reason: 'DIMENSIONS_UNREADABLE' };
  return { ok: true, dimensions };
}

/**
 * Whether the header carries the declared type's signature.
 * @param declared The declared content-type.
 * @param header The leading bytes.
 * @returns `true` when every fixed byte of the signature matches.
 */
export function matchesSignature(declared: string, header: Buffer): boolean {
  const signature = SIGNATURES[declared];
  if (!signature) return false;
  if (header.length < signature.length) return false;
  return signature.every((byte, index) => byte === null || header[index] === byte);
}

/** Dispatch to the per-format header reader. */
function readDimensions(declared: string, header: Buffer): ImageDimensions | null {
  if (declared === 'image/png') return readPngDimensions(header);
  if (declared === 'image/jpeg') return readJpegDimensions(header);
  if (declared === 'image/webp') return readWebpDimensions(header);
  return null;
}

/**
 * PNG: the IHDR chunk is mandatory and first, so width and height sit at fixed
 * offsets 16 and 20 as big-endian 32-bit integers.
 */
function readPngDimensions(header: Buffer): ImageDimensions | null {
  if (header.length < 24) return null;
  if (header.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/**
 * JPEG: walk the segment chain to the start-of-frame marker.
 *
 * The frame header is not at a fixed offset — EXIF, ICC profiles, and thumbnails
 * all precede it, which is why the peek for a JPEG has to be far larger than the
 * one that suffices for a signature (doc 08 §2, `imagePeekBytes`).
 */
function readJpegDimensions(header: Buffer): ImageDimensions | null {
  let offset = 2; // past SOI
  while (offset + 9 < header.length) {
    if (header[offset] !== 0xff) return null; // desynchronised: not a JPEG chain
    const marker = header[offset + 1];
    if (marker === undefined) return null;

    // Padding fill bytes and standalone markers carry no length.
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
      // SOF payload: precision(1), height(2), width(2).
      if (offset + 9 > header.length) return null;
      return { height: header.readUInt16BE(offset + 5), width: header.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * WebP: three container variants, each stating the canvas differently.
 *
 * All three are in current use — `VP8 ` from cameras, `VP8L` from screenshots,
 * `VP8X` whenever alpha or animation is present — so reading only one would
 * reject real files.
 */
function readWebpDimensions(header: Buffer): ImageDimensions | null {
  if (header.length < 30) return null;
  const chunk = header.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte sync code, then 14-bit width and height.
    if (header.length < 30) return null;
    if (header[23] !== 0x9d || header[24] !== 0x01 || header[25] !== 0x2a) return null;
    return {
      width: header.readUInt16LE(26) & 0x3fff,
      height: header.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    // Lossless: signature byte, then 14 bits width-1 and 14 bits height-1.
    if (header.length < 25 || header[20] !== 0x2f) return null;
    const bits = header.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === 'VP8X') {
    // Extended: canvas width-1 and height-1 as 24-bit little-endian.
    if (header.length < 30) return null;
    return {
      width: header.readUIntLE(24, 3) + 1,
      height: header.readUIntLE(27, 3) + 1,
    };
  }

  return null;
}
