// Upload pipeline for project and task attachments: storage guard (503 in production without Cloudinary) → multer in memory
// (5 MB, files counted) → type check by name AND first bytes → save through the file store. A refused file stores nothing:
// files saved earlier in the same request are removed again. Each file gets file.stored = { url, filePath, filename }.
import multer from "multer";
import { checkAttachment, ATTACHMENT_MAX_BYTES } from "../services/attachmentRules.js";
import { uploadError } from "../services/submitRules.js";

export function makeAttachmentUpload(store) {
  return (field, max) => {
    const parse = multer({ storage: multer.memoryStorage(), limits: { fileSize: ATTACHMENT_MAX_BYTES, files: max } }).array(field, max);
    const read = (req, res, next) => parse(req, res, (err) => {
      if (!err) return next();
      const e = uploadError(err);
      if (e.status === 500) console.error("[upload]", err.message);
      res.status(e.status).json({ error: e.error, field: e.field });
    });
    const keep = async (req, res, next) => {
      const files = req.files ?? [], saved = [];
      for (const f of files) {
        const v = checkAttachment(f);
        if (!v.ok) return res.status(v.status).json({ error: v.error, field: field });
      }
      try {
        for (const f of files) { f.stored = await store.save(f, { orgId: req.user?.orgId, folder: "attachments" }); saved.push(f.stored.url); }
      } catch (e) {
        await Promise.all(saved.map((u) => store.remove(u)));
        if (e.status === 503) return res.status(503).json({ error: e.message, code: "storage_off" });
        console.error("[upload] store failed:", e.message);
        return res.status(502).json({ error: "The files could not be stored. Try again." });
      }
      next();
    };
    return [store.guard, read, keep];
  };
}
