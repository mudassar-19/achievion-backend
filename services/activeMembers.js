// C-9/C-10/G-7: ONE meaning of "a member of the org". Removed (deleted), rejected and unapproved people are never counted;
// suspended ones are not active either. The Director is a member too, reported separately where a count says "employees".
import User from "../models/User.js";

export const ACTIVE_STATUSES = ["active", "pending_suspension"];

/** Query filter for the org's active members. employeesOnly drops the Director (14 employees + 1 Director). */
export const activeFilter = (orgId, { employeesOnly = false } = {}) => ({
  orgId: { $in: [].concat(orgId).map(String) }, status: { $in: ACTIVE_STATUSES }, ...(employeesOnly ? { role: { $ne: "Director" } } : {}),
});

export const activeMembers = (orgId, opts = {}, fields = "_id name role department") => User.find(activeFilter(orgId, opts), fields).lean();
export const activeMemberIds = async (orgId, opts = {}) => (await activeMembers(orgId, opts, "_id")).map((u) => u._id);
