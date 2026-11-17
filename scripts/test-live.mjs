// Runs the server tests against the ONE live database ("test") with the TEST-7843 accounts (item 6, QA2 runbook).
//   API_URL=http://localhost:5062 node scripts/test-live.mjs [test files...]
// The tests read their logins from .env.test, which still holds the old achievion_dev accounts. Here the TEST-7843 accounts
// (T7843_* in .env.test) are exported under the role names the tests use, so the files' own loader (which never overwrites an
// existing variable) picks them. Nothing is written and no secret is printed. Start the API first with DISABLE_JOBS=1 DISABLE_EMAIL=1 (the mail tests build their own sender, so DISABLE_EMAIL is not set here).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = {};
for (const l of fs.readFileSync(path.join(root, ".env.test"), "utf8").split("\n")) { const i = l.indexOf("="); if (i > 0 && !l.startsWith("#")) env[l.slice(0, i)] = l.slice(i + 1); }
// role key used by the tests <- TEST-7843 account
const MAP = { ORG_ADMIN: "T7843_ORG_ADMIN", DIRECTOR: "T7843_DIRECTOR", MANAGER: "T7843_MANAGER", TEAMLEAD: "T7843_TEAMLEAD",
  DEVELOPER_1: "T7843_JUNIOR_DEV", DEVELOPER_2: "T7843_SENIOR_DEV", DESIGNER: "T7843_JUNIOR_DESIGNER", TESTER: "T7843_SENIOR_TESTER" };
const out = { ...process.env, LIVE_TEST_ENV: "1", DISABLE_JOBS: "1", TEST_DB: process.env.TEST_DB ?? "test", API_URL: process.env.API_URL ?? "http://localhost:5062" };
let missing = [];
for (const [role, src] of Object.entries(MAP)) for (const f of ["EMAIL", "PASSWORD"]) { const v = env[`${src}_${f}`]; if (v) out[`${role}_${f}`] = v; else missing.push(`${src}_${f}`); }
if (env.T7843_ORG_CODE) out.ORG_CODE = env.T7843_ORG_CODE; else missing.push("T7843_ORG_CODE");
if (missing.length) console.log(`Skipped mapping (not in .env.test): ${missing.join(", ")}`);
// Pre-flight (item 6): a test that needs a login or fixture this database does not have is SKIPPED with a clear line, not failed.
// Each login is tried once. The API must be running (API_URL).
const api = out.API_URL;
const post = (p, body) => fetch(api + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status).catch(() => 0);
const dir = path.join(root, "server/tests");
const all = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs"));
const text = new Map(all.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
const needs = [
  ["the org-admin login", async () => (await post("/api/org/login", { email: out.ORG_ADMIN_EMAIL, password: out.ORG_ADMIN_PASSWORD })) === 200, (t) => /ORG_ADMIN|org\/login/.test(t)],
  ["the second organisation (AUDIT_ORG3)", async () => !!env.AUDIT_ORG3_CODE && (await post("/api/auth/login", { email: env.AUDIT_ORG3_EMAIL, password: env.AUDIT_ORG3_PASSWORD, orgCode: env.AUDIT_ORG3_CODE })) === 200, (t) => /AUDIT_ORG3/.test(t)],
  ...["DIRECTOR", "MANAGER", "TEAMLEAD", "DEVELOPER_1", "DEVELOPER_2", "DESIGNER", "TESTER"].map((k) => [`the ${k} login`, async () => (await post("/api/auth/login", { email: out[`${k}_EMAIL`], password: out[`${k}_PASSWORD`], orgCode: out.ORG_CODE })) === 200, (t) => new RegExp(`["\\x60]${k}["\\x60]`).test(t)]),
];
const skip = new Map();
for (const [label, probe, uses] of needs) {
  if (await probe()) continue;
  for (const f of all) if (uses(text.get(f))) skip.set(f, skip.get(f) ?? label);
}
for (const [f, why] of skip) console.log(`SKIPPED ${f}: needs ${why}, which this database does not have`);
const files = process.argv.slice(2);
const run = files.length ? files : all.filter((f) => !skip.has(f)).map((f) => path.join("tests", f));
const args = ["--import", "./tests/helpers/liveEnv.mjs", "--test", "--test-concurrency=1", ...run];
spawn(process.execPath, args, { cwd: path.join(root, "server"), env: out, stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 1));
