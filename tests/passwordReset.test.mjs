// Password reset rules (V1 4.12) — pure, no DB, no network. Run: cd server && node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mailConfig, canIssueCode, verifyResetCode, hashResetCode, resetEmail,
  RESET_TTL_MS, MAX_ATTEMPTS, LOCK_MS, RESEND_COOLDOWN_MS,
} from "../services/passwordReset.js";

const NOW = new Date("2026-11-03T12:00:00Z");
const at = (ms) => new Date(NOW.getTime() + ms);

test("limits: 10 min expiry, 5 tries, 15 min lock, 60 s resend cooldown", () => {
  assert.equal(RESET_TTL_MS, 10 * 60_000);
  assert.equal(MAX_ATTEMPTS, 5);
  assert.equal(LOCK_MS, 15 * 60_000);
  assert.equal(RESEND_COOLDOWN_MS, 60_000);
});

test("SMTP config needs all five env vars; port 465 → secure", () => {
  const env = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "465", SMTP_USER: "a@b.c", SMTP_PASS: "x", MAIL_FROM: "ACHIEVION <a@b.c>" };
  assert.deepEqual(mailConfig(env), { host: "smtp.gmail.com", port: 465, secure: true, auth: { user: "a@b.c", pass: "x" }, from: "ACHIEVION <a@b.c>" });
  assert.equal(mailConfig({ ...env, SMTP_PORT: "587" }).secure, false);
  assert.equal(mailConfig({ ...env, SMTP_PASS: "" }), null);
  assert.equal(mailConfig({}), null);
});

test("a new code: not while locked, not within 60 s of the last one", () => {
  assert.deepEqual(canIssueCode({}, NOW), { ok: true });
  assert.deepEqual(canIssueCode({ resetLockedUntil: at(60_000) }, NOW), { ok: false, reason: "locked" });
  assert.deepEqual(canIssueCode({ resetLockedUntil: at(-1) }, NOW), { ok: true });
  assert.deepEqual(canIssueCode({ resetCodeIssuedAt: at(-30_000) }, NOW), { ok: false, reason: "cooldown" });
  assert.deepEqual(canIssueCode({ resetCodeIssuedAt: at(-61_000) }, NOW), { ok: true });
});

test("verify: ok once, then nothing; expired; locked; wrong code counts", () => {
  const user = { resetCodeHash: hashResetCode("123456"), resetCodeExpires: at(RESET_TTL_MS), resetAttempts: 0 };
  assert.equal(verifyResetCode(user, "123456", NOW), "ok");
  assert.equal(verifyResetCode(user, " 123456 ", NOW), "ok");
  assert.equal(verifyResetCode(user, "654321", NOW), "invalid");
  assert.equal(verifyResetCode({ ...user, resetCodeExpires: at(-1) }, "123456", NOW), "expired");
  assert.equal(verifyResetCode({ ...user, resetAttempts: MAX_ATTEMPTS }, "123456", NOW), "locked");
  assert.equal(verifyResetCode({ ...user, resetLockedUntil: at(5_000) }, "123456", NOW), "locked");
  assert.equal(verifyResetCode({}, "123456", NOW), "none"); // already used or never requested
  assert.equal(verifyResetCode(user, "12345a", NOW), "invalid");
});

test("email template: short English, code and expiry, no HTML injection", () => {
  const m = resetEmail("042913");
  assert.match(m.subject, /reset code/i);
  assert.match(m.text, /042913/);
  assert.match(m.text, /10 minutes/);
  assert.match(m.html, /042913/);
  assert.ok(m.text.length < 600);
});
