// SEC: small pure auth rules. Tests: tests/sec2RegisterGate.test.mjs and the other sec*.test.mjs files.
// M-1: the legacy "register without an organization" route is for dev/demo only.
export const legacyRegisterOpen = (env = process.env) => env.NODE_ENV !== "production" || env.ALLOW_LEGACY_REGISTER === "1";

// SEC M-8: the same e-mail can exist in two organizations (the unique key is e-mail + organization). Forgot/reset therefore work inside ONE organization:
// with an organization code the account is that organization's; without one it is only allowed when the e-mail belongs to exactly one account.
// users: [{ _id, orgId }] with that e-mail; orgIds: the strings that identify the chosen organization (or null when no code was given).
export function pickResetUser(users, orgIds = null) {
  const pool = orgIds ? users.filter((u) => orgIds.includes(String(u.orgId))) : users;
  if (pool.length === 1) return { user: pool[0] };
  if (pool.length === 0) return { user: null };
  return { user: null, needOrgCode: true };
}

// SEC M-22: the role and its category come from the DATABASE; the token's copy is used only while it is still the same role.
export function effectiveRole(decoded, dbUser, categoryMap) {
  const role = dbUser?.role ?? decoded.role;
  return { role, roleCategory: role === decoded.role ? decoded.roleCategory ?? categoryMap[role] : categoryMap[role] ?? decoded.roleCategory };
}
