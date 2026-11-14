// Batch 5 — Director and shared leftovers: departments (D4, FR12-02), a member's department (N5, FR01-08), skills and
// phone on the own profile (N4, FR01-06), the organisation logo (D7, FR12-01). Rules: departmentRules.js, brandingRules.js.
// Everything is scoped to the caller's own organisation (taken from the token, never from the request).
import fs from "fs";
import path from "path";
import multer from "multer";
import mongoose from "mongoose";
import Organization from "../models/Organization.js";
import User from "../models/User.js";
import AuditLog from "../models/AuditLog.js";
import cloudinary from "../config/cloudinary.js";
import { cloudinaryConfigured } from "../middleware/upload.js";
import { addDepartment, renameDepartment, mayAssign, readDepartmentName, readSkills, readPhone } from "../services/departmentRules.js";
import { readLogo, LOGO_MAX_BYTES, LOGO_MIME } from "../services/brandingRules.js";

const IS_OID = /^[0-9a-f]{24}$/i;
const orgOf = (req, fields) => Organization.findOne(IS_OID.test(req.user.orgId) ? { _id: req.user.orgId } : { orgId: req.user.orgId }, fields);
const membersOf = (org) => ({ $or: [{ orgId: String(org._id) }, { orgId: org.orgId }], status: { $ne: "deleted" } });
const audit = (org, req, action, detail, extra = {}) => AuditLog.create({ action, orgId: org._id, performedBy: req.user.id, scope: "org", detail, ...extra }).catch((e) => console.error("[audit]", e.message));
const fail = (res, v) => res.status(v.status).json({ error: v.error, field: v.field });
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// ── Departments ──────────────────────────────────────────────────────────────
// A department that only exists on members (set before this screen existed) is listed too, so it can be renamed.
async function departmentList(org) {
  const counts = await User.aggregate([{ $match: { ...membersOf(org), department: { $nin: [null, ""] } } }, { $group: { _id: "$department", n: { $sum: 1 } } }]);
  const archived = org.archivedDepartments ?? [];
  const names = [...(org.departments ?? [])];
  for (const c of counts) if (![...names, ...archived].some((d) => same(d, c._id))) names.push(c._id);
  const membersIn = (name) => counts.filter((c) => same(c._id, name)).reduce((s, c) => s + c.n, 0);
  return [...names.map((name) => ({ name, members: membersIn(name), archived: false })), ...archived.map((name) => ({ name, members: membersIn(name), archived: true }))]
    .sort((a, b) => a.archived - b.archived || a.name.localeCompare(b.name));
}
// GET /api/director/departments → { departments: [active names], items: [{ name, members, archived }] }
export async function listDepartments(req, res) {
  const org = await orgOf(req, "orgId departments archivedDepartments").lean();
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  const items = await departmentList(org);
  res.json({ departments: items.filter((d) => !d.archived).map((d) => d.name), items });
}
// Names that live only on members become part of the organisation's list the first time the list is changed.
async function adopt(org) {
  const items = await departmentList(org);
  org.departments = items.filter((d) => !d.archived).map((d) => d.name);
  return org;
}
// POST /api/director/departments { name }
export async function createDepartment(req, res) {
  const org = await orgOf(req, "orgId departments archivedDepartments");
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  const v = addDepartment(await adopt(org), req.body?.name);
  if (!v.ok) return fail(res, v);
  org.departments = v.departments;
  await org.save();
  audit(org, req, "department_created", `Department "${v.departments.at(-1)}" created.`);
  res.status(201).json({ items: await departmentList(org) });
}
// PATCH /api/director/departments { from, name } → rename; members of the department follow.
export async function renameDepartmentRoute(req, res) {
  const org = await orgOf(req, "orgId departments archivedDepartments");
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  const v = renameDepartment(await adopt(org), req.body?.from, req.body?.name);
  if (!v.ok) return fail(res, v);
  org.departments = v.departments; org.archivedDepartments = v.archivedDepartments;
  await org.save();
  const moved = v.from === v.to ? { modifiedCount: 0 } : await User.updateMany({ ...membersOf(org), department: v.from }, { $set: { department: v.to } });
  audit(org, req, "department_renamed", `Department "${v.from}" renamed to "${v.to}" (${moved.modifiedCount} members).`, { before: { name: v.from }, after: { name: v.to } });
  res.json({ items: await departmentList(org), moved: moved.modifiedCount });
}
// POST /api/director/departments/archive { name, archived } → archived: nobody new can be put in it; members keep it.
export async function archiveDepartment(req, res) {
  const org = await orgOf(req, "orgId departments archivedDepartments");
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  const n = readDepartmentName(req.body?.name);
  if (!n.ok) return fail(res, n);
  if (typeof req.body?.archived !== "boolean") return res.status(400).json({ error: "Say whether to archive or restore.", field: "archived" });
  await adopt(org);
  const [fromList, toList] = req.body.archived ? ["departments", "archivedDepartments"] : ["archivedDepartments", "departments"];
  const name = (org[fromList] ?? []).find((d) => same(d, n.name));
  if (!name) return (org[toList] ?? []).some((d) => same(d, n.name)) ? res.json({ items: await departmentList(org), unchanged: true }) : res.status(404).json({ error: "Department not found." });
  org[fromList] = org[fromList].filter((d) => d !== name); org[toList] = [...(org[toList] ?? []), name];
  await org.save();
  audit(org, req, req.body.archived ? "department_archived" : "department_restored", `Department "${name}" ${req.body.archived ? "archived" : "restored"}.`);
  res.json({ items: await departmentList(org) });
}
// PATCH /api/director/team/:userId/department { department } (N5). Managers have no such route (D-275).
export async function setMemberDepartment(req, res) {
  if (!mongoose.isValidObjectId(req.params.userId) || !IS_OID.test(req.params.userId)) return res.status(404).json({ error: "Person not found." });
  const org = await orgOf(req, "orgId departments archivedDepartments").lean();
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  const member = await User.findOne({ _id: req.params.userId, ...membersOf(org) }, "name role department");
  if (!member) return res.status(404).json({ error: "Person not found." }); // another organisation's person looks the same as no person
  if (member.role === "Director") return res.status(403).json({ error: "A Director's department is not changed here." });
  const v = mayAssign({ ...org, departments: (await departmentList(org)).filter((d) => !d.archived).map((d) => d.name) }, req.body?.department);
  if (!v.ok) return fail(res, v);
  const before = member.department ?? null;
  if (before === v.department) return res.json({ id: member._id, department: before, unchanged: true });
  member.department = v.department;
  await member.save();
  audit(org, req, "member_department_changed", `${member.name}: department ${before ?? "none"} → ${v.department ?? "none"}.`, { targetUserId: member._id, before: { department: before }, after: { department: v.department } });
  res.json({ id: member._id, department: v.department });
}

// ── Own profile: skills and phone (N4) ───────────────────────────────────────
// PATCH /api/auth/profile-details { skills?, phone? } — any signed-in person, for themselves only.
export async function updateProfileDetails(req, res) {
  const set = {};
  if (req.body?.skills !== undefined) { const v = readSkills(req.body.skills); if (!v.ok) return fail(res, v); set.skills = v.skills; }
  if (req.body?.phone !== undefined) { const v = readPhone(req.body.phone); if (!v.ok) return fail(res, v); set.phone = v.phone; }
  if (!Object.keys(set).length) return res.status(400).json({ error: "Nothing to save. Send skills or phone." });
  const user = await User.findByIdAndUpdate(req.user.id, { $set: set }, { returnDocument: "after", projection: "skills phone" }).lean();
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ skills: user.skills ?? [], phone: user.phone ?? null });
}
// GET /api/auth/profile-details
export async function getProfileDetails(req, res) {
  const user = await User.findById(req.user.id, "skills phone").lean();
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ skills: user.skills ?? [], phone: req.viewAs ? null : user.phone ?? null }); // the phone is private in View as, like the email (D-218)
}

// ── Organisation logo (D7) ───────────────────────────────────────────────────
const BRANDING_DIR = path.resolve(process.cwd(), "uploads", "branding");
// Kept in memory first (1 MB at most) so the first bytes are checked before anything is stored.
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LOGO_MAX_BYTES, files: 1 } }).single("logo");
export const receiveLogo = (req, res, next) => logoUpload(req, res, (err) => {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "The logo is larger than 1 MB. Choose a smaller image." });
  res.status(400).json({ error: "Send one image file in the field \"logo\"." });
});
async function store(org, file, v) {
  if (cloudinaryConfigured) { // same account and folder scheme as the other uploads; a logo is not private
    const up = await new Promise((ok, no) => cloudinary.uploader.upload_stream({ folder: `achievion/${org._id}/branding`, resource_type: "image", format: v.type },
      (e, r) => (e ? no(e) : ok(r))).end(file.buffer));
    return { url: up.secure_url, file: null };
  }
  fs.mkdirSync(BRANDING_DIR, { recursive: true });
  const name = `${org._id}-${Date.now()}${v.ext}`; // the name is ours; the uploaded name is never used on disk
  await fs.promises.writeFile(path.join(BRANDING_DIR, name), file.buffer, { flag: "wx" });
  return { url: null, file: name };
}
// POST /api/director/branding/logo (multipart, field "logo")
export async function uploadLogo(req, res) {
  const v = readLogo(req.file);
  if (!v.ok) return res.status(v.status).json({ error: v.error });
  const org = await orgOf(req, "orgId name logo");
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  const kept = await store(org, req.file, v);
  org.logo = { ...kept, type: v.type, size: req.file.size, updatedAt: new Date(), updatedBy: req.user.id };
  await org.save();
  audit(org, req, "org_logo_updated", `Organisation logo changed (${v.type.toUpperCase()}, ${Math.round(req.file.size / 1024)} KB).`);
  res.status(201).json({ logo: { type: v.type, updatedAt: org.logo.updatedAt } });
}
// DELETE /api/director/branding/logo → back to the default mark. The stored file is left where it is.
export async function removeLogo(req, res) {
  const org = await orgOf(req, "orgId logo");
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  if (!org.logo?.type) return res.json({ logo: null, unchanged: true });
  org.logo = undefined;
  await org.save();
  audit(org, req, "org_logo_removed", "Organisation logo removed; the default mark is shown.");
  res.json({ logo: null });
}
// The logo's bytes for the caller's own organisation: { buffer, type } or null. Also used by the report PDFs.
export async function logoBytes(orgId) {
  const org = await Organization.findOne(IS_OID.test(orgId) ? { _id: orgId } : { orgId }, "logo").lean();
  const l = org?.logo;
  if (!l?.type) return null;
  try {
    if (l.file) return { buffer: await fs.promises.readFile(path.join(BRANDING_DIR, path.basename(l.file))), type: l.type };
    if (l.url) { const r = await fetch(l.url, { signal: AbortSignal.timeout(8000) }); if (r.ok) return { buffer: Buffer.from(await r.arrayBuffer()), type: l.type }; }
  } catch { /* missing file → default mark */ }
  return null;
}
// GET /api/auth/branding → { orgName, logo: { type, updatedAt } | null } · GET /api/auth/branding/logo → the image
export async function getBranding(req, res) {
  const org = await orgOf(req, "name logo").lean();
  if (!org) return res.status(404).json({ error: "Organisation not found." });
  res.json({ orgName: org.name ?? null, logo: org.logo?.type ? { type: org.logo.type, updatedAt: org.logo.updatedAt } : null });
}
export async function getLogo(req, res) {
  const logo = await logoBytes(req.user.orgId);
  if (!logo) return res.status(404).json({ error: "This organisation has no logo." });
  res.set({ "Content-Type": LOGO_MIME[logo.type], "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300", "Content-Disposition": "inline" });
  res.send(logo.buffer);
}
