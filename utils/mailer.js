// Outgoing mail for password reset (V1 4.12, D-073) and offline e-mail (D-296). ONE sender, provider chosen by env MAIL_PROVIDER (D-340):
//   smtp       (default; local development and tests) SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
//   brevo-api  (Render free blocks SMTP ports) HTTPS POST to Brevo's transactional API: BREVO_API_KEY, MAIL_FROM = a verified sender
// No (or incomplete) config → MailNotConfiguredError (503 for the API, silence for offline e-mail); the server never crashes over mail.
// Failures throw a short error with status 502 and NO key, recipient, code or provider text in the message.
import nodemailer from "nodemailer";
import { mailConfig, resetEmail } from "../services/passwordReset.js";

export class MailNotConfiguredError extends Error {
  constructor() { super("Email service is not configured"); this.status = 503; }
}

// "ACHIEVION <noreply@example.org>" or "noreply@example.org" → { email, name? }; anything else → null.
export function parseFrom(s) {
  const t = String(s ?? "").trim();
  const m = /^"?([^"<>]*?)"?\s*<([^<>\s@]+@[^<>\s@]+)>$/.exec(t);
  if (m) return { email: m[2], ...(m[1].trim() && { name: m[1].trim() }) };
  return /^[^\s<>@]+@[^\s<>@]+$/.test(t) ? { email: t } : null;
}

// ponytail: BREVO_API_BASE and MAIL_TIMEOUT_MS exist for the tests' fake server; production leaves them unset (api.brevo.com, 10 s).
export function providerConfig(env = process.env) {
  const provider = String(env.MAIL_PROVIDER || "smtp").trim().toLowerCase();
  if (provider === "smtp") { const smtp = mailConfig(env); return smtp ? { provider, smtp } : null; }
  if (provider === "brevo-api") {
    const key = String(env.BREVO_API_KEY ?? "").trim(), from = parseFrom(env.MAIL_FROM);
    if (!key || !from) return null;
    return { provider, key, from, base: String(env.BREVO_API_BASE || "https://api.brevo.com").replace(/\/+$/, ""), timeoutMs: Number(env.MAIL_TIMEOUT_MS) || 10_000 };
  }
  return null; // an unknown value is never guessed
}
export const isMailConfigured = (env = process.env) => providerConfig(env) !== null;

const mailError = (why) => Object.assign(new Error(`Mail provider: ${why}`), { status: 502 });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let cached = null; // { key, transport } — rebuilt if the env changes
function smtpTransport(cfg) {
  const key = `${cfg.host}:${cfg.port}:${cfg.auth.user}`;
  if (cached?.key !== key) {
    cached = { key, transport: nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000 }) };
  }
  return cached.transport;
}

async function sendBrevo(cfg, { to, subject, text, html }) {
  let res;
  try {
    res = await fetch(`${cfg.base}/v3/smtp/email`, {
      method: "POST",
      headers: { "api-key": cfg.key, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ sender: cfg.from, to: [{ email: to }], subject, textContent: text, htmlContent: html ?? `<p>${esc(text)}</p>` }), // Brevo requires htmlContent
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) { throw mailError(e?.name === "TimeoutError" ? "timed out" : "unreachable"); }
  const body = await res.json().catch(() => null);
  if (res.status === 201 && (typeof body?.messageId === "string" || Array.isArray(body?.messageIds))) return;
  if (res.ok) throw mailError("unexpected answer");
  const code = typeof body?.code === "string" && /^[\w ]{1,40}$/.test(body.code) ? ` (${body.code})` : ""; // Brevo's error code only, never its free text
  throw mailError(`answered HTTP ${res.status}${code}`);
}

export async function sendMail({ to, subject, text, html }, env = process.env) {
  const cfg = providerConfig(env);
  if (!cfg) throw new MailNotConfiguredError();
  if (cfg.provider === "brevo-api") return sendBrevo(cfg, { to, subject, text, html });
  await smtpTransport(cfg.smtp).sendMail({ from: cfg.smtp.from, to, subject, text, html });
}

export async function sendResetCode(email, code) {
  const msg = resetEmail(code);
  await sendMail({ to: email, subject: msg.subject, text: msg.text, html: msg.html });
}
