// H1a: the org's Alerts rules (alertSettings.orgRules, saved by Director Settings > Alerts) and the one place that reads them.
// A value the Director never set keeps the number that used to be hard-coded.
import { HP_BURNOUT } from "./xpEngine.js";

const IS_OID = /^[0-9a-f]{24}$/i;

// min / max / label per whole-number rule (same bounds as the Alerts screen)
export const ALERT_BOUNDS = {
  overloadLimitPct: { min: 50, max: 150, label: "Overload limit" },
  deadlineWarnPct:  { min: 50, max: 95,  label: "Deadline warning point" },
  hpThresholdPct:   { min: 10, max: 60,  label: "Burnout warning (HP)" },
  emailDelayMin:    { min: 1,  max: 60,  label: "Email after inactivity" },
  dailyFyiLimit:    { min: 1,  max: 10,  label: "Daily FYI limit" },
};

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

// deadlineWarnPct null = not set: the old "24 h before the deadline" alert (xpEngine.deadlineAlertDue).
export function getAlertSettings(org) {
  const r = org?.alertSettings?.orgRules ?? {};
  return {
    overloadLimitPct: num(r.overloadLimitPct, num(org?.workloadThresholdPct, 100)),
    deadlineWarnPct:  num(r.deadlineWarnPct, null),
    hpThresholdPct:   num(r.hpThresholdPct, HP_BURNOUT),
    streakReminder:   typeof r.streakReminder === "boolean" ? r.streakReminder : true,
    emailDelayMin:    num(r.emailDelayMin, 5),
    dailyFyiLimit:    num(r.dailyFyiLimit, 1),
  };
}

// Only the keys that are present are checked (a partial save is allowed). Returns { field: message }.
export function validateAlertRules(orgRules) {
  if (!orgRules || typeof orgRules !== "object" || Array.isArray(orgRules)) return { orgRules: "orgRules must be an object." };
  const out = {};
  for (const [k, { min, max, label }] of Object.entries(ALERT_BOUNDS)) {
    const v = orgRules[k];
    if (v !== undefined && !(typeof v === "number" && Number.isInteger(v) && v >= min && v <= max)) out[k] = `${label} must be a whole number from ${min} to ${max}.`;
  }
  if (orgRules.streakReminder !== undefined && typeof orgRules.streakReminder !== "boolean") out.streakReminder = "Streak-break reminder must be on or off.";
  return out;
}

// For code that only has an orgId (cron jobs, e-mail). Falls back to the defaults when the org is not found.
export async function orgAlertSettings(orgId) {
  const { default: Organization } = await import("../models/Organization.js");
  const org = await Organization.findOne(IS_OID.test(String(orgId ?? "")) ? { _id: orgId } : { orgId }, "alertSettings workloadThresholdPct").lean().catch(() => null);
  return getAlertSettings(org ?? {});
}
