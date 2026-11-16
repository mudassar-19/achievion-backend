// Weekly automatic Org Health snapshot (item 18): every hour, each org whose local day is Monday (org timezone) and has no
// snapshot yet that Monday gets one. The rule is orgHealthRules.snapshotDue (tested); this file only does the database work.
import cron from "node-cron";
import Organization from "../models/Organization.js";
import OrgHealthSnapshot from "../models/OrgHealthSnapshot.js";
import { snapshotDue } from "../services/orgHealthRules.js";
import { saveSnapshot } from "../services/orgHealthService.js";

export async function snapshotDueOrgs(now = new Date()) {
  let saved = 0;
  for (const o of await Organization.find({}, "_id workingTime.timezone").lean()) {
    const orgId = String(o._id); // snapshots are keyed by the hex id, like req.user.orgId
    const last = await OrgHealthSnapshot.findOne({ orgId }, "calculatedAt").sort({ calculatedAt: -1 }).lean();
    if (!snapshotDue(now, o.workingTime?.timezone || "Asia/Karachi", last?.calculatedAt)) continue;
    await saveSnapshot(orgId, now).then(() => saved++).catch((e) => console.error(`[org-health] ${orgId}:`, e.message));
  }
  return saved;
}

export function startOrgHealthJob() {
  cron.schedule("15 * * * *", () => snapshotDueOrgs().then((n) => n && console.log(`[org-health] snapshots: ${n}`)).catch((e) => console.error("[org-health]", e.message)));
}
