// SEC P-12: the Director reads projects ORGANIZATION-wide. Before, every Director query was `director: { $in: <the org's Directors> }`, which
// silently dropped any project whose `director` is empty (made before a Director existed, by a script, or from an old version).
import Organization from "../models/Organization.js";
const IS_OID = /^[0-9a-f]{24}$/i;
// → { orgId: { $in: [hex id, org code] } } for Project queries (Project.orgId is stored as the hex string, old rows as the code).
export async function orgProjectScope(orgId) {
  const org = await Organization.findOne(IS_OID.test(String(orgId)) ? { _id: orgId } : { orgId }, "_id orgId").lean();
  const ids = org ? [String(org._id), ...(org.orgId ? [org.orgId] : [])] : [String(orgId)];
  return { orgId: { $in: ids } };
}
