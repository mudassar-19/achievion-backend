// Deploy readiness: allowed browser origins from env (CORS + Socket.IO), a health body without secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { allowedOrigins, healthBody } from "../config/deploy.js";

test("allowed origins: CLIENT_URL comma list, then CLIENT_ORIGIN, else the local Vite dev server", () => {
  assert.deepEqual(allowedOrigins({ CLIENT_URL: "https://a.vercel.app, https://b.com/ ,," }), ["https://a.vercel.app", "https://b.com"]);
  assert.deepEqual(allowedOrigins({ CLIENT_ORIGIN: "http://localhost:5174" }), ["http://localhost:5174"]);
  assert.deepEqual(allowedOrigins({}), ["http://localhost:5173"]);
  assert.deepEqual(allowedOrigins({ CLIENT_URL: " , " }), ["http://localhost:5173"]);
});

test("health body: ok, the database state by name, a time; nothing else", () => {
  const b = healthBody(1, new Date("2026-11-07T00:00:00Z"));
  assert.deepEqual(b, { status: "ok", db: "connected", timestamp: "2026-11-07T00:00:00.000Z" });
  assert.equal(healthBody(0).db, "disconnected");
  assert.equal(healthBody(2).db, "connecting");
  assert.equal(healthBody(99).db, "unknown");
});
