/**
 * Live smoke test — 4 checks against the deployed backend.
 * Usage: node server/scripts/measure/live-smoke.mjs
 *
 * Reads credentials from .env.live (live DB accounts) then .env.test.
 * Backend URL: LIVE_BACKEND_URL env var, or in .env.live.
 * Example: node server/scripts/measure/live-smoke.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Load .env.live first (live credentials take precedence), then .env.test as fallback
for (const f of [".env.live", ".env.test"]) {
  const fp = path.join(root, f);
  if (!existsSync(fp)) continue;
  for (const l of readFileSync(fp, "utf8").split("\n")) {
    const i = l.indexOf("="); if (i > 0 && !l.startsWith("#") && !process.env[l.slice(0, i)]) process.env[l.slice(0, i)] = l.slice(i + 1).trim();
  }
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

// (b) Login — Director (for approvals check)
{
  const email = process.env.LIVE_DIRECTOR_EMAIL ?? process.env.DIRECTOR_EMAIL;
  const password = process.env.LIVE_DIRECTOR_PASSWORD ?? process.env.DIRECTOR_PASSWORD ?? process.env.RESET_TEST_PASSWORD;
  const orgCode = process.env.LIVE_ORG_CODE ?? process.env.ORG_CODE;
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

// (d) Fake .pdf upload → exactly 400 with app error message (FIX-4 D-430 magic-bytes check).
// Uses SENTES (tester) token: POST /api/quality/bugs has uploadFiles BEFORE task lookup.
// (workspace routes use router.param scope guard that runs before uploadFiles — wrong endpoint)
{
  const sentesEmail = process.env.LIVE_SENTES_EMAIL;
  const sentesPw = process.env.LIVE_SENTES_PASSWORD;
  const orgCode = process.env.LIVE_ORG_CODE ?? process.env.ORG_CODE;
  let sentesToken = null;
  if (sentesEmail && sentesPw) {
    const lr = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: sentesEmail, password: sentesPw, orgCode }),
    });
    if (lr.ok) sentesToken = (await lr.json()).token;
  }
  if (!sentesToken) {
    row("fake .pdf upload (magic-bytes → app 400)", "400 + error msg", "SKIP: no SENTES creds", false);
  } else {
    const form = new FormData();
    form.append("files", new Blob(["this is not a pdf"], { type: "application/pdf" }), "test.pdf");
    const r = await fetch(`${BASE}/api/quality/bugs`, {
      method: "POST",
      headers: { authorization: `Bearer ${sentesToken}` },
      body: form,
    });
    const body = r.status < 500 ? await r.json().catch(() => ({})) : {};
    const hasMsg = typeof body?.error === "string" && body.error.length > 0;
    const pass = r.status === 400 && hasMsg;
    row("fake .pdf upload (magic-bytes → app 400)", "400 + error msg", `${r.status}${hasMsg ? ` "${body.error?.slice(0, 40)}"` : ""}`, pass);
  }
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
