/**
 * Performance sanity — p50/p95 for 7 GET endpoints, 20 warm runs each.
 * Usage: node server/scripts/measure/live-perf.mjs
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

const h = (role) => ({ authorization: `Bearer ${tokens[role]}` });

const actions = [
  { name: "GET /api/me (Director)",          url: `${BASE}/api/me`,                     headers: h("DIRECTOR") },
  { name: "GET /api/workspace/tasks (Dev)",  url: `${BASE}/api/workspace/tasks`,        headers: h("SENDEV") },
  { name: "GET /api/approvals (Director)",   url: `${BASE}/api/approvals`,              headers: h("DIRECTOR") },
  { name: "GET /api/manager/team (Mgr)",     url: `${BASE}/api/manager/team`,           headers: h("MANAGER") },
  { name: "GET /api/leaderboard",            url: `${BASE}/api/leaderboard`,            headers: h("SENDEV") },
  { name: "GET /api/notifications",          url: `${BASE}/api/notifications`,          headers: h("SENDEV") },
  { name: "GET /api/director/settings",      url: `${BASE}/api/director/settings`,      headers: h("DIRECTOR") },
];

const pct = (arr, p) => { const s = [...arr].sort((a,b)=>a-b); return s[Math.ceil(s.length * p / 100) - 1]; };

const rows = [];
for (const action of actions) {
  if (!action.headers.authorization || action.headers.authorization === "Bearer undefined") {
    rows.push({ name: action.name, p50: "SKIP", p95: "SKIP", pass: false }); continue;
  }
  // 2 warm-up, 20 measured
  for (let i = 0; i < 2; i++) await fetch(action.url, { headers: action.headers });
  const times = [];
  for (let i = 0; i < 20; i++) {
    const t = Date.now();
    await fetch(action.url, { headers: action.headers });
    times.push(Date.now() - t);
  }
  const p50 = pct(times, 50), p95 = pct(times, 95);
  rows.push({ name: action.name, p50, p95, pass: p95 < 2000 });
}

const pad = (s, n) => String(s).padEnd(n);
console.log("\n" + [
  `| ${"Action".padEnd(36)} | ${"p50 ms".padEnd(8)} | ${"p95 ms".padEnd(8)} | Result |`,
  `| ${"-".repeat(36)} | ${"-".repeat(8)} | ${"-".repeat(8)} | ------ |`,
  ...rows.map(r => `| ${pad(r.name,36)} | ${pad(r.p50,8)} | ${pad(r.p95,8)} | ${r.pass?"PASS":"FAIL"} |`),
].join("\n") + "\n");

const passed = rows.filter(r => r.pass).length;
console.log(`${passed}/${rows.length} perf checks passed (p95 < 2000ms threshold).`);
process.exit(passed === rows.length ? 0 : 1);
