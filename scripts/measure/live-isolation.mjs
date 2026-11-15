/**
 * Role isolation check — verifies route-level RBAC on live backend.
 * Usage: node server/scripts/measure/live-isolation.mjs
 * Requires /tmp/live-tokens.json from live-role-login.mjs
 */
import { readFileSync, existsSync } from "node:fs";
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

const tokens = JSON.parse(readFileSync("/tmp/live-tokens.json", "utf8"));

const get = (route, role) => {
  const tok = tokens[role];
  const headers = tok ? { authorization: `Bearer ${tok}` } : {};
  return fetch(`${BASE}${route}`, { headers }).then(r => r.status);
};

const checks = [
  // Director-only routes (approvals mounted at /api/approvals, restricted to Director)
  { route: "/api/approvals",           role: "DIRECTOR",  expected: 200 },
  { route: "/api/approvals",           role: "SENDEV",    expected: 403 },
  { route: "/api/approvals",           role: "MANAGER",   expected: 403 },
  { route: "/api/director/settings",   role: "DIRECTOR",  expected: 200 },
  { route: "/api/director/settings",   role: "SENDEV",    expected: 403 },
  // Manager-only routes
  { route: "/api/manager/team",        role: "MANAGER",   expected: 200 },
  { route: "/api/manager/team",        role: "SENDEV",    expected: 403 },
  { route: "/api/manager/anomalies",   role: "MANAGER",   expected: 200 },
  { route: "/api/manager/anomalies",   role: "SENDEV",    expected: 403 },
  // Developer workspace
  { route: "/api/workspace/tasks",     role: "SENDEV",    expected: 200 },
  // No token → 401
  { route: "/api/workspace/tasks",     role: "NONE",      expected: 401 },
];

const rows = [];
for (const c of checks) {
  if (c.role !== "NONE" && !tokens[c.role]) {
    rows.push({ ...c, actual: "SKIP (no token)", pass: false });
    continue;
  }
  const actual = c.role === "NONE"
    ? await fetch(`${BASE}${c.route}`).then(r => r.status)
    : await get(c.route, c.role);
  rows.push({ ...c, actual, pass: actual === c.expected });
}

const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + [
  `| ${"Route".padEnd(32)} | ${"Role".padEnd(10)} | ${"Expected".padEnd(8)} | ${"Actual".padEnd(8)} | Result |`,
  `| ${"-".repeat(32)} | ${"-".repeat(10)} | ${"-".repeat(8)} | ${"-".repeat(8)} | ------ |`,
  ...rows.map(r => `| ${pad(r.route,32)} | ${pad(r.role,10)} | ${pad(r.expected,8)} | ${pad(r.actual,8)} | ${r.pass?"PASS":"FAIL"} |`),
].join("\n") + "\n");

// Cross-org: only 1 org available
console.log("Cross-org: only 1 org configured in .env.live — skipped.");

const passed = rows.filter(r => r.pass).length;
console.log(`${passed}/${rows.length} isolation checks passed.`);
process.exit(passed === rows.length ? 0 : 1);
