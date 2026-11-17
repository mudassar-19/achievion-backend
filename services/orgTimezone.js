// The org's time zone (Settings > Working Time), for the one on-time rule. Falls back to Karachi, the app default.
import Organization from "../models/Organization.js";
const IS_OID = /^[0-9a-fA-F]{24}$/;
export async function orgTimezone(orgId) {
  const org = await Organization.findOne(IS_OID.test(String(orgId)) ? { _id: orgId } : { orgId }, "workingTime.timezone").lean();
  return org?.workingTime?.timezone || "Asia/Karachi";
}
