# Backend Status: What Is Integrated and What Is Pending

Last updated: 08 Oct 2026. Measured against the PRD (_AI Resume-Based Interview Simulator_) and the
_Backend Base Document_.

**Legend:** ✅ Done (built and covered by tests) · 🟡 Partial (some parts built; the rest is listed) ·
⬜ Pending (not started) · 🔧 Code done, needs external setup or a real-service test.

## 1. Summary by milestone

| Milestone                          | State | In one line                                                                                   |
| ---------------------------------- | ----- | --------------------------------------------------------------------------------------------- |
| MVP-1 Resume intelligence (wk 1-3) | ✅    | Auth, onboarding, upload, parse job, editable profile all work end to end                     |
| MVP-2 Text interview (wk 4-6)      | 🟡    | Planner + turn controller + state machine done; question bank, evaluator, answer loop pending |
| MVP-3 Evaluation report (wk 7-8)   | 🟡    | Report storage and read API done; report generation job and skill-history writes pending      |
| MVP-4 Live call (wk 9-12)          | ⬜    | Only a Janus HTTP client and bot heartbeat exist; no Janus server, no audio                   |
| Phase 2 / Phase 3                  | ⬜    | Not started (by plan)                                                                         |

Verification today: 60 automated tests pass (unit + integration on an in-memory MongoDB replica
set); typecheck, lint and production build are clean. The API has booted against the Atlas
cluster once successfully.

## 2. Functional requirements

### FR-1 Account and onboarding: ✅ (Google: 🔧)

| Item                                                       | State | Notes                                                                                                                                       |
| ---------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Email/password register and login                          | ✅    | argon2id hashing; same error for unknown email and wrong password                                                                           |
| JWT access token (15 min) + httpOnly refresh cookie        | ✅    | Refresh token rotates on every use; replaying an old one revokes the session                                                                |
| Logout                                                     | ✅    |                                                                                                                                             |
| Google OAuth sign-in                                       | 🔧    | Code done (verifies Google ID token, links by verified email). Needs `GOOGLE_CLIENT_ID`; returns 503 until set. Not tested with real Google |
| Onboarding: target role, level, company type (`PATCH /me`) | ✅    | `onboarded` flag set once all three are filled                                                                                              |

### FR-2 Resume intelligence: ✅ (real AI and S3: 🔧)

| Item                                                                               | State | Notes                                                                                                                                                   |
| ---------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload PDF/DOCX, max 5 MB, multipart, 202 Accepted                                 | ✅    | File type checked by content (magic bytes), not extension                                                                                               |
| Object storage                                                                     | 🔧    | S3-compatible adapter written but never run against a real bucket; local disk storage used now                                                          |
| Background parsing job (`resume.parse`)                                            | ✅    | Retries with backoff; unreadable/scanned files fail with a user-facing message                                                                          |
| Text extraction (pdf-parse / mammoth)                                              | ✅    | PDF tested; DOCX path written, tested only via file-type detection                                                                                      |
| LLM structured extraction to candidate profile                                     | 🔧    | Claude provider written (structured JSON, prompt caching, injection-safe delimiters) but never called with a real key; tests use the keyword-based mock |
| Profile fields (skills buckets, projects, scale signals, years, seniority, domain) | ✅    |                                                                                                                                                         |
| Review and edit profile (`GET/PATCH /profiles/current`)                            | ✅    |                                                                                                                                                         |
| Status polling (`GET /resumes/:id`)                                                | ✅    | uploaded → parsing → ready / failed                                                                                                                     |
| Exit criterion: ≥ 90% extraction precision on 50 resumes                           | ⬜    | Needs the real AI provider and a sample set                                                                                                             |

### FR-3 Interview planner: ✅ (core) / ⬜ (extras)

| Item                                                        | State | Notes                                                                                      |
| ----------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------ |
| Ordered plan from profile + role + level + company type     | ✅    | Warm-up, core project deep dive, fundamentals, design/debugging (SDE-2+), behavioral close |
| Uses past skill scores (weak topics first)                  | ✅    | Reads `skill_history`, which nothing writes yet (see FR-8)                                 |
| Difficulty inside the level band, time budget per objective | ✅    |                                                                                            |
| Plan stored on the interview                                | ✅    |                                                                                            |
| Controller re-orders the plan mid-interview                 | ⬜    |                                                                                            |
| Trend weights                                               | ⬜    | Phase 3 (FR-11)                                                                            |

### FR-4 Live interview call: ⬜

| Item                                                                               | State | Notes                                                      |
| ---------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------- |
| Janus HTTP client (create/destroy AudioBridge room with secret + PIN)              | 🔧    | Written; never run against a Janus server                  |
| `/readyz` checks Janus reachability                                                | ✅    | Skipped while `JANUS_HTTP_URL` is empty                    |
| Bot process registers + heartbeats every 5 s                                       | ✅    | `bot_instances` collection; least-loaded selection written |
| `POST /interviews/:id/join` (room, bot assignment, join token, ICE servers)        | ⬜    | Returns 501                                                |
| Bot joins the room and receives/publishes audio (RTP forward vs Node WebRTC spike) | ⬜    |                                                            |
| Streaming STT / TTS, VAD and push-to-talk, barge-in                                | ⬜    | STT/TTS providers not chosen (PRD open question)           |
| Live captions and turn state over the data channel                                 | ⬜    |                                                            |
| Text fallback answers (`POST /interviews/:id/answers`)                             | ⬜    | Returns 501                                                |
| Reconnect within 60 s; bot failover from stale heartbeat                           | ⬜    | Data fields and indexes exist; logic not written           |

### FR-5 Adaptive interviewer: 🟡

| Item                                                                                                   | State | Notes                                                                 |
| ------------------------------------------------------------------------------------------------------ | ----- | --------------------------------------------------------------------- |
| Turn state machine (asking → listening → evaluating → deciding → …)                                    | ✅    | Illegal transitions throw                                             |
| Controller rules: max 3 follow-ups, ±2 difficulty in band, hints, time budgets, low-confidence clarify | ✅    | Pure TypeScript, no LLM, unit-tested                                  |
| Per-turn checkpoint with optimistic locking (`version`)                                                | ✅    | Repository method exists; nothing calls it yet                        |
| Question phrasing grounded in the candidate's projects (LLM, streamed)                                 | ⬜    |                                                                       |
| Answer evaluation against rubric (LLM, JSON)                                                           | ⬜    | Weighted rubric scoring maths is done                                 |
| Step-by-step scenario reveals                                                                          | 🟡    | Data model and controller move exist; no scenario content or flow yet |
| The actual turn loop that ties these together                                                          | ⬜    | The core of MVP-2                                                     |

### FR-6 Question bank: 🟡

| Item                                                                                                                       | State | Notes                                                                      |
| -------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------- |
| Question and rubric models (category, tech, difficulty, seniority, concepts, follow-ups, scenario stages, source metadata) | ✅    |                                                                            |
| Semantic retrieval query (Atlas `$vectorSearch` with pre-filters)                                                          | 🔧    | Written; needs the Atlas index and embeddings                              |
| Atlas Vector Search index                                                                                                  | ⬜    | Must be created in Atlas: [atlas-vector-search.md](atlas-vector-search.md) |
| `embed()` in the AI gateway + embedding job                                                                                | ⬜    | Embedding provider not chosen                                              |
| Seed of ~300 questions and rubrics                                                                                         | ⬜    |                                                                            |
| Admin CRUD (`/questions`)                                                                                                  | ⬜    | `admin` user role and `requireRole` middleware exist                       |

### FR-7 Evaluation and report: 🟡

| Item                                                                                       | State | Notes                                      |
| ------------------------------------------------------------------------------------------ | ----- | ------------------------------------------ |
| Report model (dimension scores, overall, strengths, weaknesses, feedback, recommendations) | ✅    |                                            |
| `GET /interviews/:id/report` (409 not ended / 202 generating / 200 ready)                  | ✅    |                                            |
| Ending an interview queues the report job atomically                                       | ✅    | Idempotent                                 |
| `report.generate` job (aggregate turns, LLM report, write skill history)                   | ⬜    | Job fails immediately as "not implemented" |
| Turn transcript endpoint (`GET /interviews/:id/turns`)                                     | ✅    | Empty until turns exist                    |
| Audio recording (opt-in)                                                                   | ⬜    | Storage key field exists                   |

### FR-8 Interview memory: 🟡

| Item                                         | State | Notes                          |
| -------------------------------------------- | ----- | ------------------------------ |
| `skill_history` collection                   | ✅    |                                |
| Progress endpoint (`GET /users/me/progress`) | ✅    | Returns per-skill trend points |
| Planner weights weak/mastered topics         | ✅    |                                |
| Writing scores after each interview          | ⬜    | Part of the report job (FR-7)  |

### FR-9 to FR-12 (coding mode, design canvas, trends, company-style mode): ⬜

Phase 2 and Phase 3 by plan. Nothing built. The question model already has `source.type` and
`source.reportedAt` for the "publicly reported pattern" labelling of FR-11.

## 3. REST API endpoints

| Endpoint                                               | State | Notes                                                            |
| ------------------------------------------------------ | ----- | ---------------------------------------------------------------- |
| `POST /auth/register`, `/login`, `/refresh`, `/logout` | ✅    |                                                                  |
| `POST /auth/google`                                    | 🔧    | Needs `GOOGLE_CLIENT_ID`                                         |
| `GET / PATCH /me`                                      | ✅    |                                                                  |
| `POST /resumes`, `GET /resumes/:id`                    | ✅    | `Idempotency-Key` supported on POST                              |
| `GET / PATCH /profiles/current`                        | ✅    |                                                                  |
| `POST /interviews`                                     | ✅    | Builds the plan; monthly free quota; `Idempotency-Key` supported |
| `GET /interviews/:id`                                  | ✅    |                                                                  |
| `GET /interviews/:id/turns`                            | ✅    | Cursor pagination                                                |
| `POST /interviews/:id/end`                             | ✅    |                                                                  |
| `GET /interviews/:id/report`                           | 🟡    | Stays 202 until the report job exists                            |
| `GET /users/me/progress`                               | ✅    | Empty until reports write skill history                          |
| `POST /interviews/:id/join`                            | ⬜    | 501                                                              |
| `POST /interviews/:id/answers`                         | ⬜    | 501                                                              |
| `GET /questions` (admin CRUD)                          | ⬜    | Route not created                                                |
| `GET /healthz`, `GET /readyz`                          | ✅    |                                                                  |
| Account / data deletion                                | ⬜    | Required by the privacy NFR                                      |
| List my resumes / list my interviews                   | ⬜    | Not in the PRD table, but the frontend will likely need them     |

The frontend contract for everything marked ✅ is in [FRONTEND_INTEGRATION.md](FRONTEND_INTEGRATION.md).

## 4. Platform and non-functional requirements

| Area                 | State | Done                                                                                                                                                                                                                         | Pending                                                                                                               |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Architecture         | ✅    | Modular monolith, three processes (api, worker, bot), PM2 config, routes → controller → service → repository                                                                                                                 | —                                                                                                                     |
| No Redis             | ✅    | MongoDB for sessions, rate limits, job queue (claim/lock/backoff/dead-letter), idempotency keys, bot registry; in-process LRU cache                                                                                          | —                                                                                                                     |
| Security             | 🟡    | helmet, CORS allow-list, zod validation, argon2id, 15-min JWT, refresh rotation with reuse detection, upload magic-byte checks, resume PII hidden by default, S3 server-side encryption + signed URLs, secrets only from env | Janus join tokens and room PINs in use, Dependabot config, data deletion endpoint                                     |
| Rate limiting        | ✅    | MongoDB TTL limiter on auth, upload and interview creation                                                                                                                                                                   | —                                                                                                                     |
| Observability        | 🟡    | pino JSON logs with request id, `/healthz` and `/readyz`, AI cost per call in `ai_usage`                                                                                                                                     | OpenTelemetry traces, Sentry, latency/queue metrics, cost dashboard and alerts                                        |
| AI cost controls     | 🟡    | Model tiers configurable, prompt caching (resume analyzer), per-call metering, monthly free interview quota                                                                                                                  | Per-interview hard cost cap, token budgets per task, "text mode counts less" quota rule, TTS phrase cache, VAD gating |
| Latency targets      | ⬜    | —                                                                                                                                                                                                                            | Nothing to measure until the live loop exists                                                                         |
| Availability / scale | ⬜    | Stateless API, horizontally scalable                                                                                                                                                                                         | Load tests (k6), bot capacity test                                                                                    |
| Privacy              | 🟡    | Resume raw text excluded from default reads                                                                                                                                                                                  | Account deletion, audio encryption/opt-in (with recording)                                                            |
| Testing              | 🟡    | 60 unit + integration tests, CI workflow (format, lint, typecheck, test, build, audit)                                                                                                                                       | CI `explain()` check for collection scans, AI contract tests on golden transcripts, load tests                        |

## 5. Data model (MongoDB collections)

All PRD collections exist as Mongoose models with their indexes:

`users`, `refresh_sessions`, `resumes`, `candidate_profiles`, `questions`, `rubrics`, `interviews`,
`interview_turns`, `transcript_events`, `reports`, `skill_history`, `jobs`, `rate_limits`.

Added beyond the PRD:

| Collection         | Why                                                                  |
| ------------------ | -------------------------------------------------------------------- |
| `idempotency_keys` | Backs the `Idempotency-Key` header (TTL 24 h)                        |
| `ai_usage`         | Per-call AI tokens and USD cost (backend doc's metering requirement) |
| `bot_instances`    | Bot heartbeat and least-loaded assignment (TTL removes dead bots)    |

## 6. External setup still needed (outside the code)

| Item                      | State | What to do                                                                                                                                                                                                                                                                            |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MongoDB Atlas             | 🟡    | Connected once. Add the dev machine's IP in Network Access; if `querySrv ECONNREFUSED` appears, switch DNS to 8.8.8.8 or use the non-SRV connection string. Create a separate dev database instead of using `resumeroundprod` locally. Rotate the DB password (it was shared in chat) |
| Atlas Vector Search index | ⬜    | Create `questions_embedding` per [atlas-vector-search.md](atlas-vector-search.md) once the embedding model is chosen                                                                                                                                                                  |
| Anthropic API key         | ⬜    | Set `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`; until then the mock analyzer is used                                                                                                                                                                                             |
| S3 bucket (or R2/MinIO)   | ⬜    | Private bucket + credentials; set `STORAGE_DRIVER=s3` and `S3_*`                                                                                                                                                                                                                      |
| Google OAuth client       | ⬜    | Create a Web client id; set `GOOGLE_CLIENT_ID` (backend) and `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (frontend)                                                                                                                                                                                |
| Linux VM + PM2            | ⬜    | `npm ci && npm run build && npm run db:sync-indexes`, then `pm2 start ecosystem.config.cjs --env production`                                                                                                                                                                          |
| Janus + coturn VM         | ⬜    | Public IP, UDP ports open, AudioBridge/TextRoom plugins, admin API on the private network                                                                                                                                                                                             |
| STT / TTS providers       | ⬜    | PRD open question; needed for MVP-4                                                                                                                                                                                                                                                   |
| Sentry project            | ⬜    | DSN for error tracking                                                                                                                                                                                                                                                                |
| Production cookies        | ⬜    | If the frontend and API are on different sites: `COOKIE_SAMESITE=none`, `COOKIE_SECURE=true`, and the Vercel URL in `CORS_ORIGINS`                                                                                                                                                    |

## 7. Deviations from the PRD / backend document

| Topic                    | PRD / doc says                                                    | Implemented                                | Reason                                                                                |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Password hashing library | argon2id                                                          | argon2id via `@node-rs/argon2`             | The `argon2` package needs a C++ toolchain to build; this one ships prebuilt binaries |
| Controller moves         | 7 moves                                                           | Adds `clarify`                             | The rule "low evaluator confidence → ask a clarifying question" needed its own move   |
| Core deep dive           | "Max 3 follow-ups unless the plan marks it as the core deep dive" | Core deep dive allows 5                    | The PRD gives no number; 5 is tunable in `RULES`                                      |
| `rate_limits` TTL        | TTL on `windowStart`                                              | TTL on an `expiresAt` field                | Lets different limiters use different window lengths                                  |
| `interviews` index       | `userId + startedAt`                                              | `userId + createdAt`                       | `startedAt` is empty until a call starts; the quota counts created interviews         |
| PM2 file name            | `ecosystem.config.js`                                             | `ecosystem.config.cjs`                     | The project uses ES modules; PM2 config must be CommonJS                              |
| Job queue                | Custom queue or Agenda.js                                         | Custom queue                               | Small, fully tested, no extra dependency                                              |
| Library versions         | Not specified                                                     | Express 5, Mongoose 9, Zod 4, TypeScript 6 | Current stable versions                                                               |

## 8. Suggested next steps

1. **Unblock MVP-1 for real use:** Anthropic key, S3 bucket, Google client id; then measure
   extraction precision on ~50 resumes.
2. **MVP-2 text interview:** `evaluateAnswer` and `phraseQuestion` in the AI gateway, embeddings
   and the vector index, seed questions and rubrics, then `POST /interviews/:id/answers`
   running the turn loop.
3. **MVP-3:** the `report.generate` job (aggregate turn scores, LLM report, write `skill_history`).
4. **Parallel MVP-4 spike:** provision Janus + coturn and compare RTP forwarding vs a Node WebRTC
   peer for the bot.
5. **Before beta:** account deletion, Sentry, per-interview cost cap, list endpoints for the frontend.
