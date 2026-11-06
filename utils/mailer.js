// Outgoing mail (V1 4.12, D-073). SMTP comes only from env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
// No config → MailNotConfiguredError (the API answers 503); the server never crashes over mail.
import nodemailer from "nodemailer";
import { mailConfig, resetEmail } from "../services/passwordReset.js";

export class MailNotConfiguredError extends Error {
  constructor() { super("Email service is not configured"); this.status = 503; }
}

export const isMailConfigured = () => mailConfig() !== null;

let cached = null; // { key, transport } — rebuilt if the env changes
function transport() {
  const cfg = mailConfig();
  if (!cfg) throw new MailNotConfiguredError();
  const key = `${cfg.host}:${cfg.port}:${cfg.auth.user}`;
  if (cached?.key !== key) {
    cached = {
      key,
      from: cfg.from,
      transport: nodemailer.createTransport({
        host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth,
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
      }),
    };
  }
  return cached;
}

export async function sendResetCode(email, code) {
  const { transport: tx, from } = transport();
  const msg = resetEmail(code);
  await tx.sendMail({ from, to: email, subject: msg.subject, text: msg.text, html: msg.html });
}
