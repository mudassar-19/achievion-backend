// Custom roles (D-294, IMPL-5 Part 4). Director only.
// Organization.customRoles: [{key, label, category, active}], max 20.
// User.roleLabel: display-only override; User.role enum unchanged.
import Organization from "../models/Organization.js";
import User         from "../models/User.js";
import AuditLog     from "../models/AuditLog.js";

const IS_OID   = /^[0-9a-f]{24}$/i;
const CATEGORIES = ["developer", "designer", "tester"];
const MAX_ROLES = 20;

function orgFilter(orgId) {
  return IS_OID.test(orgId ?? "") ? { _id: orgId } : { orgId };
}
function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "role";
}
function audit(orgId, userId, action, detail) {
  AuditLog.create({ action, orgId, performedBy: userId, scope: "settings", detail }).catch(() => {});
}

// GET /api/director/settings/custom-roles
export async function listCustomRoles(req, res) {
  const org = await Organization.findOne(orgFilter(req.user.orgId), "customRoles").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });
  res.json({ customRoles: org.customRoles ?? [] });
}

// POST /api/director/settings/custom-roles — { label, category }
export async function addCustomRole(req, res) {
  const { label, category } = req.body ?? {};
  const lab = String(label ?? "").trim();
  if (!lab || lab.length < 2 || lab.length > 40) return res.status(400).json({ error: "Label must be 2–40 characters." });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}.` });

  const org = await Organization.findOne(orgFilter(req.user.orgId));
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const active = (org.customRoles ?? []).filter((r) => r.active);
  if (active.length >= MAX_ROLES) return res.status(409).json({ error: `Maximum ${MAX_ROLES} custom roles allowed.` });

  // Unique key: slugify label, append counter if collision
  let key = slugify(lab);
  const existing = new Set((org.customRoles ?? []).map((r) => r.key));
  if (existing.has(key)) key = `${key}_${Date.now().toString(36)}`;

  const role = { key, label: lab, category, active: true };
  org.customRoles = [...(org.customRoles ?? []), role];
  await org.save();
  audit(org._id, req.user.id, "custom_role_added", `Custom role "${lab}" (${category}) added.`);
  res.status(201).json({ customRole: role });
}

// PATCH /api/director/settings/custom-roles/:key — { label?, category? }
export async function updateCustomRole(req, res) {
  const { key } = req.params;
  const org = await Organization.findOne(orgFilter(req.user.orgId));
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const idx = (org.customRoles ?? []).findIndex((r) => r.key === key);
  if (idx === -1) return res.status(404).json({ error: "Custom role not found." });

  const { label, category } = req.body ?? {};
  if (label !== undefined) {
    const lab = String(label).trim();
    if (lab.length < 2 || lab.length > 40) return res.status(400).json({ error: "Label must be 2–40 characters." });
    org.customRoles[idx].label = lab;
  }
  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}.` });
    org.customRoles[idx].category = category;
  }
  await org.save();
  audit(org._id, req.user.id, "custom_role_updated", `Custom role "${org.customRoles[idx].label}" updated.`);
  res.json({ customRole: org.customRoles[idx] });
}

// DELETE /api/director/settings/custom-roles/:key — deactivates (never hard-deletes)
export async function deactivateCustomRole(req, res) {
  const { key } = req.params;
  const org = await Organization.findOne(orgFilter(req.user.orgId));
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const idx = (org.customRoles ?? []).findIndex((r) => r.key === key);
  if (idx === -1) return res.status(404).json({ error: "Custom role not found." });
  if (!org.customRoles[idx].active) return res.status(409).json({ error: "Role already deactivated." });

  org.customRoles[idx].active = false;
  await org.save();
  audit(org._id, req.user.id, "custom_role_deactivated", `Custom role "${org.customRoles[idx].label}" deactivated.`);
  res.json({ customRole: org.customRoles[idx] });
}

// PATCH /api/director/settings/users/:userId/role-label — { roleLabel }
export async function setUserRoleLabel(req, res) {
  const { userId } = req.params;
  if (!IS_OID.test(userId)) return res.status(400).json({ error: "Invalid user id." });
  const raw = req.body?.roleLabel;
  const lab = (raw === null || raw === "" || raw === undefined) ? null : String(raw).trim();
  if (lab !== null && (lab.length < 2 || lab.length > 40)) return res.status(400).json({ error: "Label must be 2–40 characters or null to clear." });

  const org = await Organization.findOne(orgFilter(req.user.orgId), "_id").lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const user = await User.findOne({ _id: userId, orgId: String(org._id) });
  if (!user) return res.status(404).json({ error: "User not found in this organization." });

  user.roleLabel = lab;
  await user.save();
  audit(org._id, req.user.id, "user_role_label_set", `roleLabel for user ${userId} set to "${lab}".`);
  res.json({ userId, roleLabel: lab });
}
