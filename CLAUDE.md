# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`clickshq-backend` is the API server for **clicksHQ**, a ClickUp-style work-management SaaS:
spaces → tasks (with statuses/comments/subtasks/checklists), projects/goals/sprints, a
Notion-style collaborative **docs** subsystem, a **workflow automation** engine, and a large
suite of third-party **integrations**. Much of the docs / workflow / integration code was
migrated from a predecessor app called **"Nexus"** — comments and some stubs still reference it.

The frontend is a separate app (`../clickshq-frontend`); this server is API-only (no static/Vite serving).

## Commands

```bash
npm run dev      # tsx watch, loads .env, NODE_ENV=development, listens on PORT (default 4000)
npm run check    # tsc typecheck only (noEmit) — there is no linter and no test suite
npm run build    # esbuild bundle of api/handler.ts -> api/index.js (Vercel target)
npm run start    # production: node dist/index.js
npm run db:push  # drizzle-kit push — applies shared/schema.ts to the DB (no SQL migration run)
```

There are **no tests** and **no lint** config. `npm run check` (tsc) is the only static gate.
The `migrations/` folder holds a Drizzle snapshot, but schema changes are applied with
`db:push`, not by running migration files.

## Dual runtime — this matters

The same route-registration code runs in two hosts:

- **Standalone server** — `server/index.ts` → `registerRoutes(app)`. Used by `npm run dev`/`start`.
  Uses an in-memory session store and **starts all the cron jobs** (see below).
- **Vercel serverless** — `api/handler.ts` → `registerRoutesServerless(app)`. Lazily builds a warm
  Express app per cold start, uses a **Postgres-backed session store** (`connect-pg-simple`), and
  **does NOT run the cron jobs**. `build-vercel.mjs` bundles this entry; `vercel.json` rewrites all
  routes to `/api/index.js`.

When adding routes, register them inside `registerAllRoutes()` in `server/routes.ts` (or a mounted
router) so **both** runtimes pick them up. Scheduled work added via `setInterval` in `index.ts` will
**not** run on Vercel.

## Architecture

### Request entry & routing
`server/routes.ts` (~3970 lines) is the core. `registerAllRoutes()` defines auth, onboarding,
company, admin, teams, projects, goals, sprints, tasks/comments, and spaces handlers **inline**,
then mounts ~30 modular routers from `server/routes/*.routes.ts` and calls `registerDocsRoutes()` /
`registerSlackRoutes()`. Route order matters: specific paths (e.g. `/api/docs/spaces`,
`/api/spaces/favourites`) are registered before `/:id` params to avoid capture.

### Data access
- `shared/schema.ts` — single Drizzle schema, ~65 pgTables + Zod insert/update schemas. Imported
  everywhere via the **`@shared/*`** path alias (tsconfig `paths`; esbuild `alias`).
- `server/db.ts` — exports `db` (Drizzle over a `pg` Pool) and `pool`.
- `server/storage.ts` — a ~2150-line `DatabaseStorage` class (the `storage` singleton) implementing
  `IStorage`. This is the primary data-access façade for the inline handlers in `routes.ts`.
- `server/storage/*.ts` — newer feature-scoped data access (`documentStorage`, `slackStorage`,
  `spaceStorage`, `templateStorage`, `versionStorage`). Newer code tends to use `db` directly or
  these modules rather than the monolithic `storage`.

Both patterns coexist — match whichever the surrounding file already uses.

### Auth & security (`server/auth.ts`, `server/middleware/`)
- Passport: **local** (bcrypt, requires verified email), **Google** and **Microsoft** OAuth
  (auto-link by email). Session via `express-session`; user is serialized by id.
- `requireAuth` (session) guards most routes. Admin routes use an inline `requireAdminAccess`
  (role `admin`/`sub-admin`).
- 2FA: email codes + TOTP (`otplib`) with QR (`qrcode`); email verification + password reset tokens.
- `middleware/apiKeyAuth.ts` — alternate auth for the Zapier/public API: `X-API-Key` header or
  OAuth `Bearer` token (Zapier OAuth tokens table). Sets `req.user`.
- `middleware/rateLimiter.ts` (public-doc / user-search / share limiters),
  `middleware/requireIntegration.ts`.

### Docs subsystem (`server/controllers/docs/`)
A full Notion/Confluence-style module: doc CRUD, hierarchical pages (`parentDocumentId`),
sharing + per-user permissions, email invites, public links (token, expiry, permission),
version history, trash (soft-delete/restore/permanent), templates, doc-spaces, comments, and
import from .docx/.pdf/.xlsx (`mammoth`, `pdf-parse`, `officeparser`, `xlsx`, `word-extractor`).
Each endpoint is its own file; `index.ts` re-exports handlers and wires routes in
`registerDocsRoutes()`. Real-time collaborative editing uses **Yjs / Hocuspocus** (`y-prosemirror`,
`y-protocols`).

### Integrations (`server/services/` + `server/routes/*-integration.routes.ts`)
- `services/tokenService.ts` — the shared, **encrypted** OAuth token vault keyed by
  `(userId, provider)` in the `user_integrations` table. `Provider` union lists supported services.
  Encryption helpers live in `services/slackService.ts` (`encryptToken`/`decryptToken`).
- Providers: **Slack** (OAuth, slash commands, interactivity, notifications, daily digest, deadline
  reminders — the most built-out), **GitHub** + webhooks, **Jira** + webhooks, Google **Drive** /
  **Calendar** / **Gmail**, Microsoft **Teams** / **Outlook email** / **Outlook calendar** /
  **OneDrive**, **Dropbox**, **Figma**, **Salesforce**, **Zapier** (platform + webhooks).
- Tasks can link to external artifacts: `task_github_links`, `task_jira_links`, `task_figma_links`,
  `task_calendar_events`, `task_email_links`, `task_drive_attachments`.

### Webhook HMAC — body parsing caveat
In `index.ts`/`handler.ts` the JSON/urlencoded `verify` hook stashes the **raw body** on `req.rawBody`
only for `/api/webhooks/*` and Slack command/interactivity paths (needed for HMAC signature checks).
If you add a webhook receiver that verifies signatures, its path must match those prefixes or you
must extend the `verify` allowlist.

### Workflow automation (`services/workflowEngine.ts`, `services/workflowCron.ts`)
Event-driven: task events (`task.created`, `task.status_changed`, `comment.added`, `task.overdue`,
…) are matched to saved workflows (`workflows` table) and run actions (change status, assign,
create subtask, comment, send email/Slack/notification). `evaluateWorkflows()` is called from task
handlers; `runWorkflowCron()` runs every 15m (standalone only). Note: the in-app notification action
is currently **stubbed to an activity-log entry** (notifications subsystem only partly migrated from
Nexus).

### Other services
- `services/writingAssistService.ts` + `routes/ai.routes.ts` — AI writing assist via **Groq SDK**.
- `server/objectStorage.ts` + `objectAcl.ts` — **Google Cloud Storage** for uploads (`multer`).
- `server/email.ts` / `services/emailService.ts` — `nodemailer` (verification, reset, 2FA, mentions,
  space invites).

### Scheduled jobs (standalone server only — see Dual runtime)
`index.ts` starts: workflow cron (15m), Slack deadline check (60m), Slack retry (5m), Slack daily
digest (24h).

## Conventions & gotchas
- `@shared/*` resolves to `./shared/*` — keep the tsconfig path and esbuild alias in sync.
- Many handlers live inline in the 3970-line `routes.ts`; new feature areas should prefer a
  dedicated `routes/<feature>.routes.ts` router mounted in `registerAllRoutes()`.
- Code comments are frequently in Hinglish/Urdu (e.g. "mein", "karo") — this is normal here.
- Secrets/config come from `.env` (see the OAuth client IDs/secrets, `DATABASE_URL`, `SESSION_SECRET`,
  `*_ENCRYPTION_KEY`, `GROQ_API_KEY`). Required at boot: `DATABASE_URL`, `SESSION_SECRET`.
- `APP_URL` / `FRONTEND_URL` / `ALLOWED_ORIGINS` drive OAuth redirects and the CORS allowlist
  (credentialed, cross-origin in production with `SameSite=None` cookies).
