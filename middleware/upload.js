import multer from "multer";
import path   from "path";
import fs     from "fs";
import cloudinary from "../config/cloudinary.js";
import { SUBMISSION_FORMATS, isAllowedSubmissionFile, stripCloudinarySignature } from "../services/accessRules.js";
import { uploadError } from "../services/submitRules.js";
import { createFileStore } from "../services/fileStore.js";
import { makeAttachmentUpload } from "./attachmentUpload.js";
import { sniffAttachment } from "../services/attachmentRules.js";

// ── Detect whether Cloudinary is properly configured ─────────────────────────
const PLACEHOLDER_RE = /^your_/i;
export const cloudinaryConfigured =
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET &&
  !PLACEHOLDER_RE.test(process.env.CLOUDINARY_CLOUD_NAME) &&
  !PLACEHOLDER_RE.test(process.env.CLOUDINARY_API_KEY);

// ── Submission upload dir (used when Cloudinary is not configured) ────────────
const SUBMISSIONS_DIR = path.resolve(process.cwd(), "uploads", "submissions");
if (!fs.existsSync(SUBMISSIONS_DIR)) {
  fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
}

// Always buffer in memory first so magic-bytes check runs before any Cloudinary upload (FIX-4 D-430).
// After the check passes, uploadFiles persists to Cloudinary or disk below.
const uploadStorage = multer.memoryStorage();

export const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  // S-2 (S13, D-165): disk files are served from the API's own address, so a .html or .svg must never get in.
  fileFilter: (_req, file, cb) => {
    if (isAllowedSubmissionFile(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error("This file type is not allowed. Use JPG, PNG, PDF, ZIP, DOCX, XLSX, TXT or MD."), { status: 400 }));
  },
});

// Magic-bytes check for submission files (ISS-017/018, FIX-4 D-430).
// Always reads from f.buffer (memory storage) so the check fires before any Cloudinary upload.
const MAGIC_EXTS = new Set(["pdf", "png", "jpg", "jpeg", "docx", "zip", "xlsx"]);
function checkSubmissionMagic(files = []) {
  for (const f of files) {
    const ext = /\.([^.]+)$/.exec(f.originalname)?.[1]?.toLowerCase() ?? "";
    const buf = f.buffer;
    if (!buf || buf.length === 0) return `"${f.originalname}" is empty.`;
    if (!MAGIC_EXTS.has(ext)) continue; // txt/md/csv: text types, no binary signature
    const type = sniffAttachment(buf.subarray(0, 4096));
    const expected = ext === "xlsx" ? "docx" : ext === "jpeg" ? "jpg" : ext;
    if (!type || (expected !== "zip" && type !== expected)) {
      return `"${f.originalname}" does not look like a real ${ext.toUpperCase()} file.`;
    }
  }
  return null;
}

// Submission-type files (D-164, D-165) with clear 400s (E-3: multer limit errors carried no status → 500). Used by the
// employee composer and the E-4 Quality forms (bug files, QA evidence).
// FIX-4 (D-430): memory → magic check → then persist (Cloudinary or disk). Cloudinary is never called for rejected files.
export const uploadFiles = (req, res, next) => needStorage(req, res, () => upload.array("files", 5)(req, res, async (err) => {
  if (err) {
    const e = uploadError(err);
    if (e.status === 500) console.error("[upload]", err.message);
    return res.status(e.status).json({ error: e.error, field: e.field });
  }
  const magicErr = checkSubmissionMagic(req.files ?? []);
  if (magicErr) return res.status(400).json({ error: magicErr });

  // Persist buffers to Cloudinary or disk after the check passes
  try {
    for (const f of req.files ?? []) {
      if (cloudinaryConfigured) {
        const result = await new Promise((ok, no) => cloudinary.uploader.upload_stream(
          { folder: `achievion/${req.user?.orgId}/submissions`, allowed_formats: SUBMISSION_FORMATS, resource_type: "auto", type: "authenticated", use_filename: true, unique_filename: true, filename_override: f.originalname },
          (e, r) => (e ? no(e) : ok(r))
        ).end(f.buffer));
        f.path = result.secure_url;
      } else {
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        f.filename = `${unique}${path.extname(f.originalname).toLowerCase()}`;
        f.path = path.join(SUBMISSIONS_DIR, f.filename);
        fs.writeFileSync(f.path, f.buffer);
      }
    }
  } catch (e) {
    console.error("[upload] persist failed:", e.message);
    return res.status(502).json({ error: "File upload to storage failed." });
  }
  next();
}));
// Where a stored file is opened from: Cloudinary URL without its permanent signature (S-2), or the signed /uploads path (S-1).
export const storedFile = (f) => ({ name: f.originalname, url: /^https?:\/\//.test(f.path ?? "") ? stripCloudinarySignature(f.path) : `/uploads/submissions/${f.filename}`, size: f.size || 0 });

// ── Project and task attachments (Deploy-prep A, D-300): memory → checks → file store (Cloudinary "authenticated", disk in dev) ──
const realCloud = {
  configured: () => !!cloudinaryConfigured,
  upload: (buffer, { folder, filename }) => new Promise((ok, no) => cloudinary.uploader.upload_stream(
    { folder, resource_type: "auto", type: "authenticated", use_filename: true, unique_filename: true, filename_override: filename }, (e, r) => (e ? no(e) : ok(r))).end(buffer)),
  destroy: (publicId, { resourceType }) => cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: "authenticated", invalidate: true }),
  signedDownload: (c, exp) => cloudinary.utils.private_download_url(c.publicId, c.format, { resource_type: c.resourceType, type: "authenticated", expires_at: exp }),
};
export const fileStore = createFileStore({ cloud: realCloud, dir: path.resolve(process.cwd(), "uploads", "attachments") });
export const attachmentUpload = makeAttachmentUpload(fileStore);
// In front of the other upload routes too: production without Cloudinary answers 503 instead of writing to a disk that is wiped.
export const needStorage = fileStore.guard;
