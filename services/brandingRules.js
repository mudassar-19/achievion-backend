// Organisation logo (Batch 5: D7, FR12-01) — pure. PNG, JPG or WebP only, at most 1 MB. The type comes from the file's
// first bytes; the name must agree with it. SVG is never accepted (it can carry scripts).
export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_MAX_SIDE = 2048; // pixels: a 1 MB file can unpack to gigabytes when the PDF writer decodes it (image bomb)
const TYPES = { png: { mime: "image/png", ext: ".png", names: [".png"] }, jpg: { mime: "image/jpeg", ext: ".jpg", names: [".jpg", ".jpeg"] }, webp: { mime: "image/webp", ext: ".webp", names: [".webp"] } };
export const LOGO_MIME = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, v.mime]));
const starts = (b, bytes, at = 0) => b.length >= at + bytes.length && bytes.every((x, i) => b[at + i] === x);

export function sniffImage(b) {
  if (!Buffer.isBuffer(b)) return null;
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(b, [0xff, 0xd8, 0xff])) return "jpg";
  if (starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}
// Pixel size from the file header only (nothing is decoded): { w, h } or null when the header is cut off or unknown.
export function imageSize(b, type) {
  try {
    if (type === "png") return b.length >= 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
    if (type === "jpg") { // walk the markers to the first start-of-frame (SOF0..SOF15 except DHT C4, JPG C8, DAC CC)
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + b.readUInt16BE(i + 2);
      }
      return null;
    }
    if (type === "webp") {
      const kind = b.toString("latin1", 12, 16);
      if (kind === "VP8X") return b.length >= 30 ? { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) } : null;
      if (kind === "VP8 ") return b.length >= 30 ? { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff } : null;
      if (kind === "VP8L") { if (b.length < 25 || b[20] !== 0x2f) return null; const bits = b.readUInt32LE(21); return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff) }; }
    }
  } catch { /* a cut-off header */ }
  return null;
}
const no = (status, error) => ({ ok: false, status, error });
export function readLogo(file) {
  if (!file?.buffer?.length) return no(400, "Choose an image file for the logo.");
  if (file.buffer.length > LOGO_MAX_BYTES) return no(413, "The logo is larger than 1 MB. Choose a smaller image.");
  const type = sniffImage(file.buffer), name = String(file.originalname ?? "").toLowerCase();
  if (!type || !TYPES[type].names.some((e) => name.endsWith(e))) return no(400, "The logo must be a PNG, JPG or WebP image. SVG is not accepted.");
  const size = imageSize(file.buffer, type);
  if (!size || !size.w || !size.h) return no(400, "The logo file looks damaged: its size could not be read.");
  if (size.w > LOGO_MAX_SIDE || size.h > LOGO_MAX_SIDE) return no(400, `The logo is larger than ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} pixels. Choose a smaller image.`);
  return { ok: true, type, mime: TYPES[type].mime, ext: TYPES[type].ext };
}
