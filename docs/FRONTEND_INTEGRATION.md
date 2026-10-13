# ResumeRound: Frontend Integration Guide (Phase 1)

This is everything the backend exposes today, written for the Next.js frontend. It covers the
**MVP-1 "Resume intelligence"** flow end to end (sign up, onboarding, resume upload, review and
correct the detected profile), plus the interview endpoints that already work.

The live voice interview (Janus/WebRTC) works in development: see
[7.6 Live voice interview](#76-live-voice-interview-mvp-4). Barge-in and push-to-talk come later;
see [What is not ready yet](#9-what-is-not-ready-yet).

---

## 1. Running the backend locally

```bash
# in the backend repo
npm install
npm run dev          # REST API on http://localhost:4000 + the job worker (needed for resume parsing)
```

Ask the backend team for the `.env` file. The backend must list the frontend's origin in
`CORS_ORIGINS` (it already allows `http://localhost:3000`).

Frontend environment variables:

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
NEXT_PUBLIC_GOOGLE_CLIENT_ID=   # same client id as the backend's GOOGLE_CLIENT_ID (see section 3.3)
```

Quick check: `GET http://localhost:4000/healthz` returns `{ "status": "ok" }`.
`GET http://localhost:4000/readyz` returns 200 only when the database is reachable.

---

## 2. Conventions (apply to every endpoint)

| Topic          | Rule                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| Base URL       | `${NEXT_PUBLIC_API_URL}` = `http://localhost:4000/api/v1`                      |
| Format         | JSON request and response bodies (except resume upload: `multipart/form-data`) |
| Auth           | `Authorization: Bearer <accessToken>` on every protected endpoint              |
| Cookies        | Always send `credentials: 'include'` (the refresh token is an httpOnly cookie) |
| Dates          | ISO-8601 strings in UTC, e.g. `"2026-10-08T09:30:00.000Z"`                     |
| IDs            | 24-character hex strings. A malformed id returns `400 VALIDATION_ERROR`        |
| Slow work      | Returns `202 Accepted`; poll the resource until its status changes             |
| Unknown fields | Rejected with `400` on PATCH bodies; send only the documented fields           |

### 2.1 Error format

Every error has the same shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "location": "body", "path": "email", "message": "Invalid email address" }],
    "requestId": "5d224cb8-b179-4f9e-a643-85b1b61dfc3c"
  }
}
```

Branch on `error.code`, not on `message`. Show `requestId` in error toasts or bug reports: it
lets the backend team find the exact request in the logs (it is also in the `X-Request-Id`
response header).

| HTTP      | `code`                   | Meaning / what the UI should do                                                           |
| --------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| 400       | `VALIDATION_ERROR`       | Field errors in `details[]`: show them next to the form fields (`path` is the field name) |
| 400       | `BAD_REQUEST`            | Generic bad input; show `message`                                                         |
| 401       | `UNAUTHORIZED`           | Access token missing/expired: refresh and retry (section 3.5), or send to login           |
| 403       | `FORBIDDEN`              | Not allowed                                                                               |
| 403       | `QUOTA_EXCEEDED`         | Monthly free interview limit reached; show `message`                                      |
| 404       | `NOT_FOUND`              | Resource does not exist (or belongs to another user)                                      |
| 409       | `CONFLICT`               | State conflict, e.g. email already registered; show `message`                             |
| 409 / 422 | `IDEMPOTENCY_CONFLICT`   | Same `Idempotency-Key` reused while in progress / with different data                     |
| 413       | `PAYLOAD_TOO_LARGE`      | File over 5 MB                                                                            |
| 415       | `UNSUPPORTED_MEDIA_TYPE` | Not a PDF or DOCX                                                                         |
| 429       | `RATE_LIMITED`           | Too many requests; wait `Retry-After` seconds (header and `details.retryAfterSec`)        |
| 501       | `NOT_IMPLEMENTED`        | Endpoint exists but its feature is a later milestone                                      |
| 503       | `SERVICE_UNAVAILABLE`    | Feature not configured on this server (e.g. Google sign-in)                               |
| 500       | `INTERNAL`               | Unexpected error; show a generic message with `requestId`                                 |

### 2.2 Shared enums

| Field         | Allowed values                                 | Suggested UI label                                     |
| ------------- | ---------------------------------------------- | ------------------------------------------------------ |
| `targetRole`  | `backend`, `frontend`, `fullstack`             | Backend, Frontend, Full Stack                          |
| `level`       | `sde1`, `sde2`, `senior`, `staff`              | SDE-1, SDE-2, Senior, Staff                            |
| `companyType` | `startup`, `product`, `faang_style`, `service` | Startup, Product company, FAANG-style, Service company |

### 2.3 Rate limits

| Endpoints                                                             | Limit                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `POST /auth/register`, `/auth/login`, `/auth/google`, `/auth/refresh` | 20 per minute per IP (shared)                              |
| `POST /resumes`                                                       | 20 per hour per user                                       |
| `POST /interviews`                                                    | 10 per hour per user (plus the monthly quota, section 7.1) |

Responses on these routes carry `RateLimit-Remaining` and, on 429, `Retry-After`.

---

## 3. Authentication

### 3.1 How tokens work

- **Access token:** a short-lived JWT (15 minutes, see `expiresIn` in seconds) returned in the
  response body. Keep it **in memory only** (React state/context or a module variable), never in
  `localStorage`.
- **Refresh token:** set by the server as the httpOnly cookie `rr_refresh` (path
  `/api/v1/auth`, 30 days). JavaScript cannot read it; the browser sends it automatically when you
  use `credentials: 'include'`.
- The refresh token **rotates on every use**. If an old refresh token is ever reused, the
  server treats it as stolen and ends that session. Consequence for the frontend: **never call
  `/auth/refresh` twice in parallel** (see the single-flight helper in section 3.6).

### 3.2 Register / Login

```
POST /auth/register
{ "email": "asha@example.com", "password": "at-least-8-chars", "name": "Asha" }   // name optional
-> 201

POST /auth/login
{ "email": "asha@example.com", "password": "at-least-8-chars" }
-> 200
```

Both return the same body (and set the `rr_refresh` cookie):

```json
{
  "user": {
    "id": "6710c0ffee0000000000abcd",
    "email": "asha@example.com",
    "name": "Asha",
    "role": "candidate",
    "authProvider": "password",
    "targetRole": null,
    "level": null,
    "companyType": null,
    "onboarded": false,
    "createdAt": "2026-10-08T09:30:00.000Z"
  },
  "accessToken": "eyJhbGciOi...",
  "expiresIn": 900
}
```

| Case                                                       | Response                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Email already registered                                   | `409 CONFLICT`                                                                       |
| Invalid email / password shorter than 8 or longer than 128 | `400 VALIDATION_ERROR`                                                               |
| Wrong email or password (login)                            | `401 UNAUTHORIZED`, message `"Invalid email or password"` (same for both, by design) |

Emails are case-insensitive and stored lower-cased.

### 3.3 Google sign-in

Use Google Identity Services ("Sign in with Google" button) with `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
Send the returned ID token (`credential`) to the backend:

```
POST /auth/google
{ "idToken": "<credential from Google>" }
-> 200, same body as login
```

If a password account with the same verified email exists, Google is linked to it.
**Current status:** the backend's `GOOGLE_CLIENT_ID` is not configured yet, so this returns
`503 SERVICE_UNAVAILABLE` until the backend team adds it. Build the button; it will start working
once the id is set on both sides.

### 3.4 Refresh and logout

```
POST /auth/refresh        (no body; relies on the cookie)
-> 200, same body as login, and a new rr_refresh cookie
-> 401 if the session is missing/expired/revoked (cookie is cleared): send the user to login

POST /auth/logout         (no body)
-> 204, cookie cleared
```

On app start (page load), call `POST /auth/refresh` once to restore the session: success means
the user is signed in and you get a fresh access token; 401 means show the public/login view.

### 3.5 Current user and onboarding

```
GET /me                     -> 200 { "user": { ...same user object... } }

PATCH /me
{ "targetRole": "backend", "level": "sde2", "companyType": "product" }   // any subset, plus optional "name"
-> 200 { "user": { ... } }
```

`user.onboarded` becomes `true` once `targetRole`, `level` and `companyType` are all set.
Use it to decide whether to show the onboarding screen. PATCH accepts only `name`,
`targetRole`, `level`, `companyType`; anything else is a `400`.

### 3.6 Suggested API client (plain JavaScript)

```js
// lib/api.js
const API_URL = process.env.NEXT_PUBLIC_API_URL;

let accessToken = null;
let refreshPromise = null; // single-flight: concurrent 401s share one refresh call

export function setAccessToken(token) {
  accessToken = token;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code ?? 'INTERNAL';
    this.details = body?.error?.details;
    this.requestId = body?.error?.requestId;
  }
}

export function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          accessToken = null;
          throw new ApiError(res.status, body);
        }
        accessToken = body.accessToken;
        return body; // { user, accessToken, expiresIn }
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function api(path, { method = 'GET', body, headers = {}, retry = true } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: 'include',
    headers: {
      ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    await refreshSession(); // throws if the session is gone -> caller redirects to login
    return api(path, { method, body, headers, retry: false });
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return { status: res.status, data };
}
```

Multiple browser tabs: each tab refreshing on its own can race on the rotating cookie. Keep
refreshes on demand (on a 401) rather than on a timer, and if a refresh returns 401, treat the
user as logged out in that tab.

---

## 4. Resume upload and parsing (FR-2)

### 4.1 Upload

```
POST /resumes
Content-Type: multipart/form-data
field "file": the PDF or DOCX (max 5 MB)
optional header: Idempotency-Key: <8-128 chars of A-Z a-z 0-9 _ ->
-> 202 { "resume": { ... } }   (also a Location header with the resume URL)
```

```js
const form = new FormData();
form.append('file', fileInput.files[0]); // the field name must be "file"
const { data } = await api('/resumes', {
  method: 'POST',
  body: form,
  headers: { 'Idempotency-Key': crypto.randomUUID() }, // keep the same key if you retry this upload
});
const resumeId = data.resume.id;
```

- Do **not** set `Content-Type` yourself for FormData; the browser adds the boundary.
- The file type is checked by its **content**, not its name: a renamed `.exe` is rejected even as
  `resume.pdf`. Still set `accept=".pdf,.docx"` on the input and check the size (5 MB) client-side
  for a fast error.
- `Idempotency-Key` is optional but recommended: if the network drops and you resend with the
  same key, you get the original response instead of a duplicate upload.

| Case                       | Response                     |
| -------------------------- | ---------------------------- |
| No file / wrong field name | `400 BAD_REQUEST`            |
| Over 5 MB                  | `413 PAYLOAD_TOO_LARGE`      |
| Not a PDF/DOCX             | `415 UNSUPPORTED_MEDIA_TYPE` |

### 4.2 Poll the parse status

```
GET /resumes/:id
-> 200 { "resume": {
  "id": "6710...",
  "status": "parsing",            // uploaded | parsing | ready | failed
  "originalName": "Asha_Resume.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 183422,
  "profileId": null,              // set when status = ready
  "error": null,                  // user-facing message when status = failed
  "createdAt": "...",
  "parsedAt": null
} }
```

Poll every 2 seconds until `status` is `ready` or `failed` (parsing normally takes under 30 s;
give up and show a retry option after about 90 s).

| Status                | UI                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `uploaded`, `parsing` | Progress state ("Reading your resume...")                                                        |
| `ready`               | Go to the profile review screen (section 5)                                                      |
| `failed`              | Show `resume.error` as is (it is written for users, e.g. scanned-image PDFs) and offer re-upload |

```js
async function waitForResume(id, { intervalMs = 2000, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api(`/resumes/${id}`);
    if (data.resume.status === 'ready' || data.resume.status === 'failed') return data.resume;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Resume parsing is taking longer than expected');
}
```

There is no "list my resumes" endpoint yet; remember the latest `resumeId` client-side if you need it.

---

## 5. Candidate profile: review and correct (FR-2)

### 5.1 Get the current profile

```
GET /profiles/current
-> 200 { "profile": {
  "id": "6710...",
  "resumeId": "6710...",
  "experienceYears": 4,
  "seniority": "sde2",                 // same values as level
  "domain": "fintech",                 // or null
  "skills": {
    "languages": ["TypeScript"],
    "frameworks": ["Node.js", "Express"],
    "databases": ["PostgreSQL", "Redis"],
    "cloud": ["AWS", "Docker"],
    "architecture": ["microservices", "Kafka"]
  },
  "projects": [
    {
      "name": "Payment Gateway",
      "technologies": ["Node.js", "Redis", "Kafka"],
      "description": "Payment processing service for a fintech startup.",
      "scaleSignals": ["2000 RPS"]
    }
  ],
  "editedByUser": false,
  "updatedAt": "..."
} }
-> 404 NOT_FOUND if the user has no parsed resume yet (show the upload screen)
```

### 5.2 Save corrections

```
PATCH /profiles/current
-> 200 { "profile": { ..., "editedByUser": true } }
```

Send only the sections the user changed, but each section you send **replaces** the stored one
completely (send the full corrected list, not a diff):

```json
{
  "experienceYears": 4.5,
  "seniority": "sde2",
  "domain": "fintech",
  "skills": {
    "languages": ["TypeScript", "Go"],
    "frameworks": ["Node.js"],
    "databases": ["PostgreSQL"],
    "cloud": ["AWS"],
    "architecture": ["microservices"]
  },
  "projects": [
    {
      "name": "Payment Gateway",
      "technologies": ["Node.js"],
      "description": "...",
      "scaleSignals": []
    }
  ]
}
```

Validation (mirror these in the form):

| Field                  | Rule                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `experienceYears`      | number, 0 to 50                                                    |
| `seniority`            | one of the `level` values                                          |
| `domain`               | string up to 100 chars, or `null`                                  |
| `skills`               | if sent, must contain **all five** arrays (an empty array is fine) |
| each skill tag         | 1 to 60 chars, at most 50 tags per list                            |
| `projects`             | at most 15; each needs all four fields                             |
| `project.name`         | 1 to 200 chars                                                     |
| `project.description`  | up to 2000 chars (may be empty `""`)                               |
| `project.scaleSignals` | at most 20 strings, each 1 to 200 chars                            |

Note: uploading a **new** resume creates a fresh profile from that resume and replaces the
current one, including any manual corrections. Warn the user before re-uploading.

---

## 6. Suggested Phase 1 screen flow

1. **Sign up / log in** (`/auth/register`, `/auth/login`, Google button).
2. **App load:** `POST /auth/refresh`; on success `GET /me`.
3. **Onboarding** while `user.onboarded === false`: role, level, company type, then `PATCH /me`.
4. **Upload resume:** `POST /resumes`, then poll `GET /resumes/:id`.
5. **Review profile:** `GET /profiles/current`; editable chips per skill bucket, project cards;
   `PATCH /profiles/current` on save.
6. **Ready to interview:** `POST /interviews` (section 7) shows the generated plan.
7. **Interview:** text: `start` → `answers` loop (section 7.4); voice: `start` → `join` and the
   live call room (section 7.6).

---

## 7. Interviews

Create an interview and see its plan (7.1-7.3), run it by typing answers (7.4), then read the
report (7.5). Voice interviews use the live call in 7.6.

### 7.1 Create

```
POST /interviews
optional header: Idempotency-Key
{
  "role": "backend",            // optional: defaults to the user's onboarding value
  "level": "sde2",              // optional
  "companyType": "product",     // optional
  "durationMin": 30,            // 15 | 30 | 45, default 30
  "mode": "voice"               // "voice" | "text", default "voice"
}
-> 201 { "interview": { ... } }
```

| Case                                                                        | Response                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------- |
| Role/level/company type neither in body nor in onboarding                   | `400 BAD_REQUEST`                               |
| No parsed profile yet                                                       | `409 CONFLICT` (send the user to resume upload) |
| Monthly free limit reached (currently 5 interviews per calendar month, UTC) | `403 QUOTA_EXCEEDED`                            |

### 7.2 The interview object

```json
{
  "id": "6710...",
  "status": "created", // created | in_progress | ended | abandoned
  "mode": "voice",
  "role": "backend",
  "level": "sde2",
  "companyType": "product",
  "durationSec": 1800,
  "plan": [
    {
      "kind": "warmup", // see table below
      "topic": "Overview of Payment Gateway",
      "technologies": ["Node.js", "Redis", "Kafka"],
      "projectName": "Payment Gateway",
      "startDifficulty": 4, // 1-10
      "timeBudgetSec": 144,
      "isCoreDeepDive": false
    }
  ],
  "state": { "phase": "created", "currentObjectiveIdx": 0, "difficulty": 4, "questionsAsked": 0 },
  "startedAt": null,
  "endedAt": null,
  "createdAt": "..."
}
```

| `plan[].kind`          | Suggested label      |
| ---------------------- | -------------------- |
| `warmup`               | Warm-up              |
| `project_deep_dive`    | Project deep dive    |
| `fundamentals`         | Fundamentals         |
| `system_design`        | System design        |
| `scaling_scenario`     | Scaling scenario     |
| `production_debugging` | Production debugging |
| `behavioral`           | Behavioral           |

The plan is good for an "interview agenda" preview before starting.

### 7.3 Other interview endpoints

```
GET  /interviews/:id                      -> 200 { "interview": {...} }

GET  /interviews/:id/turns?limit=20&cursor=<nextCursor>
     -> 200 { "items": [ turn, ... ], "nextCursor": "12" | null }
     turn = { seq, objectiveIdx, objectiveKind, isFollowUp, questionText, answerText,
              evaluation, decision, askedAt, answeredAt }
     (evaluation and decision are null until the interview has ended; this is the transcript /
      history view only: never poll it to wait for a question, see 7.4)
     decision = { move, reason } | null   // why the interviewer asked the next question
       move: deepen | challenge_vague | clarify | raise_difficulty | hint |
             reveal_scenario_info | next_objective | wrap_up
       reason: one sentence, e.g. "Answer was strong; raising difficulty within the level band"

POST /interviews/:id/end                  -> 200 { "interview": { ..., "status": "ended" } }
     (safe to call more than once)

GET  /interviews/:id/report             see section 7.5
```

There is no "list my interviews" endpoint yet.

### 7.4 Text interview loop: `start` and `answers` (MVP-2)

> **Status: live.** Both endpoints work as described below. With the backend's `AI_PROVIDER=mock`
> (local default) the questions come from simple templates; with `AI_PROVIDER=anthropic` they are
> written by the AI for each candidate. The request and response shapes are identical either way.

**Why this replaces polling.** The backend does not create questions in the background. A question
is created only when you call `start` (first question) or `answers` (every next question), and it
comes back **in the response** of that call. Do **not** poll `GET /turns` to wait for a question:
it only reads already-saved turns and will stay empty. Use `/turns` only for the transcript /
history view.

**How the interviewer works (what the user experiences).** Each question is written by the AI
for this candidate: grounded in their own resume projects and matched to their level and
experience (an SDE-1 and a Senior get different depth on the same topic). After every answer the
AI judges it and picks the next move: dig deeper, ask for specifics when the answer was vague,
raise the difficulty, give a hint, or move to the next topic in the plan. The backend keeps the
interview on time and inside the candidate's level, and ends it when the plan or time runs out.
Scores are **never shown during the interview**; they appear only in the report.

#### Start the interview

```
POST /interviews/:id/start          (no body)
-> 200 {
  "interview": { ...interview object, "status": "in_progress", "startedAt": "..." },
  "progress": { ...see "Progress object" below },
  "currentTurn": {
    "seq": 1,
    "objectiveIdx": 0,
    "objectiveKind": "warmup",
    "questionText": "Let's start with your Payment Gateway project. Walk me through what it does and what you owned in it.",
    "isFollowUp": false,
    "askedAt": "2026-10-09T10:00:02.000Z"
  }
}
```

- Typically takes **1-4 seconds** (the AI writes the first question). Show an "Interviewer is
  preparing your first question..." state.
- **Safe to call again.** If the interview is already in progress (page reload, second tab), it
  does not restart anything: it returns the current unanswered question with the same shape.
- Starting also starts the interview clock (`startedAt`); see the timer notes below.

#### Submit an answer, get the next question

```
POST /interviews/:id/answers
{
  "seq": 1,                       // seq of the question being answered (from currentTurn.seq)
  "answerText": "It's a Node.js service that..."   // 1-5000 characters
}
-> 200 {
  "interview": { ...interview object },
  "progress": { ... },
  "currentTurn": { "seq": 2, "objectiveIdx": 0, "objectiveKind": "warmup",
                   "questionText": "You mentioned Redis caching at 2000 RPS. What happens to payments if Redis goes down?",
                   "isFollowUp": true, "askedAt": "..." },
  "closingMessage": null
}
```

When the interview finishes (plan complete or time up), the same call returns:

```json
{
  "interview": { "status": "ended", "endedAt": "..." },
  "progress": { "...": "..." },
  "currentTurn": null,
  "closingMessage": "That's all from my side. Thanks for walking me through your work - your report will be ready shortly."
}
```

- Typically takes **2-6 seconds** (the AI scores the answer, decides, and writes the next
  question). Disable the input and show "Interviewer is thinking..." while waiting.
- `isFollowUp: true` means the question continues the same thread (dig deeper, clarify, hint);
  `false` means a new topic started. Optional UI touch: show a small "New topic: Fundamentals"
  divider when `isFollowUp` is false.
- When `currentTurn` is `null` and `interview.status` is `"ended"`: show `closingMessage`, then go
  to the report page (`GET /interviews/:id/report`, which returns `202 generating` until ready).

#### Progress object

Returned by `start`, `answers` and `GET /interviews/:id`:

```json
{
  "objectiveIdx": 1, // index into interview.plan
  "objectiveCount": 6,
  "objectiveKind": "project_deep_dive",
  "questionsAsked": 4,
  "elapsedSec": 412, // server-side, since startedAt
  "remainingSec": 1388
}
```

Use it for a progress bar ("Topic 2 of 6: Project deep dive") and the timer. Run the countdown
locally from `remainingSec` and re-sync it from every response; the server's clock is the source
of truth. When the time is up, the next `answers` call ends the interview. The **End interview**
button calls `POST /interviews/:id/end` (section 7.3) at any time.

#### Errors for `start` and `answers`

| Case                                                                | Response                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `answers` before `start`, or interview already ended                | `409 CONFLICT`                                                                                            |
| `seq` is not the current question (stale tab, out-of-order request) | `409 CONFLICT` with `details.currentSeq`: call `start` to re-fetch the current question                   |
| Empty answer or over 5000 characters                                | `400 VALIDATION_ERROR`                                                                                    |
| The AI provider failed or timed out                                 | `503 SERVICE_UNAVAILABLE`: the answer is saved; **retry the exact same request** (same `seq`), it is safe |
| Too many submissions                                                | `429 RATE_LIMITED` (30 answers per minute per user)                                                       |

**Double submits are safe:** sending the same `seq` and `answerText` twice (double click, network
retry) returns the same result instead of skipping a question. Still disable the send button
while a request is in flight.

#### Changes to existing endpoints (now live)

- `GET /interviews/:id` returns the **same top-level shape as `start`**: `progress` and
  `currentTurn` sit **next to** `interview`, not inside it. The `interview` object itself does not
  change.

  ```
  GET /interviews/:id
  -> 200 {
    "interview": { ...interview object, unchanged },
    "progress": { ... } | null,      // null while status is "created" (not started yet)
    "currentTurn": { ... } | null    // the open question; null if not started or ended
  }
  ```

  Code that reads only `data.interview` today keeps working unchanged.

- `GET /interviews/:id/turns`: each turn adds `objectiveKind` and `isFollowUp`. While the interview
  is in progress, `evaluation` and `decision` are always `null` (no scores mid-interview); they are
  filled in after it ends.
- Create interviews with `"mode": "text"` for a typed interview, or `"mode": "voice"` for the
  live call (7.6). `voice` interviews also accept typed answers.

#### Interview screen flow

1. **Plan preview:** `POST /interviews` (or `GET /interviews/:id`); show the agenda from `plan`.
2. **Start button:** `POST /interviews/:id/start` → show `currentTurn.questionText`, start the timer.
3. **Answer box:** submit → `POST /interviews/:id/answers` with `{ seq: currentTurn.seq, answerText }`
   → show the new `currentTurn`; append both to the chat-style history on screen.
4. **Finished:** `currentTurn === null` → show `closingMessage` → report page.
5. **End early:** `POST /interviews/:id/end` → report page.
6. **Page reload:** check `GET /interviews/:id` first (this works today), then branch on
   `interview.status`:
   - `"in_progress"`: restore the screen. Either read `currentTurn` and `progress` from that same
     response, or call `start` again. Both are supported and return the same open question.
   - `"created"`: show the plan preview with the Start button. **Do not call `start` here
     automatically**, because it starts the interview clock.
   - `"ended"`: go to the report page (`start` would return `409`).

   Load past turns with `GET /interviews/:id/turns` for the history view.

```js
// Minimal loop, using the api() client from section 3.6
async function startInterview(id) {
  const { data } = await api(`/interviews/${id}/start`, { method: 'POST' });
  return data; // { interview, progress, currentTurn }
}

async function submitAnswer(id, seq, answerText) {
  try {
    const { data } = await api(`/interviews/${id}/answers`, {
      method: 'POST',
      body: { seq, answerText },
    });
    return data; // currentTurn === null -> interview ended
  } catch (err) {
    if (err.code === 'SERVICE_UNAVAILABLE') return submitAnswer(id, seq, answerText); // safe retry (add a limit/backoff)
    if (err.code === 'CONFLICT') return startInterview(id); // resync to the current question
    throw err;
  }
}
```

### 7.5 Report (MVP-3)

> **Status: live.** The report is generated by the backend's job worker right after the interview
> ends (usually within 30-60 seconds), so `npm run dev` must be running (it starts the worker).

```
GET /interviews/:id/report
```

| Response                                                     | Meaning                                                                    | UI                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `409 CONFLICT`                                               | The interview has not ended                                                | Should not happen from the report page; go back to the interview |
| `202 { "status": "generating" }`                             | Being generated (`Retry-After: 5`)                                         | "Scoring your answers...", poll every 5 s                        |
| `200 { "status": "ready", "report": {...} }`                 | Done                                                                       | Render the report                                                |
| `200 { "status": "insufficient_answers", "message": "..." }` | Fewer than 2 answers were scored, so there is nothing meaningful to report | Show `message`; offer a new interview                            |
| `200 { "status": "failed", "message": "..." }`               | Generation failed after retries                                            | Show `message` (written for users)                               |

`ready`, `insufficient_answers` and `failed` are final: stop polling. Keep a safety cap on
`generating` (for example 3 minutes, then "Your report is taking longer than usual, check back
later"), but it should not normally be reached.

The report object:

```json
{
  "id": "6711...",
  "interviewId": "6710...",
  "overall": 6.4,
  "dimensionScores": {
    "technical_knowledge": 7.1,
    "problem_solving": 6.0,
    "system_design": 5.8,
    "communication": 7.5,
    "depth": 5.9,
    "production_thinking": 6.2
  },
  "questionsAnswered": 18,
  "strengths": ["Explained the Redis cache-aside flow precisely, including TTLs and invalidation"],
  "weaknesses": ["Did not consider what happens to the database when the cache is cold"],
  "feedback": "You explained your own design clearly... The most important thing to work on is...",
  "recommendations": [
    {
      "topic": "Cache stampede and cold-start protection",
      "reason": "When Redis went down in the scenario, the answer did not protect the database.",
      "resources": [
        { "title": "Redis docs: Client-side caching and key expiration", "url": null },
        {
          "title": "Hands-on: load-test a cache-aside service with the cache disabled",
          "url": null
        }
      ]
    }
  ],
  "createdAt": "2026-10-09T10:31:02.000Z"
}
```

- **Scores** are 0-10 with one decimal. `dimensionScores` contains **only dimensions the
  interview gave evidence for**: a dimension can be missing (for example no `system_design` in a
  short interview). Render the ones present; do not show missing ones as 0.
- Dimension labels: `technical_knowledge` Technical knowledge, `problem_solving` Problem solving,
  `system_design` System design, `communication` Communication, `depth` Depth,
  `production_thinking` Production thinking.
- `strengths`, `weaknesses`: short sentences, each grounded in what the candidate said.
- `feedback`: one or two paragraphs written to the candidate ("you"). Preserve line breaks.
- `recommendations`: most important first. `resources[].url` is **always `null` for now** (the AI
  suggests what to study, but does not invent links); show `title` as plain text.
- For the per-question breakdown (question, answer, per-answer scores and evidence), use
  `GET /interviews/:id/turns`: after the interview ends, each turn includes `evaluation` and
  `decision`.

### 7.6 Live voice interview (MVP-4)

> **Status: live in development.** `POST /interviews/:id/join` works and the interview bot joins
> the call, speaks the questions, transcribes the answers and sends captions. The backend needs
> the bot process running (`npm run dev:bot`) and the dev media server switched on. Not built
> yet: barge-in (interrupting the interviewer) and push-to-talk.

#### What the frontend does, and what it never does

The candidate talks to an AI interviewer over a WebRTC audio call. The browser only sends the
microphone to the call and plays what comes back. Everything else happens on the backend:

```
Browser (mic) ──WebRTC──> Janus room <──WebRTC── Interview bot (backend)
Browser (speaker) <──────  room audio             ├─ speech-to-text (Deepgram)
Browser (captions) <─ data channel ───────────────├─ AI interviewer (Ollama LLM)
                                                  └─ text-to-speech (Deepgram)
```

- **Do:** get microphone permission, join the room, play the room audio, show captions and the
  interviewer's state, and offer mute, end and typed-answer controls.
- **Never:** call Deepgram, the LLM or any speech API, hold API keys, record or process audio
  yourself. There are no speech settings on the frontend: voice, language and timing are all
  backend config.

#### Join the call

```
POST /interviews/:id/join
-> 200 {
  "wsUrl": "wss://media.resumeround.<domain>/janus",  // dev: "ws://<server-ip>:8188"
  "token": "...",            // Janus token; valid for the interview's maximum length + 15 min
  "room": 4821733,           // AudioBridge room for this interview only
  "pin": "550913",           // room PIN
  "captionRoom": 4821733,    // TextRoom for captions and state events (same PIN)
  "iceServers": [
    { "urls": "stun:<server-ip>:3478" },
    {
      "urls": ["turn:<server-ip>:3478?transport=udp", "turn:<server-ip>:3478?transport=tcp"],
      "username": "1760300000:6710...",   // time-limited TURN credentials
      "credential": "..."
    }
  ]
}
```

| Case                                                    | Response                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Interview created with `mode: "text"`                   | `409 CONFLICT` "This interview is in text mode"                             |
| Interview not started yet                               | `409 CONFLICT` "Start the interview first" → call `start` (7.4), then retry |
| Interview already ended                                 | `409 CONFLICT` "This interview has ended" → go to the report page           |
| Not the owner of the interview                          | `404 NOT_FOUND`                                                             |
| Voice not configured, no bot free, or media server down | `503 SERVICE_UNAVAILABLE` → offer to continue in text mode (7.4)            |

- Order: create with `mode: "voice"`, `POST /interviews/:id/start`, then `join`, all from the
  candidate's Start click (see "Browser rules" below).
- The bot joins the room within about a second of `join` and starts speaking the current question
  straight away, so connect immediately after `join` returns. The first question is also shown as
  a caption and in the `start` response, so nothing is lost if the audio starts a moment early.
- The token and TURN credentials last for the whole interview. Calling `join` again (after a
  reconnect, see below) returns a fresh set for the same room; it does not restart the interview.
- Treat every field as opaque and secret for that session: do not log or store them.

#### Connect to the room

Janus is reached over its WebSocket API. You can use the official `janus.js` library, or a small
client like the reference page used to test this server:
[spikes/janus-audio/test-page/index.html](../spikes/janus-audio/test-page/index.html) (about 80
lines: create a session, attach, send messages, trickle ICE, keepalive). The steps:

1. **Microphone** (exact settings matter, see below):
   ```js
   const mic = await navigator.mediaDevices.getUserMedia({
     audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
   });
   ```
2. **Peer connection** with the `iceServers` from `join`; add the mic track.
   ```js
   const pc = new RTCPeerConnection({ iceServers: join.iceServers });
   mic.getTracks().forEach((t) => pc.addTrack(t, mic));
   ```
3. **Janus session:** open `new WebSocket(join.wsUrl, 'janus-protocol')`, send
   `{ janus: 'create' }`, then send `{ janus: 'keepalive', session_id }` **every 25 s**. Put
   `token: join.token` on **every** message (Janus checks it on each request).
4. **Attach** `janus.plugin.audiobridge`, then trickle ICE: send every `pc.onicecandidate`
   candidate with `{ janus: 'trickle', candidate }`, and `{ completed: true }` at the end. Add
   candidates that Janus sends (`janus: 'trickle'` events) with `pc.addIceCandidate`.
5. **Join** with an offer:
   ```js
   const offer = await pc.createOffer();
   await pc.setLocalDescription(offer);
   const res = await handle.message(
     { request: 'join', room: join.room, pin: join.pin, display: 'candidate', muted: false },
     { type: offer.type, sdp: offer.sdp },
   );
   await pc.setRemoteDescription(res.jsep); // Janus answers with the room mix
   ```
6. **Play the room audio:**
   ```js
   pc.ontrack = (e) => {
     audioEl.srcObject = e.streams[0] ?? new MediaStream([e.track]);
     audioEl.play();
   };
   ```
   The candidate hears only the interviewer (Janus never sends you your own voice back).
7. **Captions channel:** attach `janus.plugin.textroom` on the same session, send
   `{ request: 'setup' }`, answer the offer Janus returns (a second `RTCPeerConnection` with a
   data channel), then on the data channel send
   `{ textroom: 'join', room: join.captionRoom, pin: join.pin, username, transaction }` with a
   **new random username on every join**, e.g. `candidate-${crypto.randomUUID().slice(0, 8)}`.
   TextRoom usernames must be unique in a room, and after a network drop the old session can
   stay in the room for up to a minute; a fixed name would be rejected (TextRoom error `420`,
   username taken). The backend never relies on this name.
   The bot does not join the TextRoom as a user: it sends every event as a room
   **announcement**, which arrives on the data channel as
   `{ textroom: 'announcement', room, date, text: '<JSON>' }`. Handle only messages with
   `textroom === 'announcement'`, parse `text` (events below), and ignore anything else.

`pc.connectionState === 'connected'` means audio is flowing. Expect about 1-2 s from `join` to
connected; show a "Connecting..." state until then.

#### Captions and interviewer state

Each announcement's `text` is one JSON event:

```jsonc
{ "type": "state", "state": "speaking" }      // "speaking" | "listening" | "thinking"
{ "type": "interviewer", "seq": 3, "text": "Why did you pick Kafka over RabbitMQ?" }
{ "type": "candidate", "seq": 3, "text": "we needed replay", "final": false }
{ "type": "candidate", "seq": 3, "text": "We needed replay and ordering per key.", "final": true }
{ "type": "ended", "reason": "completed" }    // "completed" | "time_up" | "ended_by_user"
```

- **`state`** drives the main indicator:
  - `speaking`: the interviewer is talking. Show its caption; the candidate should wait.
  - `listening`: it's the candidate's turn. Show a "Listening..." indicator and a mic level meter.
  - `thinking`: the candidate has finished and the reply is being prepared (2-4 s in
    development). The interviewer says a short "Okay." / "Got it." first, and "Give me a
    moment." if it takes longer. Show a subtle "thinking" animation.
  - Until the first `state` event arrives, show "Connecting...".
- **`interviewer`** arrives one sentence at a time, when that sentence starts playing, so captions
  stay in step with the voice. Append sentences with the same `seq` into one bubble.
- **`candidate`**: live transcript of what the candidate is saying. Replace the current line
  while `final` is `false` (each update carries the whole answer so far); exactly one
  `final: true` event arrives when the answer is submitted, with the cleaned-up text that was
  stored. Grey italic for interim text works well.
- **`ended`**: hang up (below), then go to the report page as in text mode. The bot also closes
  the room a moment later.
- Announcements are not stored by Janus: after a reconnect, rebuild the history from
  `GET /interviews/:id/turns`.

`seq` matches `currentTurn.seq` and the `seq` of `GET /interviews/:id/turns`, so the on-screen
history and the stored transcript line up.

#### How turn-taking works (what to tell the candidate)

- A pause of about **1-1.5 s** is treated as "finished answering" (a bit longer after a very
  short answer). The interviewer then acknowledges and asks the next question after about
  2-4 s in development.
- The whole interview is in **English**.
- **Until barge-in ships**, the candidate cannot interrupt: speech while the interviewer is
  talking is ignored. Show "Interviewer is speaking..." during `speaking`, so candidates wait.
- Long thinking pauses can end an answer early. Until push-to-talk ships, show a short tip
  before starting: _"Take your time. If you need to think, say 'let me think' first."_
- **Planned controls** (later in MVP-4/5, keep room for them in the layout): a "Hold to talk"
  button (push-to-talk), and interrupting the interviewer by speaking (barge-in).

#### Controls

| Control                  | How                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Mute / unmute            | `handle.message({ request: 'configure', muted: true \| false })`. Also flip `track.enabled` on the mic track so the browser shows it muted   |
| Type an answer instead   | `POST /interviews/:id/answers` as in 7.4, also during a voice call (e.g. code or a long name). The interviewer then speaks the next question |
| End interview            | `POST /interviews/:id/end`, then hang up                                                                                                     |
| Hang up (leave the room) | `handle.message({ request: 'leave' })`, send `{ janus: 'destroy' }`, close the WebSocket, `pc.close()`, stop the mic tracks                  |

Always hang up on: the `ended` event, leaving the interview page, and logout. Add a
`beforeunload` warning while the call is connected.

#### Reconnecting

Networks drop. The interview survives a short disconnect:

- If `pc.connectionState` becomes `failed`, or the Janus WebSocket closes, hang up, call
  `POST /interviews/:id/join` again and reconnect. Show "Reconnecting..." meanwhile.
- `disconnected` often recovers by itself: wait about 5 s before treating it as `failed`.
- After 3 failed attempts, offer text mode (7.4); the interview continues from the same question.
- On page reload, follow the reload rules in 7.4 (`GET /interviews/:id` first). If
  `status === "in_progress"` and `mode === "voice"`, offer a "Rejoin call" button. Do not
  rejoin automatically: the browser needs a click before it can play audio.

#### Browser rules and setup screen

- **HTTPS is required** for the microphone (`http://localhost` is fine in development).
- **Autoplay:** browsers block audio until the user clicks. Call `join`, create the
  `AudioContext` and call `audioEl.play()` from the Start / Rejoin button's click handler.
- **Echo cancellation must stay on** (the `getUserMedia` settings above). Without it the
  interviewer's own voice is picked up by the mic and transcribed as the candidate's answer.
- **Recommend headphones** on the setup screen, for the same reason.
- **Setup screen before the call:** ask for microphone permission, offer a microphone picker
  (`enumerateDevices`) when there is more than one, and show a live level meter (an
  `AnalyserNode` on the mic stream, as in the reference page) so the candidate can check they are
  heard.
- **Supported:** current Chrome, Edge, Firefox and Safari (desktop and mobile). On iOS Safari,
  every audio start needs a tap.

| Error                               | Message to show                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `getUserMedia` → `NotAllowedError`  | "Allow microphone access in your browser settings to use voice mode."               |
| `getUserMedia` → `NotFoundError`    | "No microphone found. Connect one, or continue in text mode."                       |
| `getUserMedia` → `NotReadableError` | "Your microphone is in use by another app (Zoom, Teams...). Close it and retry."    |
| ICE never connects (after retries)  | "Your network is blocking the call. Try another network, or continue in text mode." |
| `join` → `503`                      | "Voice is busy right now. Continue in text mode?"                                   |

#### Development notes

- The dev media server (AWS) is switched on only during testing. If the Janus WebSocket times
  out, check with the backend team that it is running. Production will limit access again.
- The backend needs three processes for a voice call: `npm run dev` (API + worker) and
  `npm run dev:bot` (interview bot).
- In development the URLs are `ws://` (no TLS); production uses `wss://` on port 443.
- To try the call before the frontend is ready, run the reference page:
  `npx tsx spikes/janus-audio/test-page/server.ts`, then open http://localhost:8787.

---

## 8. Progress

```
GET /users/me/progress
-> 200 {
  "overall": [ { "score": 5.8, "at": "...", "interviewId": "..." }, { "score": 6.4, ... } ],
  "dimensions": [
    { "dimension": "system_design", "latest": 6.1,
      "points": [ { "score": 5.2, "at": "...", "interviewId": "..." }, { "score": 6.1, ... } ] }
  ],
  "skills": [
    { "skill": "redis", "latest": 6.5,
      "points": [ { "score": 5, "at": "...", "interviewId": "..." }, { "score": 6.5, ... } ] }
  ]
}
```

- `overall`: one point per interview that has a report (last 20).
- `dimensions`: score trend per dimension (PRD FR-8 progress view). A dimension appears once some
  report has scored it.
- `skills`: per technology from the interview plans (lower-case names, last 20 points each). These
  also make the next interview focus on the weakest skills.
- All `points` arrays are oldest first, ready for a trend chart. Everything is empty until the
  first report has been generated.

---

## 9. What is not ready yet

| Feature                                  | Endpoint            | Today                                        | Planned     |
| ---------------------------------------- | ------------------- | -------------------------------------------- | ----------- |
| Barge-in and push-to-talk in voice calls | (none)              | Not available (voice call itself works)      | MVP-4/5     |
| Google sign-in                           | `POST /auth/google` | `503` until `GOOGLE_CLIENT_ID` is configured | Config only |
| List my resumes / interviews             | (none)              | Not available                                | On request  |
| Account deletion                         | (none)              | Not available                                | Later       |

The voice interview room (join call, Janus connection, captions, controls, reconnects) is in
[7.6 Live voice interview](#76-live-voice-interview-mvp-4).
