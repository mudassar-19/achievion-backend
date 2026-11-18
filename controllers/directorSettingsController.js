import Organization from "../models/Organization.js";
import AuditLog     from "../models/AuditLog.js";
import User         from "../models/User.js";
import { validateAlertRules } from "../services/alertRules.js";
import { mergeSettings } from "../utils/mergeSettings.js";
import { readHolidays, holidayNamesError, pruneHolidayNames, holidayList } from "../services/workloadRules.js";

const IS_OBJECT_ID = /^[0-9a-f]{24}$/i;
function orgFilter(orgId) {
  return IS_OBJECT_ID.test(orgId ?? "") ? { _id: orgId } : { orgId };
}

const FISCAL_YEARS = ["calendar", "july-june"];
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validTimezone = (z) => {
  if (typeof z !== "string" || !z) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: z }); return true; } catch { return false; }
};
const merge = mergeSettings; // a partial save is merged into what is stored (see utils/mergeSettings.js)

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

// The fiscal year lives on the organization; older saves kept it inside gamificationSettings.
const fiscalOf = (o) => o.fiscalYear ?? o.gamificationSettings?.fiscalYear ?? "calendar";

// Helper: safe snapshot of settings sections (no credentials). A deep copy, so "before" is not changed by the save.
function orgSnapshot(org) {
  const o = org.toObject();
  return JSON.parse(JSON.stringify({
    workingTime:          o.workingTime,
    extensionRules:       o.extensionRules,
    alertSettings:        o.alertSettings,
    aiSettings:           o.aiSettings,
    gamificationSettings: o.gamificationSettings,
    fiscalYear:           fiscalOf(o),
    escalationContactId:  o.escalationContactId,
    name:                 o.name,
  }));
}

// ── GET /api/director/settings ────────────────────────────────────────────────
export async function getSettings(req, res) {
  const { orgId, id: userId } = req.user;
  const org = await Organization.findOne(orgFilter(orgId)).lean();
  if (!org) return res.status(404).json({ error: "Organization not found." });

  const wt = org.workingTime ?? {};
  // Safe fallback for docs written before workingDays rename (old field: workDays)
  const workingDays = wt.workingDays ?? wt.workDays ?? [1,2,3,4,5];
  const ai = org.aiSettings ?? {};
  const fiscalYear = fiscalOf(org);

  res.json({
    name:                 org.name,
    workingTime:          { hoursPerDay: wt.hoursPerDay ?? 7, workingDays, timezone: wt.timezone ?? "Asia/Karachi", holidays: readHolidays(wt.holidays), holidayNames: pruneHolidayNames(wt.holidayNames ?? {}, readHolidays(wt.holidays)), holidayList: holidayList(readHolidays(wt.holidays), wt.holidayNames ?? {}) },
    extensionRules:       org.extensionRules        ?? { extensionMaxDays: 3, extensionMaxPct: 20, extensionCumCapPct: 20 },
    alertSettings:        org.alertSettings         ?? {},
    aiSettings: {
      weeklySummaryEnabled: ai.weeklySummaryEnabled ?? ai.weeklyDigest ?? false,
      summaryDay:           ai.summaryDay  ?? 1,
      summaryTime:          ai.summaryTime ?? "09:00",
      costCapUsdPerDay:     ai.costCapUsdPerDay ?? 1.0,
    },
    gamificationSettings: { ...(org.gamificationSettings ?? {}), fiscalYear },
    fiscalYear,
    // Never empty: when nobody was chosen the Director (this route is Director-only) is the contact.
    escalationContactId:  org.escalationContactId   ?? userId,
  });
}

// Checks the whole body and returns { "payload.path": "message" } for every mistake (empty = fine). `cur` = the stored values.
async function validateSettings(body, cur, orgId) {
  const f = {};
  const { workingTime, extensionRules, alertSettings, aiSettings, gamificationSettings, fiscalYear, escalationContactId } = body;

  for (const [key, v] of [["workingTime", workingTime], ["extensionRules", extensionRules], ["alertSettings", alertSettings], ["aiSettings", aiSettings], ["gamificationSettings", gamificationSettings]])
    if (v !== undefined && !isPlain(v)) f[key] = `${key} must be an object.`;

  if (isPlain(workingTime)) {
    // RND-26: hoursPerDay bounds 4–12, step 0.5
    if (workingTime.hoursPerDay !== undefined) {
      const h = Number(workingTime.hoursPerDay);
      if (!Number.isFinite(h) || h < 4 || h > 12) f["workingTime.hoursPerDay"] = "hoursPerDay must be between 4 and 12.";
      else if (Math.round(h * 2) / 2 !== h) f["workingTime.hoursPerDay"] = "hoursPerDay must be a multiple of 0.5.";
    }
    // RND-26: at least 1 working day; days are weekday numbers 0 (Sun) to 6 (Sat)
    const wd = workingTime.workingDays;
    if (wd !== undefined) {
      if (!Array.isArray(wd) || wd.length < 1) f["workingTime.workingDays"] = "At least one working day is required.";
      else if (!wd.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) f["workingTime.workingDays"] = "Working days must be weekday numbers from 0 (Sunday) to 6 (Saturday).";
    }
    if (workingTime.timezone !== undefined && !validTimezone(workingTime.timezone)) f["workingTime.timezone"] = "Choose a valid time zone.";
    if (workingTime.holidayNames !== undefined) { // QA4 B-33
      const nameErr = holidayNamesError(workingTime.holidayNames, workingTime.holidays ?? readHolidays(cur.workingTime?.holidays));
      if (nameErr) f["workingTime.holidayNames"] = nameErr;
    }
    // F-001: holidays are real calendar dates "YYYY-MM-DD", at most 60, no duplicates.
    if (workingTime.holidays !== undefined) {
      const h = workingTime.holidays;
      const real = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
      if (!Array.isArray(h)) f["workingTime.holidays"] = "Holidays must be a list of dates.";
      else if (h.length > 60) f["workingTime.holidays"] = "At most 60 holidays.";
      else if (!h.every(real)) f["workingTime.holidays"] = "Every holiday must be a real date (YYYY-MM-DD).";
      else if (new Set(h).size !== h.length) f["workingTime.holidays"] = "A holiday is listed twice.";
    }
  }

  if (isPlain(extensionRules)) {
    const { extensionMaxDays: d, extensionMaxPct: p, extensionCumCapPct: c } = extensionRules;
    if (d !== undefined && (!Number.isInteger(d) || d < 0 || d > 10)) f["extensionRules.extensionMaxDays"] = "extensionMaxDays must be an integer 0–10.";
    if (p !== undefined && (typeof p !== "number" || p < 0 || p > 50)) f["extensionRules.extensionMaxPct"] = "extensionMaxPct must be 0–50.";
    if (c !== undefined && (typeof c !== "number" || c < 0 || c > 50)) f["extensionRules.extensionCumCapPct"] = "extensionCumCapPct must be 0–50.";
    // the rule is checked on the merged values, so a partial save cannot slip under the stored cap
    const m = merge(cur.extensionRules, extensionRules);
    if (!f["extensionRules.extensionMaxPct"] && !f["extensionRules.extensionCumCapPct"] && (p !== undefined || c !== undefined) && m.extensionCumCapPct < m.extensionMaxPct)
      f["extensionRules.extensionCumCapPct"] = "extensionCumCapPct must be >= extensionMaxPct.";
  }

  if (isPlain(alertSettings) && alertSettings.orgRules !== undefined)
    for (const [k, msg] of Object.entries(validateAlertRules(alertSettings.orgRules))) f[k === "orgRules" ? "alertSettings.orgRules" : `alertSettings.orgRules.${k}`] = msg;

  // the screen still sends the fiscal year inside gamificationSettings; a top-level value wins
  for (const v of [fiscalYear, isPlain(gamificationSettings) ? gamificationSettings.fiscalYear : undefined])
    if (v !== undefined && !FISCAL_YEARS.includes(v)) f.fiscalYear = "Fiscal year must be calendar or july-june.";

  if (escalationContactId !== undefined && escalationContactId !== null && escalationContactId !== "") {
    const found = typeof escalationContactId === "string" && IS_OBJECT_ID.test(escalationContactId)
      && await User.exists({ _id: escalationContactId, orgId, status: { $ne: "deleted" } });
    if (!found) f.escalationContactId = "Escalation contact not found in this organization.";
  }
  return f;
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

  const cur = org.toObject();
  const before = orgSnapshot(org);

  const fields = await validateSettings(req.body, cur, orgId);
  if (Object.keys(fields).length) return res.status(400).json({ error: Object.values(fields)[0], fields });

  const {
    name, workingTime, extensionRules, alertSettings,
    aiSettings, gamificationSettings, fiscalYear, escalationContactId,
  } = req.body;

  if (name !== undefined) org.name = String(name).trim().slice(0, 200);

  if (workingTime         !== undefined) {
    org.workingTime = merge(cur.workingTime, workingTime);
    if (workingTime.holidayNames !== undefined) org.workingTime.holidayNames = workingTime.holidayNames; // replaced as a whole, so a cleared name stays cleared
    org.workingTime.holidayNames = pruneHolidayNames(org.workingTime.holidayNames ?? {}, readHolidays(org.workingTime.holidays)); // a removed holiday loses its name
  }
  if (extensionRules      !== undefined) org.extensionRules = merge(cur.extensionRules, extensionRules);
  if (alertSettings       !== undefined) org.alertSettings  = merge(cur.alertSettings, alertSettings);
  if (aiSettings          !== undefined) org.aiSettings     = merge(cur.aiSettings, aiSettings);
  if (gamificationSettings !== undefined) {
    const gs = merge(cur.gamificationSettings, gamificationSettings);
    delete gs.fiscalYear; // lives on the organization now
    org.gamificationSettings = gs;
  }
  const fy = fiscalYear ?? gamificationSettings?.fiscalYear;
  if (fy !== undefined) org.fiscalYear = fy;

  // Never empty: clearing it (null or "") makes the Director (the person saving) the contact.
  if (escalationContactId !== undefined) org.escalationContactId = escalationContactId || userId;

  // ponytail: validateModifiedOnly — achievion_dev has one legacy customRole item
  // {label:"CR Test Lead Dev"} missing required key+category fields; full validation
  // would reject this unrelated field. A migration to patch that record would remove
  // the need for this flag.
  await org.save({ validateModifiedOnly: true });
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

  const warn = (after.workingTime?.hoursPerDay ?? 0) > 8
    ? "hoursPerDay above 8 may exceed standard working hours."
    : undefined;
  res.json({ ok: true, settings: after, ...(warn ? { warning: warn } : {}) });
}
