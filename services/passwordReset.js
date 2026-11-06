// Password reset rules (V1 4.12, D-073) — pure, no DB, no network.
// Tests: server/tests/passwordReset.test.mjs.
import crypto from "crypto";

export const RESET_TTL_MS       = 10 * 60_000; // code valid for 10 minutes
export const MAX_ATTEMPTS       = 5;           // wrong tries before the account's reset is locked
export const LOCK_MS            = 15 * 60_000; // lock length
export const RESEND_COOLDOWN_MS = 60_000;      // one new code per minute per account

export const hashResetCode = (code) => crypto.createHash("sha256").update(String(code).trim()).digest("hex");

// SMTP from env only (owner sets these in server/.env). Any missing → null = "not configured".
export function mailConfig(env = process.env) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = env;
  if (![SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM].every((v) => typeof v === "string" && v.trim())) return null;
  const port = Number(SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0) return null;
  return { host: SMTP_HOST.trim(), port, secure: port === 465, auth: { user: SMTP_USER.trim(), pass: SMTP_PASS }, from: MAIL_FROM.trim() };
}

export function canIssueCode(user, now = new Date()) {
  if (user?.resetLockedUntil && new Date(user.resetLockedUntil) > now) return { ok: false, reason: "locked" };
  if (user?.resetCodeIssuedAt && now - new Date(user.resetCodeIssuedAt) < RESEND_COOLDOWN_MS) return { ok: false, reason: "cooldown" };
  return { ok: true };
}

// "ok" | "invalid" (counts as a wrong try) | "expired" | "locked" | "none" (no live code: used or never sent)
export function verifyResetCode(user, code, now = new Date()) {
  if (user?.resetLockedUntil && new Date(user.resetLockedUntil) > now) return "locked";
  if (!user?.resetCodeHash || !user.resetCodeExpires) return "none";
  if ((user.resetAttempts ?? 0) >= MAX_ATTEMPTS) return "locked";
  if (new Date(user.resetCodeExpires) <= now) return "expired";
  const given = String(code ?? "").trim();
  if (!/^\d{6}$/.test(given)) return "invalid";
  const a = Buffer.from(hashResetCode(given), "hex"), b = Buffer.from(user.resetCodeHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? "ok" : "invalid";
}

export function resetEmail(code) {
  const c = String(code).replace(/\D/g, "").slice(0, 6); // digits only, so nothing can be injected into the HTML
  return {
    subject: "Your ACHIEVION password reset code",
    text: `Your ACHIEVION password reset code is ${c}.\n\nIt expires in 10 minutes and works once.\nIf you did not ask to reset your password, ignore this email; your password stays the same.`,
    html: `<p>Your ACHIEVION password reset code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${c}</p><p>It expires in 10 minutes and works once.</p><p style="color:#4F5B75">If you did not ask to reset your password, ignore this email; your password stays the same.</p>`,
  };
}
