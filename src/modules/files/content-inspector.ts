/**
 * Content inspection from an object's leading bytes (files doc 02 §5, §5.2).
 *
 * Three jobs, all performed on a **header slice only** — nothing here decodes an
 * image:
 *
 * 1. **Magic bytes.** The declared content-type is a claim; these bytes are the
 *    evidence. A PNG renamed `.jpg`, or an ELF renamed `.pdf`, dies here.
 * 2. **Dimensions.** Every accepted image format states its own size in its
 *    header, so the pixel ceiling (R-FILE-35) is enforced *before* any decoder
 *    is entered. That ordering is the whole defence: a 5 MB PNG can legally
 *    decode to 40,000 × 40,000, which is 6.4 GB of RGBA, and a byte ceiling
 *    cannot see it coming.
 * 3. **Location metadata** (R-FILE-29). EXIF GPS lives in a container-level
 *    segment — a JPEG `APP1`, a PNG `eXIf` chunk, a WebP `EXIF` chunk — every
 *    one of which sits beside the pixel data rather than inside it. So finding
 *    it is a walk over the same header slice, and costs no extra round trip and
 *    no decoder.
 *
 * The **orientation tag is applied to the dimensions** before they are returned,
 * because a 6000 × 4000 portrait photograph stores its frame transposed and
 * would otherwise be measured as 4000 × 6000 and refused for the wrong reason
 * (doc 02 §5.2).
 */

/** The pixel extent read out of an image header. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * What the header proves about location metadata.
 *
 * `UNKNOWN` is not "probably fine": it means the metadata region ran past the
 * peek, so absence could not be established. For a purpose that requires
 * stripping, that is refused — a privacy control that fails open is not a
 * control (R-FILE-29).
 */
export type LocationVerdict = 'ABSENT' | 'PRESENT' | 'UNKNOWN';

/** Why a header could not be accepted. */
export type InspectionFailure = 'MAGIC_MISMATCH' | 'DIMENSIONS_UNREADABLE';

/** The outcome of inspecting a header slice. */
export type InspectionResult =
  | { ok: true; dimensions: ImageDimensions | null; location: LocationVerdict }
  | { ok: false; reason: InspectionFailure };

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
  if (!DIMENSIONED.has(declared)) return { ok: true, dimensions: null, location: 'ABSENT' };

  const dimensions = readDimensions(declared, header);
  // Fail closed. A legitimate image states its size in its header; one whose
  // size cannot be found within the peek is either truncated, malformed, or
  // padded to push the frame header out of reach — and accepting it would mean
  // accepting an image whose decoded cost is unknown (R-FILE-35).
  if (!dimensions) return { ok: false, reason: 'DIMENSIONS_UNREADABLE' };

  const exif = readExif(declared, header);
  return {
    ok: true,
    dimensions: applyOrientation(dimensions, exif.orientation),
    location: exif.location,
  };
}

/**
 * Swap the axes when the orientation tag says the frame is stored rotated.
 *
 * Orientations 5–8 are the quarter-turns; 1–4 are upright or mirrored. A phone
 * held sideways writes a 4000 × 6000 frame and an orientation of 6, and every
 * viewer shows it as 6000 × 4000 — so measuring the stored frame against a
 * per-axis ceiling refuses the picture for a shape it does not actually have
 * (doc 02 §5.2).
 * @param dimensions The frame as stored.
 * @param orientation The EXIF orientation tag, if the header carried one.
 * @returns The dimensions as a viewer would render them.
 */
function applyOrientation(
  dimensions: ImageDimensions,
  orientation: number | null,
): ImageDimensions {
  if (orientation === null || orientation < 5 || orientation > 8) return dimensions;
  return { width: dimensions.height, height: dimensions.width };
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

// ── EXIF (R-FILE-29) ─────────────────────────────────────────────────────────

/** IFD0 tag for the GPS sub-directory pointer — the presence of location data. */
const TAG_GPS_IFD = 0x8825;

/** IFD0 tag for the orientation the frame should be rendered at. */
const TAG_ORIENTATION = 0x0112;

/** One IFD entry is a tag, a type, a count, and a value-or-offset. */
const IFD_ENTRY_BYTES = 12;

/** What a header slice yielded about its EXIF block. */
interface ExifFacts {
  location: LocationVerdict;
  orientation: number | null;
}

/** Nothing found, and nothing left unread — the common case for a screenshot. */
const NO_EXIF: ExifFacts = { location: 'ABSENT', orientation: null };

/** The metadata region ran past the slice, so absence could not be proven. */
const INCONCLUSIVE: ExifFacts = { location: 'UNKNOWN', orientation: null };

/**
 * Find the EXIF block for a format and read what this module cares about.
 * @param declared The verified content-type.
 * @param header The leading bytes.
 * @returns Whether location data is present, and the orientation tag.
 */
function readExif(declared: string, header: Buffer): ExifFacts {
  if (declared === 'image/jpeg') return readJpegExif(header);
  if (declared === 'image/png') return readPngExif(header);
  if (declared === 'image/webp') return readWebpExif(header);
  return NO_EXIF;
}

/**
 * JPEG: the EXIF block is an `APP1` segment carrying the marker `Exif\0\0`.
 *
 * The walk ends at `SOS`, the start of the entropy-coded scan: everything before
 * it is metadata and everything after is pixels, so reaching it **proves**
 * there is no EXIF rather than merely failing to find one. Running out of buffer
 * first proves nothing, and says so.
 */
function readJpegExif(header: Buffer): ExifFacts {
  let offset = 2; // past SOI
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
    // SOS: metadata is over. Anything past here is compressed pixel data.
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
    // The segment we needed to read is only partly here.
    if (marker === 0xe1 && payloadEnd > header.length) return INCONCLUSIVE;

    offset = payloadEnd;
  }
  return INCONCLUSIVE;
}

/**
 * PNG: EXIF lives in the ancillary `eXIf` chunk, which precedes `IDAT`.
 *
 * Reaching `IDAT` is the same proof `SOS` is for a JPEG — the pixel data has
 * started, so no further metadata chunk can be the one we were looking for.
 */
function readPngExif(header: Buffer): ExifFacts {
  let offset = 8; // past the signature
  while (offset + 8 <= header.length) {
    const length = header.readUInt32BE(offset);
    const type = header.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;

    if (type === 'IDAT') return NO_EXIF;
    if (type === 'eXIf') {
      if (dataStart + length > header.length) return INCONCLUSIVE;
      return readTiff(header.subarray(dataStart, dataStart + length));
    }
    offset = dataStart + length + 4; // + CRC
  }
  return INCONCLUSIVE;
}

/**
 * WebP: an `EXIF` chunk in the RIFF container, present only in the extended
 * (`VP8X`) form.
 *
 * `VP8 ` and `VP8L` files are a single pixel chunk and cannot carry metadata at
 * all, which is a conclusive absence rather than a failed search.
 */
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
      // Some encoders prefix the JPEG-style marker; most write raw TIFF.
      return block.toString('ascii', 0, 6) === 'Exif\0\0'
        ? readTiff(block.subarray(6))
        : readTiff(block);
    }
    // RIFF chunks are padded to an even length.
    offset = dataStart + size + (size % 2);
  }
  return NO_EXIF;
}

/**
 * Read IFD0 of a TIFF block for the GPS pointer and the orientation tag.
 *
 * Only IFD0 is walked. The GPS directory is reached through a **pointer stored
 * in IFD0**, so its presence there is the whole question — there is no need to
 * follow it and read coordinates, and not following it means no second bounds
 * check and no chance of a crafted offset sending the reader anywhere.
 * @param tiff The EXIF payload, starting at its byte-order mark.
 * @returns What the directory declares.
 */
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
    // SHORT values sit in the first two bytes of the value field, in the
    // block's byte order — not right-aligned.
    if (tag === TAG_ORIENTATION) orientation = u16(entry + 8);
  }

  return { location: hasLocation ? 'PRESENT' : 'ABSENT', orientation };
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
