# ResumeRound: Frontend Integration Guide (Phase 1)

This is everything the backend exposes today, written for the Next.js frontend. It covers the
**MVP-1 "Resume intelligence"** flow end to end (sign up, onboarding, resume upload, review and
correct the detected profile), plus the interview endpoints that already work.

Live-call features (Janus/WebRTC) are **not** available yet; see [What is not ready yet](#9-what-is-not-ready-yet).

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
6. **Ready to interview:** `POST /interviews` (section 7) shows the generated plan. The live
   interview room itself comes in a later phase.

---

## 7. Interviews (available now, partial)

These work today and are enough to build "create interview, see its plan, end it, report page
skeleton". The actual question/answer loop is not available yet.

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
     turn = { seq, objectiveIdx, questionText, answerText, evaluation, decision, askedAt, answeredAt }
     (always empty until the interview loop ships)

POST /interviews/:id/end                  -> 200 { "interview": { ..., "status": "ended" } }
     (safe to call more than once)

GET  /interviews/:id/report
     -> 409 CONFLICT                       interview not ended yet
     -> 202 { "status": "generating" }     ended, report not ready: poll (Retry-After: 5)
     -> 200 { "status": "ready", "report": {
              "id", "interviewId", "dimensionScores": { "<dimension>": 0-10 }, "overall": 0-10,
              "strengths": [], "weaknesses": [], "feedback": "",
              "recommendations": [{ "topic", "reason", "resources": [{ "title", "url" }] }],
              "createdAt" } }
```

Report dimensions will be: `technical_knowledge`, `problem_solving`, `system_design`,
`communication`, `depth`, `production_thinking`.
**Current status:** report generation is not built yet, so an ended interview stays at
`202 generating`. Build the page against the shape above.

There is no "list my interviews" endpoint yet.

---

## 8. Progress

```
GET /users/me/progress
-> 200 { "skills": [
  { "skill": "postgresql", "latest": 6.5,
    "points": [ { "score": 5, "at": "...", "interviewId": "..." }, { "score": 6.5, "at": "...", "interviewId": "..." } ] }
] }
```

`points` are oldest first (ready for a trend chart). Skill names are lower-case. This stays
empty until reports are generated (MVP-3).

---

## 9. What is not ready yet

| Feature                                                      | Endpoint                       | Today                                        | Planned     |
| ------------------------------------------------------------ | ------------------------------ | -------------------------------------------- | ----------- |
| Live voice interview (Janus/WebRTC room, captions, barge-in) | `POST /interviews/:id/join`    | `501 NOT_IMPLEMENTED`                        | MVP-4       |
| Text-mode answers / question loop                            | `POST /interviews/:id/answers` | `501 NOT_IMPLEMENTED`                        | MVP-2       |
| Report generation                                            | `GET /interviews/:id/report`   | Stays `202 generating`                       | MVP-3       |
| Google sign-in                                               | `POST /auth/google`            | `503` until `GOOGLE_CLIENT_ID` is configured | Config only |
| List my resumes / interviews                                 | (none)                         | Not available                                | On request  |
| Account deletion                                             | (none)                         | Not available                                | Later       |

For the future interview room, plan on `janus.js` in the browser connecting to Janus directly;
`POST /interviews/:id/join` will return the Janus URL, room id, a short-lived join token and ICE
servers. The exact contract will be shared when MVP-4 starts.
