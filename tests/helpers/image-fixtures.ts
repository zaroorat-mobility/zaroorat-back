/**
 * Minimal, hand-built image headers for the FILES content inspector.
 *
 * Real photographs are not used as fixtures for two reasons. A binary blob in
 * the repository is unreviewable — nobody can tell from a diff whether the GPS
 * tag it is supposed to carry is actually there — and a fixture that came from a
 * phone carries whatever that phone chose to write, which is not the same as
 * what the test claims to be exercising. Everything here is assembled byte by
 * byte from the format specifications, so each test states exactly the structure
 * it depends on.
 *
 * These are **headers**, not decodable images. Nothing under test decodes one
 * (files doc 02 §5.2), so nothing needs them to be.
 */

/** EXIF IFD entry types used here. */
const TYPE_SHORT = 3;
const TYPE_LONG = 4;

/** What a synthesized EXIF block should declare. */
export interface ExifOptions {
  /** Include the GPS sub-directory pointer — what R-FILE-29 looks for. */
  gps?: boolean;
  /** The orientation tag, 1–8. Omit to leave the tag out entirely. */
  orientation?: number;
  /** Write big-endian (`MM`) instead of the little-endian (`II`) default. */
  bigEndian?: boolean;
}

/**
 * Build a TIFF block: byte-order mark, IFD0, and the tags asked for.
 * @param options Which tags to write, and in which byte order.
 * @returns The block, starting at its byte-order mark.
 */
export function tiffBlock(options: ExifOptions = {}): Buffer {
  const big = options.bigEndian === true;
  const entries: { tag: number; type: number; value: number }[] = [];
  if (options.orientation !== undefined) {
    entries.push({ tag: 0x0112, type: TYPE_SHORT, value: options.orientation });
  }
  if (options.gps === true) {
    // The pointer's target is never followed — its presence in IFD0 is the whole
    // question — so any plausible offset serves.
    entries.push({ tag: 0x8825, type: TYPE_LONG, value: 0x100 });
  }

  const block = Buffer.alloc(8 + 2 + entries.length * 12 + 4);
  block.write(big ? 'MM' : 'II', 0, 'ascii');
  const u16 = (at: number, value: number): void => {
    if (big) block.writeUInt16BE(value, at);
    else block.writeUInt16LE(value, at);
  };
  const u32 = (at: number, value: number): void => {
    if (big) block.writeUInt32BE(value, at);
    else block.writeUInt32LE(value, at);
  };

  u16(2, 42);
  u32(4, 8); // IFD0 begins immediately after the header
  u16(8, entries.length);

  entries.forEach((entry, index) => {
    const at = 10 + index * 12;
    u16(at, entry.tag);
    u16(at + 2, entry.type);
    u32(at + 4, 1);
    // A SHORT occupies the first two bytes of the value field; a LONG all four.
    if (entry.type === TYPE_SHORT) u16(at + 8, entry.value);
    else u32(at + 8, entry.value);
  });

  return block;
}

/** A JPEG start-of-frame segment declaring the given size. */
function jpegFrame(width: number, height: number): Buffer {
  const segment = Buffer.alloc(19);
  segment.writeUInt16BE(0xffc0, 0);
  segment.writeUInt16BE(17, 2); // segment length
  segment.writeUInt8(8, 4); // sample precision
  segment.writeUInt16BE(height, 5);
  segment.writeUInt16BE(width, 7);
  segment.writeUInt8(3, 9); // three components, then 3 bytes each
  return segment;
}

/** A start-of-scan marker: everything past it is compressed pixel data. */
function jpegScan(): Buffer {
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffda, 0);
  segment.writeUInt16BE(2, 2);
  return segment;
}

/**
 * A JPEG header: `SOI`, an optional `APP1` EXIF segment, `SOF0`, and `SOS`.
 * @param options Size, and the EXIF block to embed (omit for none).
 * @returns The header bytes.
 */
export function jpeg(
  options: { width?: number; height?: number; exif?: Buffer; truncated?: boolean } = {},
): Buffer {
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  if (options.exif) {
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), options.exif]);
    const marker = Buffer.alloc(4);
    marker.writeUInt16BE(0xffe1, 0);
    marker.writeUInt16BE(payload.length + 2, 2);
    parts.push(marker, payload);
  }

  parts.push(jpegFrame(width, height));
  // Omitting SOS models a peek that ended mid-metadata: absence of EXIF can no
  // longer be proven, only unproven.
  if (options.truncated !== true) parts.push(jpegScan());
  return Buffer.concat(parts);
}

/** A PNG chunk with a placeholder CRC — nothing under test verifies one. */
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  return chunk;
}

/**
 * A PNG header: signature, `IHDR`, an optional `eXIf` chunk, and `IDAT`.
 * @param options Size, and the EXIF block to embed (omit for none).
 * @returns The header bytes.
 */
export function png(options: { width?: number; height?: number; exif?: Buffer } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(options.width ?? 800, 0);
  ihdr.writeUInt32BE(options.height ?? 600, 4);

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
  ];
  if (options.exif) parts.push(pngChunk('eXIf', options.exif));
  parts.push(pngChunk('IDAT', Buffer.alloc(4)));
  return Buffer.concat(parts);
}

/** A RIFF chunk, padded to an even length as the container requires. */
function riffChunk(fourcc: string, data: Buffer): Buffer {
  const padded = data.length % 2 === 1 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
  const chunk = Buffer.alloc(8 + padded.length);
  chunk.write(fourcc, 0, 'ascii');
  chunk.writeUInt32LE(data.length, 4);
  padded.copy(chunk, 8);
  return chunk;
}

/**
 * A WebP header in the extended (`VP8X`) form, which is the only one that can
 * carry metadata at all.
 * @param options Size, and the EXIF block to embed (omit for none).
 * @returns The header bytes.
 */
export function webp(options: { width?: number; height?: number; exif?: Buffer } = {}): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x.writeUIntLE((options.width ?? 800) - 1, 4, 3);
  vp8x.writeUIntLE((options.height ?? 600) - 1, 7, 3);

  const body = [riffChunk('VP8X', vp8x)];
  if (options.exif) body.push(riffChunk('EXIF', options.exif));

  const payload = Buffer.concat(body);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(payload.length + 4, 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, payload]);
}

/** A WebP in the plain lossy form, which has nowhere to put metadata. */
export function webpLossy(width = 800, height = 600): Buffer {
  // VP8 bitstream: a 3-byte frame tag, the 3-byte sync code, then 14-bit width
  // and height.
  const vp8 = Buffer.alloc(12);
  vp8.writeUInt8(0x9d, 3);
  vp8.writeUInt8(0x01, 4);
  vp8.writeUInt8(0x2a, 5);
  vp8.writeUInt16LE(width, 6);
  vp8.writeUInt16LE(height, 8);

  const payload = riffChunk('VP8 ', vp8);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(payload.length + 4, 4);
  riff.write('WEBP', 8, 'ascii');
  return Buffer.concat([riff, payload]);
}
