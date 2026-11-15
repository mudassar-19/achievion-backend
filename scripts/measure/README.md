# Live measurement scripts

Credentials from `.env.live` (gitignored). `LIVE_BACKEND_URL` required.

| Script | Purpose | Run |
|---|---|---|
| live-smoke.mjs | 4-check live backend health | `node server/scripts/measure/live-smoke.mjs` |
| live-role-login.mjs | 10-role login check; writes `/tmp/live-tokens.json` | `node server/scripts/measure/live-role-login.mjs` |
| live-isolation.mjs | RBAC isolation check (requires live-role-login first) | `node server/scripts/measure/live-isolation.mjs` |
| live-security.mjs | Security fixes live proof (requires live-role-login first) | `node server/scripts/measure/live-security.mjs` |
| live-perf.mjs | p50/p95 latency for 7 GET endpoints (requires live-role-login first) | `node server/scripts/measure/live-perf.mjs` |
