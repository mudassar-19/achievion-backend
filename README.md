# Achievion backend

REST API for Achievion, a gamified project management platform (Express 5 + Mongoose / MongoDB).

## Run

```bash
npm install
cp .env.example .env   # fill in the values
npm run dev            # or: npm start
```

Tests: `npm test`. Some tests import shared utils from the frontend repo
(`../client/src/utils/...`), so they need the frontend checked out next to this folder as `client/`.

## Environment variables

| Name | What |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `PORT` | API port (default 3001) |
| `CLIENT_URL` | Frontend origins allowed by CORS and Socket.IO, comma separated (e.g. `https://achievion.vercel.app`). Default `http://localhost:5173` |
| `CLIENT_ORIGIN` | Older single-origin name, used only when `CLIENT_URL` is empty |
| `NODE_ENV` | `development` / `production` |
| `TRUST_PROXY` | Number of proxies in front of the server; set `1` on Render so rate limits see the real client IP. Leave empty locally |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Login token signing and lifetime |
| `SURVEY_HMAC_SECRET` | Signs anonymous survey links |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Password-reset email |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | File storage (local `uploads/` when unset) |
| `AI_PROVIDER`, `AI_CHAIN` | AI provider selection |
| `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | AI provider keys (only the ones you use) |

## Deploy on Render

1. New **Web Service** from this repo, branch `main`, runtime Node.
2. Build command `npm ci`, start command `npm start`. Health check path `/api/health` (no login; returns the DB state).
3. Add the environment variables above (at least `MONGO_URI`, `JWT_SECRET`, `SURVEY_HMAC_SECRET`, `CLIENT_URL`, `NODE_ENV=production`, `TRUST_PROXY=1`). Render sets `PORT` itself; the server listens on `0.0.0.0:$PORT`.
4. Render's disk is wiped on every deploy: set the Cloudinary variables for submission files. Project / task attachments are still stored on local disk (see the notes in the deploy check).
5. In MongoDB Atlas, allow Render's outbound IPs (or `0.0.0.0/0`) under Network Access.
