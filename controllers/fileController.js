// S-1 (D-157): files are opened through a short signed link. Nobody outside the task or project gets one.
import Task from "../models/Task.js";
import Project from "../models/Project.js";
import Bug from "../models/Bug.js";
import { orgScope } from "./managerProjectsController.js";
import { fileStore } from "../middleware/upload.js";
import { mayOpenAny, isSafeUploadPath, signFilePath, verifyFileLink, parseCloudinaryUrl } from "../services/accessRules.js";

const NOT_FOUND = { error: "File not found." };

// GET /api/files/sign?path=/uploads/... or an authenticated Cloudinary URL → { url, exp }. Same 404 for "no such file" and "not yours".
export async function signFile(req, res) {
  const path = req.query.path;
  const cld = parseCloudinaryUrl(path);
  if (cld ? cld.cloud !== process.env.CLOUDINARY_CLOUD_NAME : !isSafeUploadPath(path)) return res.status(400).json({ error: "That is not a file path." });
  const scope = await orgScope(req.user.orgId);
  if (!scope) return res.status(404).json(NOT_FOUND);
  // E-3b (D-185): a design file handed to a developer task is also found there; the same per-task rule decides.
  // E-4 (D-192): a Tester's QA evidence sits on the task; a bug's files on the bug (opened by the people who may see its project).
  const [tasks, bugs] = await Promise.all([
    Task.find({ ...scope.filter, $or: [{ "submissionFiles.url": path }, { "attachments.url": path }, { "designHandoffs.files.url": path }, { "qaSignoffs.files.url": path }] }, "projectId assignees assignee createdBy assignedBy").limit(20).lean(),
    Bug.find({ orgId: req.user.orgId, "files.url": path }, "projectId").limit(5).lean(),
  ]);
  const projects = new Map((await Project.find({ ...scope.filter, $or: [{ _id: { $in: [...tasks, ...bugs].map((t) => t.projectId).filter(Boolean) } }, { "attachments.filePath": path }] }, "members managerId attachments.filePath").lean()).map((p) => [String(p._id), p]));
  const places = [
    ...tasks.map((task) => ({ task, project: task.projectId ? projects.get(String(task.projectId)) ?? null : null })),
    ...bugs.map((b) => ({ task: null, project: projects.get(String(b.projectId)) ?? null })).filter((x) => x.project),
  ];
  if (!places.length) places.push(...[...projects.values()].filter((p) => (p.attachments ?? []).some((a) => a.filePath === path)).map((project) => ({ task: null, project })));
  if (!mayOpenAny(req.user, places)) return res.status(404).json(NOT_FOUND);
  if (cld) {
    // Works on the Free plan, also for PDFs, and it expires; Cloudinary's own signed delivery URLs do neither (D-164).
    const link = fileStore.signedUrl(path);
    return link ? res.json(link) : res.status(503).json({ error: "File storage is not configured on this server.", code: "storage_off" });
  }
  const { exp, sig } = signFilePath(path);
  res.json({ url: `${path}?exp=${exp}&sig=${sig}`, exp });
}

// In front of express.static on /uploads. req.path is not URL-decoded, so an encoded "../" fails the path check.
export function requireSignedFile(req, res, next) {
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).end();
  const path = `/uploads${req.path}`;
  if (!isSafeUploadPath(path)) return res.status(400).json({ error: "That is not a file path." });
  const r = verifyFileLink(path, req.query);
  if (r === "expired") return res.status(401).json({ error: "This file link has expired. Open the file again." });
  if (r !== "ok") return res.status(401).json({ error: "This file needs a signed link." });
  res.set("Cache-Control", "private, no-store");
  next();
}
