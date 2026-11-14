// The gate every Employee AI call goes through (Batch 4). No DB or network in this file: the controller passes
// { configured(), usedToday(user), call({ feature, promptId, data, check, orgId, requestedBy }) → text }, the tests pass fakes.
// Order: AI configured (503) → daily limit (429) → call with a time limit → check the answer → fallback words or 503.
// A provider error never reaches the caller as text (it can hold a key name or a prompt).
import { parseJsonLoose } from "./aiEvalRules.js";
import { usageState } from "./managerAiRules.js";
import { DAILY_LIMIT } from "./employeeAiRules.js";

const MAX_PARALLEL = 3;
export const AI_OFF = { error: "AI is not configured on this server. Everything else works as usual.", code: "ai_off" };
const BUSY = "AI is busy or unavailable right now. Try again shortly.";
const timeLimit = (promise, ms) => { let t; return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]).finally(() => clearTimeout(t)); };

export function makeEmployeeAi({ configured, usedToday, call, limit = DAILY_LIMIT, timeoutMs = 25_000 }) {
  // At most 3 AI calls per person at the same time (the AI tab asks for tips, a summary and a leaderboard line together): the daily
  // count is written after the call, so unlimited parallel calls would all see "0 used". The limit can be passed by at most 2.
  // ponytail: per server process (one process today); a counter document if the server ever runs as several processes.
  const running = new Map();
  async function usage(user) { return usageState(await usedToday(user), limit); }
  async function ask({ user, feature, promptId, data, check, fallback }) {
    if (!configured()) return { status: 503, body: AI_OFF };
    let u;
    try { u = await usage(user); } catch { return { status: 503, body: { error: BUSY, code: "busy" } }; }
    if (!u.remaining) return { status: 429, body: { error: `You have used today's ${u.limit} AI requests. They reset at midnight.`, code: "limit", usage: u } };
    const after = { ...u, used: u.used + 1, remaining: u.remaining - 1 };
    const who = String(user.id);
    if ((running.get(who) ?? 0) >= MAX_PARALLEL) return { status: 429, body: { error: "Too many AI questions at once. Wait for an answer, then ask again.", code: "too_many_at_once", usage: u } };
    running.set(who, (running.get(who) ?? 0) + 1);
    try {
      const v = check(parseJsonLoose(await timeLimit(call({ feature, promptId, data, check, orgId: user.orgId, requestedBy: user.id }), timeoutMs)));
      if (!v.ok) throw new Error("invalid");
      return { status: 200, body: { value: v.value, usage: after, aiGenerated: true } };
    } catch {
      if (fallback) return { status: 200, body: { value: fallback(), usage: after, aiGenerated: false, fallback: true, note: "AI is busy right now, so this comes from your numbers." } };
      return { status: 503, body: { error: BUSY, code: "busy", usage: after } };
    } finally { const n = (running.get(who) ?? 1) - 1; if (n > 0) running.set(who, n); else running.delete(who); }
  }
  return { ask, usage, configured };
}
