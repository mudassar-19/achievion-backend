// View as (AUTH-11, M-8, D-109). A Director or Manager gets a 30-minute read-only token for a target in scope.
// Rules: services/viewAsRules.js. Read-only enforcement: middleware/viewAs.js (request guard + write block).
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../models/User.js";
import Project from "../models/Project.js";
import AuditLog from "../models/AuditLog.js";
import { orgScope } from "./managerProjectsController.js";
import { viewAsBlocker, viewAsClaims, TARGET_ROLES, baseRole, VIEW_AS_MINUTES } from "../services/viewAsRules.js";
import { ROLE_CATEGORY_MAP } from "../models/User.js";

// Manager's team = members of the projects they manage (Project.managerId).
// Team Lead's team = members of projects they are listed in (members array).
async function teamOf(req) {
  const scope = await orgScope(req.user.orgId);
  if (!scope) return new Set();
  const base = { ...scope.filter, isDeleted: { $ne: true }, status: { $nin: ["Archived", "Deleted"] } };
  if (req.user.role === "Manager") {
    const projects = await Project.find({ ...base, managerId: req.user.id }, "members").lean();
    return new Set(projects.flatMap((p) => (p.members ?? []).map(String)));
  }
  if (req.user.role === "Team Lead") {
    const projects = await Project.find({ ...base, members: new mongoose.Types.ObjectId(req.user.id) }, "members").lean();
    // Exclude the TL themselves — they can only view downward
    const tlId = String(req.user.id);
    return new Set(projects.flatMap((p) => (p.members ?? []).map(String)).filter((id) => id !== tlId));
  }
  return null;
}
const viewerOf = (req) => ({ id: req.user.id, role: req.user.role, orgId: req.user.orgId, viewAs: req.viewAs ?? null });
const audit = (req, action, viewerId, target, detail) => AuditLog.create({
  action, orgId: req.user.orgId, performedBy: viewerId, targetUserId: target._id ?? target.id, detail, scope: "session",
}).catch((e) => console.error("[audit view-as]", e.message));

// ── GET /api/auth/view-as/candidates → people this viewer may view as ───────
export async function candidates(req, res) {
  if (req.viewAs) return res.status(403).json({ error: "You are already viewing as someone. Exit that view first." });
  const roles = TARGET_ROLES[req.user.role];
  if (!roles) return res.status(403).json({ error: "Only Directors, Managers, and Team Leads can use View as." });
  const team = await teamOf(req);
  const users = await User.find({ orgId: req.user.orgId, status: "active", _id: { $ne: req.user.id } }, "name role").sort({ name: 1 }).lean();
  const people = users.filter((u) => roles.includes(baseRole(u.role)) && (!team || team.has(String(u._id))))
    .map((u) => ({ id: u._id, name: u.name, role: u.role, group: baseRole(u.role) }));
  res.json({ roles, people });
}

// ── POST /api/auth/view-as { targetId } → { token, user, viewAs } ───────────
export async function start(req, res) {
  const targetId = String(req.body?.targetId ?? "");
  const target = mongoose.isValidObjectId(targetId) && /^[0-9a-f]{24}$/i.test(targetId)
    ? await User.findById(targetId, "name email role orgId status tokenVersion").lean() : null;
  const blocked = viewAsBlocker({ viewer: viewerOf(req), target: target && { ...target, id: String(target._id), orgId: String(target.orgId) }, teamIds: await teamOf(req) });
  if (!blocked && target) target.roleCategory = ROLE_CATEGORY_MAP[target.role] ?? null;
  if (blocked) return res.status(blocked.status).json({ error: blocked.error });
  const viewer = await User.findById(req.user.id, "name role tokenVersion").lean();
  const claims = viewAsClaims({ viewer, target });
  const token = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: `${VIEW_AS_MINUTES}m` });
  const expiresAt = new Date(Date.now() + VIEW_AS_MINUTES * 60_000);
  audit(req, "view_as_started", viewer._id, target, `${viewer.name} (${viewer.role}) started viewing as ${target.name} (${target.role}), read-only, until ${expiresAt.toISOString()}.`);
  res.json({ token, expiresAt, viewAs: { ...claims.viewAs, targetId: claims.id, targetName: target.name, targetRole: target.role, expiresAt } });
}

// ── POST /api/auth/view-as/exit (view-as token only) ────────────────────────
// The client restores the viewer's own session it kept; this only records the end.
export async function exit(req, res) {
  if (!req.viewAs) return res.status(400).json({ error: "You are not viewing as anyone." });
  await audit(req, "view_as_ended", req.viewAs.viewerId, { id: req.user.id }, `${req.viewAs.viewerName} stopped viewing as ${req.user.name} (${req.user.role}).`);
  res.json({ ok: true });
}
