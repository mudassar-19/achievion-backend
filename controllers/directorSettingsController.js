import Organization from "../models/Organization.js";
import AuditLog     from "../models/AuditLog.js";
import Project      from "../models/Project.js";
import User         from "../models/User.js";

const IS_OBJECT_ID = /^[0-9a-f]{24}$/i;
function orgFilter(orgId) {
  return IS_OBJECT_ID.test(orgId ?? "") ? { _id: orgId } : { orgId };
}

async function writeAuditEntry({ orgId, performedBy, action, before, after, ip, device }) {
  return AuditLog.create({
    action,
    orgId,
    performedBy,
    scope:  "settings",
    before: before ?? null,
    after:  after  ?? null,
    ip:     ip     ?? null,
    device: device ? device.slice(0, 200) : null,
  });
}

// Helper: safe snapshot of settings sections (no credentials)
function orgSnapshot(org) {
  return {
    workingTime:          org.workingTime,
    extensionRules:       org.extensionRules,
    alertSettings:        org.alertSettings,
    aiSettings:           org.aiSettings,
    gamificationSettings: org.gamificationSettings,
    escalationContactId:  org.escalationContactId,
    name:                 org.name,
  };
}

// ── GET /api/director/settings ────────────────────────────────────────────────
export async function getSettings(req, res) {
  const { orgId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId)).lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const wt = org.workingTime ?? {};
  // Safe fallback for docs written before workingDays rename (old field: workDays)
  const workingDays = wt.workingDays ?? wt.workDays ?? [1,2,3,4,5];
  const ai = org.aiSettings ?? {};

  res.json({
    name:                 org.name,
    workingTime:          { hoursPerDay: wt.hoursPerDay ?? 7, workingDays },
    extensionRules:       org.extensionRules        ?? { extensionMaxDays: 3, extensionMaxPct: 20, extensionCumCapPct: 20 },
    alertSettings:        org.alertSettings         ?? {},
    aiSettings: {
      weeklySummaryEnabled: ai.weeklySummaryEnabled ?? ai.weeklyDigest ?? false,
      summaryDay:           ai.summaryDay  ?? 1,
      summaryTime:          ai.summaryTime ?? "09:00",
      costCapUsdPerDay:     ai.costCapUsdPerDay ?? 1.0,
    },
    gamificationSettings: org.gamificationSettings  ?? null,
    escalationContactId:  org.escalationContactId   ?? null,
  });
}

// ── PATCH /api/director/settings ─────────────────────────────────────────────
export async function updateSettings(req, res) {
  const { orgId, id: userId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId));
  if (!org) return res.status(404).json({ error: "Organization not found." });

  // Normalize workingTime: accept both workingDays (new) and workDays (old client) field names
  if (req.body.workingTime?.workDays && !req.body.workingTime.workingDays) {
    req.body.workingTime.workingDays = req.body.workingTime.workDays;
    delete req.body.workingTime.workDays;
  }

  const before = orgSnapshot(org);

  const {
    name, workingTime, extensionRules, alertSettings,
    aiSettings, gamificationSettings, escalationContactId,
  } = req.body;

  if (name                 !== undefined) org.name                 = String(name).trim().slice(0, 200);
  if (workingTime          !== undefined) org.workingTime          = workingTime;
  if (extensionRules       !== undefined) org.extensionRules       = extensionRules;
  if (alertSettings        !== undefined) org.alertSettings        = alertSettings;
  if (aiSettings           !== undefined) org.aiSettings           = aiSettings;
  if (gamificationSettings !== undefined) org.gamificationSettings = gamificationSettings;
  if (escalationContactId  !== undefined) {
    if (escalationContactId === null) {
      org.escalationContactId = null;
    } else {
      // Verify the referenced user belongs to this org
      const contact = await User.findOne({ _id: escalationContactId, orgId, status: { $ne: "deleted" } }, "_id").lean();
      if (!contact) return res.status(400).json({ error: "Escalation contact not found in this organization." });
      org.escalationContactId = escalationContactId;
    }
  }

  await org.save();
  const after = orgSnapshot(org);

  await writeAuditEntry({
    orgId,
    performedBy: userId,
    action:      "settings_updated",
    before,
    after,
    ip:     req.ip,
    device: req.headers["user-agent"],
  });

  res.json({ ok: true, settings: after });
}

// ── POST /api/director/settings/reset-xp-pools ───────────────────────────────
// Resets Project.xpPool to 0 for every project in the org.
// NEVER touches GamificationProfile (member XP/gold/levels are unaffected).
export async function resetXpPools(req, res) {
  const { orgId, id: userId } = req.user;
  const { confirm } = req.body;
  if (confirm !== "RESET XP POOL") {
    return res.status(400).json({ error: "Type 'RESET XP POOL' to confirm." });
  }

  // Capture before state
  const projects = await Project.find({ orgId }, "_id title xpPool").lean();
  const before = {
    projectCount: projects.length,
    pools: projects.map((p) => ({ id: p._id, title: p.title, xpPool: p.xpPool })),
  };

  // Reset xpPool to 0 on all org projects
  const result = await Project.updateMany({ orgId }, { $set: { xpPool: 0 } });

  const after = {
    projectCount:    projects.length,
    projectsUpdated: result.modifiedCount,
    xpPoolReset:     0,
  };

  await AuditLog.create({
    action:      "GAMIFICATION_RESET",
    orgId,
    performedBy: userId,
    scope:       "settings",
    before,
    after,
    ip:          req.ip,
    device:      req.headers["user-agent"]?.slice(0, 200) ?? null,
  });

  res.json({ ok: true, projectsUpdated: result.modifiedCount });
}
