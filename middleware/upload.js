import multer from "multer";
import path   from "path";
import fs     from "fs";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import cloudinary from "../config/cloudinary.js";
import { SUBMISSION_FORMATS, isAllowedSubmissionFile, stripCloudinarySignature } from "../services/accessRules.js";
import { uploadError } from "../services/submitRules.js";
import { createFileStore } from "../services/fileStore.js";
import { makeAttachmentUpload } from "./attachmentUpload.js";

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

let uploadStorage;
if (cloudinaryConfigured) {
  uploadStorage = new CloudinaryStorage({
    cloudinary,
    params: async (req, file) => ({
      folder:          `achievion/${req.user?.orgId}/submissions`,
      allowed_formats: SUBMISSION_FORMATS,
      resource_type:   "auto",
      type:            "authenticated", // S-2 (D-164): private; opened only through GET /api/files/sign
      use_filename:    true,
      unique_filename: true,
      filename_override: file.originalname,
    }),
  });
} else {
  // Fallback: store submissions on disk when Cloudinary creds are not set
  uploadStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, SUBMISSIONS_DIR),
    filename:    (_req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${path.extname(file.originalname).toLowerCase()}`);
    },
  });
}

export const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  // S-2 (S13, D-165): disk files are served from the API's own address, so a .html or .svg must never get in.
  fileFilter: (_req, file, cb) => {
    if (isAllowedSubmissionFile(file.originalname)) return cb(null, true);
    cb(Object.assign(new Error("This file type is not allowed. Use JPG, PNG, PDF, ZIP, DOCX, XLSX, TXT or MD."), { status: 400 }));
  },
});

// Submission-type files (D-164, D-165) with clear 400s (E-3: multer limit errors carried no status → 500). Used by the
// employee composer and the E-4 Quality forms (bug files, QA evidence).
export const uploadFiles = (req, res, next) => needStorage(req, res, () => upload.array("files", 5)(req, res, (err) => {
  if (!err) return next();
  const e = uploadError(err);
  if (e.status === 500) console.error("[upload]", err.message);
  res.status(e.status).json({ error: e.error, field: e.field });
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
