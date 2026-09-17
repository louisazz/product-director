/**
 * Pixel dimensions read straight from image bytes, with no image library.
 *
 * DeepSeek rejects any image whose longest side exceeds 8192 px with a generic
 * "unsupported image" 400, so the size has to be known before a request is
 * built — both to reject an upload early and to skip a stored attachment that
 * would otherwise fail every later turn in the same session.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

/** DeepSeek: max 8192 px per side, dropping to 4096 px at 15+ images per request. */
export const MAX_IMAGE_SIDE = 8192;
export const MAX_IMAGE_SIDE_MANY = 4096;
export const MANY_IMAGES_THRESHOLD = 15;

/** Returns null when the format is unknown or the header is truncated. */
export function readImageDimensions(bytes: Buffer): ImageDimensions | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readGif(bytes) ?? readWebp(bytes);
}

/** The side limit that applies when a request carries `imageCount` images. */
export function maxSideForImageCount(imageCount: number): number {
  return imageCount >= MANY_IMAGES_THRESHOLD ? MAX_IMAGE_SIDE_MANY : MAX_IMAGE_SIDE;
}

export function exceedsSideLimit(size: ImageDimensions, maxSide: number): boolean {
  return size.width > maxSide || size.height > maxSide;
}

function readPng(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  // IHDR is always the first chunk: length(4) type(4) width(4) height(4).
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function readJpeg(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Any SOFn frame header holds the dimensions; SOF4/SOF8/SOF12 are reserved.
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

function readGif(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 10) return null;
  const header = bytes.toString("ascii", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function readWebp(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 30) return null;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const format = bytes.toString("ascii", 12, 16);
  if (format === "VP8 ") {
    // Lossy: 3-byte frame tag, 3-byte sync code, then 14-bit width/height.
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    // Lossless: 1-byte signature then 14-bit width and height minus one.
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    // Extended: 24-bit canvas width and height minus one.
    return {
      width: (bytes.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (bytes.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }
  return null;
}
