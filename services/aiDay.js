// QA2-70: the AI insight cache is per calendar day IN THE ORG'S TIMEZONE (not the server's), so it turns stale at the
// organisation's midnight. Pure helpers plus one org lookup.
import Organization from "../models/Organization.js";
import { orgWorkTime } from "./workloadRules.js";

const parts = (now, timeZone) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  .formatToParts(now).map((p) => [p.type, p.value]));

// "2026-11-17" for `now` in `timeZone`.
export function dayInZone(now, timeZone) { const p = parts(now, timeZone); return `${p.year}-${p.month}-${p.day}`; }

// Milliseconds until the next midnight in `timeZone` (at least 1 minute so a cache row never expires instantly).
export function msToMidnight(now, timeZone) {
  const p = parts(now, timeZone);
  return Math.max(60_000, (86400 - (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second))) * 1000);
}

// { day, ttlMs } for one org; falls back to the default timezone when the org cannot be read.
export async function orgDay(orgId, now = new Date()) {
  const org = await Organization.findById(orgId, "workingTime").lean().catch(() => null);
  let tz = orgWorkTime(org).timezone;
  try { dayInZone(now, tz); } catch { tz = "Asia/Karachi"; } // a bad stored timezone must not break the card
  return { day: dayInZone(now, tz), ttlMs: msToMidnight(now, tz) };
}
