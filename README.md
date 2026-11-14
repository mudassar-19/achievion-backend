# Achievion — server

Express 5 REST API with Mongoose 9 + node:test test suite.

## Setup

```bash
cp .env.example .env   # fill in MONGO_URI, JWT_SECRET, CLIENT_ORIGIN
npm install
npm run dev            # nodemon; default port 3001
npm start              # production (no reload)
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGO_URI` | yes | MongoDB connection string (Atlas or local) |
| `PORT` | no | API port; default `3001` |
| `CLIENT_ORIGIN` | yes | CORS allowed origin, e.g. `http://localhost:5173` |
| `JWT_SECRET` | yes | 32+ char secret for signing JWTs |
| `JWT_EXPIRES_IN` | no | Token lifetime; default `7d` |
| `MAIL_PROVIDER` | no | `smtp` (default, local development) or `brevo-api` (production on Render free, HTTPS) |
| `BREVO_API_KEY` | with `brevo-api` | Brevo API key (never commit) |
| `MAIL_FROM` | with e-mail | sender; with `brevo-api` it must be a sender verified in Brevo |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | with `smtp` | local development only (Render free blocks SMTP) |
| `GROQ_API_KEY` | no | Groq LLM for AI features |
| `OPENROUTER_API_KEY` | no | OpenRouter fallback |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | nodemon with `--experimental-vm-modules` |
| `npm start` | `node server.js` |
| `npm run test:smoke` | Run the full HTTP test suite against the smoke server on `:5057` |

## Folder map

```
server/
├── server.js          Entry point; mounts all routers
├── models/            Mongoose schemas
├── routes/            Express routers by feature
├── controllers/       Route handlers
├── services/          Business logic (gamification, shop, AI chain …)
├── middleware/        Auth, rate-limit, role guards
├── scripts/           One-off admin scripts
└── tests/             node:test suites (*.test.mjs, *.mjs)
```

## Running tests

The HTTP test suite **must run against a server started with `NO_CLOUDINARY=1`**. Without this flag the server tries to upload files to Cloudinary and many tests will fail.

### Smoke server (port 5057)

The smoke server uses `server/scripts/start-smoke.mjs` which:
- reads `server/.env` and rewrites `MONGO_URI` to target the `achievion_dev` database
- sets `PORT` from `LAUNCH_PORT` (not `PORT` — `server.js` reads `PORT` from `.env`)
- clears Cloudinary env when `NO_CLOUDINARY=1`

```bash
# Start the smoke server (from repo root)
LAUNCH_PORT=5057 NO_CLOUDINARY=1 node server/scripts/start-smoke.mjs
sleep 8

# Run the full HTTP suite (from server/)
cd server && npm run test:smoke

# Or run a single file
API_URL=http://localhost:5057 node --test server/tests/b5Api.test.mjs
```

```bash
# Unit/integration tests (no server needed)
node --test server/tests/xpEngine.test.mjs
node --test server/tests/badgeEngine.test.mjs
node --test server/tests/shopLedger.test.mjs
node --test server/tests/streakFreezeIntegration.test.mjs
```

Full suite: 51+ test files, ~600 assertions.

## Auth

JWT Bearer tokens. `authMiddleware.js` validates signature, expiry, and `tokenVersion` (invalidates old tokens on password change or Director reset).

## Role guards

`requireRole(...roles)` middleware; Director > Manager > Team Lead > Developer = Designer = Tester.

## Rate limiting

`express-rate-limit` — 20 login attempts per IP per 15 min (in-memory; resets on restart).

## Deploy on Render

Full step-by-step guide: `docs/deploy/RUNBOOK.md` (in the main repo).

1. New **Web Service**, branch `main`, runtime Node. Build `npm ci`, start `npm start`. Health check path `/api/health` (no login; returns the DB state).
2. Environment variables: see `.env.example`. At least `MONGO_URI`, `JWT_SECRET`, `SURVEY_HMAC_SECRET`, `CLIENT_URL` (the Vercel address), `NODE_ENV=production`, `TRUST_PROXY=1`, and the three `CLOUDINARY_*` values (without them uploads answer 503 in production). Render sets `PORT`; the server listens on `0.0.0.0:$PORT`.
3. Render's disk is wiped on every deploy: files live on Cloudinary, not on disk.
4. E-mail: `MAIL_PROVIDER=brevo-api`, `BREVO_API_KEY`, `MAIL_FROM` (Brevo steps in the runbook); SMTP does not work on Render free.
5. MongoDB Atlas: allow Render's outbound IPs (or `0.0.0.0/0`) under Network Access.
