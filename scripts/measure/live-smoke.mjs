/**
 * Live smoke test — 4 checks against the deployed backend.
 * Usage: node server/scripts/measure/live-smoke.mjs
 *
 * Reads credentials from .env.test (never printed/committed).
 * Backend URL: LIVE_BACKEND_URL env var, or add it to .env.test.
 * Example: LIVE_BACKEND_URL=https://achievion-backend.onrender.com node ...
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
for (const l of readFileSync(path.join(root, ".env.test"), "utf8").split("\n")) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1).trim();
}

const BASE = process.env.LIVE_BACKEND_URL?.replace(/\/$/, "");
if (!BASE) {
  console.error("Error: set LIVE_BACKEND_URL=https://<your-render-address> (or add to .env.test)");
  process.exit(1);
}

const results = [];
let token = null;

const row = (check, expected, actual, pass) => results.push({ check, expected, actual, pass });

// (a) Health
{
  const r = await fetch(`${BASE}/api/health`);
  row("health GET /api/health", "200", String(r.status), r.status === 200);
}

// (b) Login
{
  const email = process.env.DIRECTOR_EMAIL;
  const password = process.env.DIRECTOR_PASSWORD ?? process.env.RESET_TEST_PASSWORD;
  const orgCode = process.env.ORG_CODE;
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, orgCode }),
  });
  token = r.ok ? (await r.json()).token : null;
  row("login POST /api/auth/login", "200", String(r.status), r.status === 200);
}

// (c) GET /api/approvals — no hash leak
{
  if (!token) {
    row("approvals GET /api/approvals", "no hash", "SKIPPED (no token)", false);
  } else {
    const r = await fetch(`${BASE}/api/approvals`, { headers: { authorization: `Bearer ${token}` } });
    const body = await r.text();
    const leaked = ["$2a$", "$2b$", "passwordHash"].some((s) => body.includes(s));
    row("approvals GET /api/approvals", "no hash leak", leaked ? "HASH FOUND" : "clean", !leaked);
  }
}

// (d) Fake .pdf upload → 400
// Uses POST /api/quality/bugs (Tester-accessible) so auth passes and magic-bytes check fires.
// Login as Tester for this check.
{
  const tEmail = process.env.TESTER_EMAIL;
  const tPass  = process.env.TESTER_PASSWORD ?? process.env.RESET_TEST_PASSWORD;
  const orgCode = process.env.ORG_CODE;
  let tToken = null;
  try {
    const lr = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: tEmail, password: tPass, orgCode }),
    });
    tToken = lr.ok ? (await lr.json()).token : null;
  } catch { /* skip */ }

  const form = new FormData();
  form.append("files", new Blob(["this is not a pdf"], { type: "application/pdf" }), "test.pdf");
  const r = await fetch(`${BASE}/api/quality/bugs`, {
    method: "POST",
    headers: tToken ? { authorization: `Bearer ${tToken}` } : {},
    body: form,
  });
  row("fake .pdf upload POST /api/quality/bugs", "400", String(r.status), r.status === 400);
}

// Print table
const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + [
  `| ${"Check".padEnd(40)} | ${"Expected".padEnd(16)} | ${"Actual".padEnd(16)} | Result |`,
  `| ${"-".repeat(40)} | ${"-".repeat(16)} | ${"-".repeat(16)} | ------ |`,
  ...results.map((r) => `| ${pad(r.check, 40)} | ${pad(r.expected, 16)} | ${pad(r.actual, 16)} | ${r.pass ? "PASS" : "FAIL"} |`),
].join("\n") + "\n");

const allPass = results.every((r) => r.pass);
console.log(allPass ? "All checks PASS." : `${results.filter((r) => !r.pass).length} check(s) FAILED.`);
process.exit(allPass ? 0 : 1);
