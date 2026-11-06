# Achievion backend

REST API for Achievion, a gamified project management platform (Express 5 + Mongoose / MongoDB).

## Run

```bash
npm install
cp .env.example .env   # fill in the values
npm run dev            # or: npm start
```

Tests: `node --test tests/*.test.mjs`. Some tests import shared utils from the frontend repo
(`../client/src/utils/...`), so they need the frontend checked out next to this folder as `client/`.

## Environment variables

| Name | What |
|---|---|
| `MONGO_URI` | MongoDB connection string |
| `PORT` | API port (default 3001) |
| `CLIENT_ORIGIN` | Frontend origin allowed by CORS |
| `NODE_ENV` | `development` / `production` |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Login token signing and lifetime |
| `SURVEY_HMAC_SECRET` | Signs anonymous survey links |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Password-reset email |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | File storage (local `uploads/` when unset) |
| `AI_PROVIDER`, `AI_CHAIN` | AI provider selection |
| `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | AI provider keys (only the ones you use) |
