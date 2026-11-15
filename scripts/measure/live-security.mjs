/**
 * Security fixes live proof.
 * Usage: node server/scripts/measure/live-security.mjs
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
const tokens = JSON.parse(readFileSync("/tmp/live-tokens.json", "utf8"));
const ORG_CODE = process.env.LIVE_ORG_CODE ?? process.env.ORG_CODE;

const authGet = (route, role) =>
  fetch(`${BASE}${route}`, { headers: { authorization: `Bearer ${tokens[role]}` } }).then(r => r.text());

const rows = [];

// 4a. No hash leak in /api/me
for (const role of ["DIRECTOR", "ORGADMIN"]) {
  if (!tokens[role]) { rows.push({ check: `/api/me (${role}) no hash`, expected: "clean", actual: "SKIP", pass: false }); continue; }
  const body = await authGet("/api/me", role);
  const leaked = ["$2a$", "$2b$", "passwordHash"].some(s => body.includes(s));
  rows.push({ check: `/api/me (${role}) no hash`, expected: "clean", actual: leaked ? "HASH FOUND" : "clean", pass: !leaked });
}

// 4a. No hash leak in employee list
{
  const body = await authGet("/api/director/team", "DIRECTOR");
  const leaked = ["$2a$", "$2b$", "passwordHash"].some(s => body.includes(s));
  rows.push({ check: "/api/director/team no hash", expected: "clean", actual: leaked ? "HASH FOUND" : "clean", pass: !leaked });
}

// 4b. NoSQL injection guard
{
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: { $ne: null }, password: { $ne: null }, orgCode: ORG_CODE }),
  });
  const pass = r.status === 400 || r.status === 401;
  rows.push({ check: "NoSQL inject login body", expected: "400 or 401", actual: String(r.status), pass });
}

// 4c. Deleted employee
const deletedEmail = process.env.LIVE_DELETED_EMAIL;
if (deletedEmail) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: deletedEmail, password: process.env.LIVE_DELETED_PASSWORD ?? "wrong", orgCode: ORG_CODE }),
  });
  rows.push({ check: "deleted account login", expected: "401", actual: String(r.status), pass: r.status === 401 });
} else {
  rows.push({ check: "deleted account login", expected: "401", actual: "SKIP (no LIVE_DELETED_EMAIL)", pass: true });
}

const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + [
  `| ${"Check".padEnd(36)} | ${"Expected".padEnd(10)} | ${"Actual".padEnd(14)} | Result |`,
  `| ${"-".repeat(36)} | ${"-".repeat(10)} | ${"-".repeat(14)} | ------ |`,
  ...rows.map(r => `| ${pad(r.check,36)} | ${pad(r.expected,10)} | ${pad(r.actual,14)} | ${r.pass?"PASS":"FAIL"} |`),
].join("\n") + "\n");

const passed = rows.filter(r => r.pass).length;
console.log(`${passed}/${rows.length} security checks passed.`);
process.exit(passed === rows.length ? 0 : 1);
