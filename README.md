# ResumeRound Backend

Backend for the AI resume-based interview simulator: one TypeScript codebase (Node.js 22,
Express 5, MongoDB) that runs as three processes.

| Process  | Entry point          | Responsibility                                                           |
| -------- | -------------------- | ------------------------------------------------------------------------ |
| `api`    | `src/apps/api.ts`    | REST API under `/api/v1`: auth, resumes, profiles, interviews, reports   |
| `worker` | `src/apps/worker.ts` | Background jobs from the MongoDB queue (resume parsing, reports)         |
| `bot`    | `src/apps/bot.ts`    | Live interview bot (registers + heartbeats today; Janus bridge in MVP-4) |

Project started 07/10/2026.

## Getting started

Prerequisites: Node.js >= 22.12 and access to the MongoDB Atlas cluster (your IP must be in
Atlas → Security → Network Access).

```bash
npm install
cp .env.example .env      # then set <db_password> in MONGODB_URI and JWT_ACCESS_SECRET
npm run dev               # API (http://localhost:4000/healthz) + job worker, with reload
```

**MongoDB connection string.** Use the SRV form from `.env.example` and always include the
database name (`/resumerounddev` locally, `/resumeroundprod` in production); without it the driver
uses a database called `test`:

```
mongodb+srv://resumeround_db_user:<db_password>@resumeroundcluster.wcpxfza.mongodb.net/<database>?retryWrites=true&w=majority&appName=ResumeRoundCluster
```

If you get `querySrv ECONNREFUSED`, your network's DNS is refusing SRV lookups: switch DNS to
`8.8.8.8` / `1.1.1.1`, or use the standard `mongodb://host1,host2,host3/...` string from Atlas →
Connect → Drivers (it lists the servers directly, but must be updated if Atlas changes them).

With `AI_PROVIDER=mock` and `STORAGE_DRIVER=local` (the defaults) nothing else is needed: resumes
are stored under `.storage/` and parsed by a keyword-based mock analyzer. Set
`AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` for real resume analysis, and `STORAGE_DRIVER=s3`
with the `S3_*` variables for object storage.

## Scripts

| Command                                      | What it does                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`                                | API + worker together, with reload                                                  |
| `npm run dev:api` / `dev:worker` / `dev:bot` | Run one process with reload (tsx watch)                                             |
| `npm test`                                   | Vitest unit + integration tests (in-memory MongoDB replica set; never reads `.env`) |
| `npm run typecheck`                          | `tsc --noEmit` over `src` and `test`                                                |
| `npm run lint` / `format`                    | ESLint / Prettier                                                                   |
| `npm run build`                              | Compile to `dist/`                                                                  |
| `npm run db:sync-indexes`                    | Create/update all MongoDB indexes (production boots with `autoIndex` off)           |

## Layout

```
src/
  apps/        api.ts  worker.ts  bot.ts        process entry points
  app.ts       Express app (middleware order below); routes.ts mounts every module
  common/      config (zod-validated env), db, logger, errors, storage (S3/local),
               middleware (request id, validate, rate limit, idempotency, errors), health
  modules/
    auth/        register, login, Google sign-in, rotating refresh tokens
    users/       GET/PATCH /me (onboarding: target role, level, company type)
    resumes/     upload (202) -> resume.parse job -> text extraction -> AI analysis
    profiles/    detected profile, user-editable before interviewing
    interviews/  REST + engine/ (planner, state machine, turn controller - pure, unit-tested)
    questions/   question bank + rubrics models, Atlas Vector Search retrieval
    evaluations/ rubric scoring maths
    reports/     report job: scores aggregated in code, narrative by the AI, skill history
    progress/    skill history across interviews
    ai/          AI gateway: providers (anthropic, mock), prompts, cost meter
    jobs/        MongoDB job queue + worker loop
    media/       Janus HTTP client, bot registry
test/
  unit/ integration/ helpers/
```

Each module follows `routes -> controller -> service -> repository/model`, with zod schemas in
`schemas.ts`. Controllers never touch the database; services never touch `req`/`res`.

**Middleware order:** helmet, CORS allow-list, compression, 100 KB JSON limit -> request id +
pino-http -> (per route) rate limit -> `authenticate` -> `validate(zod)` -> controller ->
central error handler, which always returns `{ error: { code, message, details, requestId } }`.

**API conventions:** `/api/v1`, plural nouns, cursor pagination (`?cursor=&limit=`), ISO-8601
UTC timestamps, `202 Accepted` + polling for slow work, optional `Idempotency-Key` header on
`POST /resumes` and `POST /interviews`.

## MongoDB instead of Redis

| Redis job            | Here                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| Sessions             | `refresh_sessions`, token hash rotated on every refresh, TTL on `expiresAt`                                  |
| Rate limiting        | `rate_limits`, fixed window via `$inc` + upsert, TTL cleanup                                                 |
| Job queue            | `jobs`, claimed with `findOneAndUpdate`, lock renewal, exponential backoff, dead-letter after 5 attempts     |
| Wake-ups / pub-sub   | Change stream on `jobs` inserts (falls back to polling)                                                      |
| Hot cache            | In-process `lru-cache` (rubrics, questions), 5 min TTL                                                       |
| Live interview state | In the owning bot's memory, checkpointed to `interviews.state` per turn with optimistic locking on `version` |

The `questions.embedding` vector index is created in Atlas, not by Mongoose; see
[docs/atlas-vector-search.md](docs/atlas-vector-search.md).

## AI gateway

All AI calls go through `src/modules/ai` (`getAiGateway()`); providers are chosen by
`AI_PROVIDER`. Model tiers are configurable: `AI_MODEL_SMALL` (`claude-haiku-4-5`, latency-critical
phrasing), `AI_MODEL_MID` (`claude-sonnet-5-5`, resume extraction and per-turn evaluation),
`AI_MODEL_LARGE` (`claude-opus-5-5`, final report). Resume analysis uses structured outputs
validated by zod, a byte-stable cached system prompt, resume text passed as delimited data, and
Anthropic's server-side refusal fallback. Every call records tokens and USD cost in `ai_usage`.

## Status against the release plan

Feature-by-feature detail, deviations and pending setup: [docs/STATUS.md](docs/STATUS.md).

| Milestone                 | State                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| MVP-1 Resume intelligence | Done: auth (email/password, Google, refresh rotation), onboarding, upload, parse job, editable profile                                    |
| MVP-2 Text interview      | Typed interview works end to end: `POST /interviews/:id/start` and `/answers` (AI question + scoring + controller); question bank pending |
| MVP-3 Evaluation report   | Report job, report API (ready / generating / insufficient answers / failed), skill history and progress trends done                       |
| MVP-4 Live call           | Janus HTTP client + bot registry/heartbeat done; `POST /interviews/:id/join`, RTP/WebRTC bridge, STT/TTS pending (501)                    |

## Deployment

Infrastructure decisions, costs and the cost-optimisation checklist: [docs/DEVOPS.md](docs/DEVOPS.md).

API, worker and bot run as plain Node.js processes under PM2 on a Linux VM (no Docker):

```bash
npm ci && npm run build && npm run db:sync-indexes
pm2 start ecosystem.config.cjs --env production && pm2 save
```

Behind a load balancer, `trust proxy` is set to 1 hop. If the frontend (Vercel) is on a
different site from the API, set `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true`.
