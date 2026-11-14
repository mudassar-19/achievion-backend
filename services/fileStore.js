// Where uploaded files are kept (Deploy-prep A, D-300). Render's disk is wiped on every deploy, so with Cloudinary configured
// every file goes there as type "authenticated" (private); our API checks login, organisation and membership and then hands
// out a short-lived signed link (controllers/fileController.js). Without Cloudinary: development uses the local disk with one
// warning; production refuses the upload (503) so nothing is silently lost on the next deploy. Never throws at boot.
// `cloud` is an adapter { configured(), upload(buffer, { folder, filename }) → { secure_url }, destroy(publicId, { resourceType }),
// signedDownload(parsed, exp) → url } so the tests use a fake and need no network.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseCloudinaryUrl, stripCloudinarySignature, FILE_LINK_SECONDS } from "./accessRules.js";

export const NOT_STORED = { error: "File storage is not configured on this server, so files cannot be uploaded right now.", code: "storage_off" };

export function createFileStore({ cloud, dir, env = () => process.env.NODE_ENV, warn = console.warn, log = console.error }) {
  let warned = false;
  const mode = () => (cloud.configured() ? "cloud" : env() === "production" ? "refuse" : "disk");
  const noteDisk = () => { if (!warned) { warned = true; warn("[files] Cloudinary is not configured: files are kept on the local disk (development only; production would refuse uploads)."); } };

  // Express guard: put it in front of every upload route (before multer reads the body).
  const guard = (_req, res, next) => {
    const m = mode();
    if (m === "refuse") return res.status(503).json(NOT_STORED);
    if (m === "disk") noteDisk();
    next();
  };

  // file = { buffer, originalname }; → { url, filePath, filename }. Throws { status: 503 } when production has no storage.
  async function save(file, { orgId, folder = "attachments" }) {
    const m = mode();
    if (m === "refuse") throw Object.assign(new Error(NOT_STORED.error), { status: 503, expose: true });
    if (m === "cloud") {
      const r = await cloud.upload(file.buffer, { folder: `achievion/${orgId}/${folder}`, filename: file.originalname });
      const url = stripCloudinarySignature(r.secure_url); // the s--…-- part never expires, so it is not stored
      return { url, filePath: url, filename: url.split("/").pop() };
    }
    noteDisk();
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${Date.now()}-${crypto.randomInt(1e9)}${path.extname(file.originalname).toLowerCase()}`;
    await fs.promises.writeFile(path.join(dir, filename), file.buffer, { flag: "wx" });
    const p = `/uploads/${path.basename(dir)}/${filename}`;
    return { url: p, filePath: p, filename };
  }

  // Delete what a record points to: the Cloudinary asset, or the disk file. Best effort: a failure is logged, never thrown.
  async function remove(url) {
    try {
      const c = parseCloudinaryUrl(url);
      if (c) { if (cloud.configured()) await cloud.destroy(c.publicId, { resourceType: c.resourceType }); return; }
      if (typeof url === "string" && url.startsWith(`/uploads/${path.basename(dir)}/`)) await fs.promises.rm(path.join(dir, path.basename(url)), { force: true });
    } catch (e) { log("[files] could not delete", String(url).slice(0, 80), e?.message); }
  }

  // Short-lived signed link for a stored Cloudinary file (null when the URL is not one of ours). Permission is checked by the caller.
  function signedUrl(url, now = Date.now()) {
    const c = parseCloudinaryUrl(url);
    if (!c || !cloud.configured()) return null;
    const exp = Math.floor(now / 1000) + FILE_LINK_SECONDS;
    return { exp, url: cloud.signedDownload(c, exp) };
  }
  return { mode, guard, save, remove, signedUrl };
}
