const TYPE_SHORT = 3;
const TYPE_LONG = 4;

export interface ExifOptions {
  gps?: boolean;
  orientation?: number;
  bigEndian?: boolean;
}

export function tiffBlock(options: ExifOptions = {}): Buffer {
  const big = options.bigEndian === true;
  const entries: { tag: number; type: number; value: number }[] = [];
  if (options.orientation !== undefined) {
    entries.push({ tag: 0x0112, type: TYPE_SHORT, value: options.orientation });
  }
  if (options.gps === true) {
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
  u32(4, 8);
  u16(8, entries.length);

  entries.forEach((entry, index) => {
    const at = 10 + index * 12;
    u16(at, entry.tag);
    u16(at + 2, entry.type);
    u32(at + 4, 1);

    if (entry.type === TYPE_SHORT) u16(at + 8, entry.value);
    else u32(at + 8, entry.value);
  });

  return block;
}

function jpegFrame(width: number, height: number): Buffer {
  const segment = Buffer.alloc(19);
  segment.writeUInt16BE(0xffc0, 0);
  segment.writeUInt16BE(17, 2);
  segment.writeUInt8(8, 4);
  segment.writeUInt16BE(height, 5);
  segment.writeUInt16BE(width, 7);
  segment.writeUInt8(3, 9);
  return segment;
}

function jpegScan(): Buffer {
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffda, 0);
  segment.writeUInt16BE(2, 2);
  return segment;
}

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

  if (options.truncated !== true) parts.push(jpegScan());
  return Buffer.concat(parts);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  return chunk;
}

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

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const padded = data.length % 2 === 1 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
  const chunk = Buffer.alloc(8 + padded.length);
  chunk.write(fourcc, 0, 'ascii');
  chunk.writeUInt32LE(data.length, 4);
  padded.copy(chunk, 8);
  return chunk;
}

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

export function webpLossy(width = 800, height = 600): Buffer {
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
