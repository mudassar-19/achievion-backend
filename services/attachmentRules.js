// Project and task attachments (Deploy-prep A) — pure. The type is decided by the file's first bytes AND the name's extension
// (they must agree). No SVG, no HTML: the files are opened from another address, so a script file must never get in.
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_TYPES = "PDF, DOC, DOCX, CSV, PNG, JPG or JPEG";
const starts = (b, bytes) => b.length >= bytes.length && bytes.every((x, i) => b[i] === x);
const EXT = { ".pdf": "pdf", ".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".doc": "doc", ".docx": "docx", ".csv": "csv" };

export function sniffAttachment(b) {
  if (!Buffer.isBuffer(b) || !b.length) return null;
  if (starts(b, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(b, [0xff, 0xd8, 0xff])) return "jpg";
  if (starts(b, [0x50, 0x4b, 0x03, 0x04])) return "docx"; // a zip container (docx); a .zip renamed .docx is not told apart here
  if (starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "doc";
  const head = b.subarray(0, 4096);
  if (!head.includes(0) && !/^\s*</.test(head.toString("utf8"))) return "csv"; // text, and not markup (svg, html)
  return null;
}
// → { ok: true, type } | { ok: false, status: 400, error }
export function checkAttachment({ buffer, originalname }) {
  const ext = /\.[^.]+$/.exec(String(originalname ?? "").toLowerCase())?.[0];
  const bad = (error) => ({ ok: false, status: 400, error });
  if (!EXT[ext]) return bad(`This file type is not allowed. Use ${ATTACHMENT_TYPES}.`);
  if (buffer.length > ATTACHMENT_MAX_BYTES) return bad("Each file can be at most 5 MB.");
  const type = sniffAttachment(buffer);
  if (type !== EXT[ext]) return bad(`"${String(originalname).slice(0, 60)}" does not look like a real ${ext.slice(1).toUpperCase()} file.`);
  return { ok: true, type };
}
