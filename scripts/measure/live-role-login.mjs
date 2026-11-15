/**
 * Role login check — logs in all 10 test accounts, prints role table.
 * Usage: node server/scripts/measure/live-role-login.mjs
 * Writes tokens to /tmp/live-tokens.json for reuse by other live scripts.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
for (const f of [".env.live", ".env.test"]) {
  const fp = path.join(root, f);
  if (!existsSync(fp)) continue;
  for (const l of readFileSync(fp, "utf8").split("\n")) {
    const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1).trim();
  }
}

const BASE = process.env.LIVE_BACKEND_URL?.replace(/\/$/, "");
if (!BASE) { console.error("LIVE_BACKEND_URL not set"); process.exit(1); }

const ORG_CODE = process.env.LIVE_ORG_CODE ?? process.env.ORG_CODE;

const ROLES = ["ORGADMIN","DIRECTOR","MANAGER","TEAMLEAD","SENDEV","JUNDEV","SENDES","JUNDES","SENTES","JUNTEST"];

const tokens = {};
const rows = [];

for (const role of ROLES) {
  const email    = process.env[`LIVE_${role}_EMAIL`];
  const password = process.env[`LIVE_${role}_PASSWORD`];
  if (!email || !password) { rows.push({ role, status: "N/A", roleField: "no creds", pass: false }); continue; }

  // ORGADMIN uses /api/org/login (no orgCode), others use /api/auth/login
  const url  = role === "ORGADMIN" ? `${BASE}/api/org/login` : `${BASE}/api/auth/login`;
  const body = role === "ORGADMIN"
    ? { email, password }
    : { email, password, orgCode: ORG_CODE };

  let status, roleField = "—", token = null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = r.status;
    if (r.ok) {
      const j = await r.json();
      // org login: { success, data: { token, org } }; auth login: { token, user: { role } }
      token     = j.data?.token ?? j.token ?? j.accessToken ?? null;
      roleField = j.user?.role ?? j.data?.org?.role ?? j.role ?? "OrgAdmin";
    }
  } catch (e) { status = "ERR"; }

  if (status === 429) { rows.push({ role, status: "429", roleField: "SKIP", pass: false }); continue; }
  if (token) tokens[role] = token;
  rows.push({ role, status: String(status), roleField, pass: status === 200 });
}

// Save tokens for other scripts
writeFileSync("/tmp/live-tokens.json", JSON.stringify(tokens));

const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + [
  `| ${"Role".padEnd(10)} | ${"Status".padEnd(6)} | ${"role-in-response".padEnd(18)} | Result |`,
  `| ${"-".repeat(10)} | ${"-".repeat(6)} | ${"-".repeat(18)} | ------ |`,
  ...rows.map(r => `| ${pad(r.role,10)} | ${pad(r.status,6)} | ${pad(r.roleField,18)} | ${r.pass?"PASS":"FAIL"} |`),
].join("\n") + "\n");

const passed = rows.filter(r => r.pass).length;
console.log(`${passed}/${rows.length} role logins passed.`);

// OrgAdmin hash check: GET /api/org/employees must not leak password hashes
if (tokens["ORGADMIN"]) {
  const r = await fetch(`${BASE}/api/org/employees`, { headers: { authorization: `Bearer ${tokens["ORGADMIN"]}` } });
  const body = await r.text();
  const leaked = ["$2a$", "$2b$", "passwordHash"].some((s) => body.includes(s));
  console.log(`\nOrgAdmin /api/org/employees hash check: ${leaked ? "FAIL — hash found" : "PASS — clean"} (status ${r.status})`);
} else {
  console.log("\nOrgAdmin hash check: SKIP (no token)");
}

process.exit(passed === rows.length ? 0 : 1);
