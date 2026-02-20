# Node.js Multi-Tenant SaaS — Production Readiness Analysis

This document summarizes **architectural problems**, **security risks**, **suggested folder structure**, and a **step-by-step refactor plan**. It does **not** rewrite code; it provides a safe, incremental path to production readiness.

---

## 1. Architectural Problems

### 1.1 Monolithic `app.js`
- **~420 lines** in a single file: Express setup, auth middleware, business logic (scheduler, job executor, notification sending), and **all route handlers** live together.
- **Consequences**: Hard to test, hard to scale (e.g. moving scheduler to a worker), and any change risks breaking unrelated features.
- **Missing**: Clear separation between **routes** (HTTP), **controllers** (request/response), **services** (business logic), and **data access** (DB).

### 1.2 Mixed Auth Models
- **Two JWT-based auth flows**:
  - `auth` + `adminOnly` in `app.js`: used for `/api/history`, `/api/admin/*`, `/api/upload`, etc. `req.user` from JWT (`id`, `role`, `email`, `company_name`).
  - `authTenant` in `middleware/authTenant.js`: used for `/api/tenant/*`, `/api/jobs`; requires `decoded.role === "user"`.
- **`requireAdmin`** uses **`x-tenant-id` header** and DB lookup by `tenant_id`, while other admin routes use JWT `req.user.role`. Inconsistent and confusing; one admin path is header-based, the other token-based.
- **Google login** calls `findOrCreateTenant(email, name)` but **this function is never defined** → runtime error on `/api/google-login`.

### 1.3 Database / Schema Inconsistencies
- **`db.js` `initDB()`** creates `tenants` with only `id`, `name`, `created_at`. The app elsewhere assumes `tenants` has **`email`, `password`, `role`** (signup/login) and **`plan`, `jobs_used`, `job_limit`** (tenant routes). Either migrations ran outside this file or the app will fail in a fresh install.
- **`businesses`** table is created but **never used**; signup writes to **`tenants`** with `password` and `role`. So “tenant” and “business” are blurred.
- **`purchase_requests`** is used in `routes/tenant.js` but **never created** in `initDB()` → INSERT will fail at runtime.
- **`db.js`** exports `pool` and many helpers; it also **exports default `pool`** via `module.exports = pool` at the top and then **later** `module.exports = { pool, initDB, ... }`, so the default export is overwritten. Any `require('./db')` expecting the pool only might break if used before the export block.

### 1.4 Duplicate and Inconsistent Route Registration
- `app.use("/api", tenantRoutes)` is **registered twice** (lines 250–251).
- Some API routes are defined in `app.js` (e.g. `/api/google-login`, `/api/history`, `/api/upload`, `/api/signup`, `/api/login`, `/api/rules`, `/api/test-send`, `/api/tenant/upcoming-expiries`, `/api/admin/*`), others in `routes/tenant.js`. No single place that defines “all API routes”; mixing makes it easy to miss middleware or duplicate behavior.

### 1.5 Business Logic in Wrong Layers
- **Scheduler** (`runScheduler`) and **job executor** (`runJobExecutor`) run inside `app.listen` callback and via `setInterval`. They are **in-process** and block the same Node process as HTTP. For production you typically want these in a **separate worker** or job queue (e.g. Bull, Agenda).
- **Notification sending** (`sendNotification`), **template rendering** (`renderTemplate`), and **rule/job logic** are in `app.js` instead of a dedicated **notification service** and **scheduler service**.
- **Plans** are defined in **two places**: `plans.js` (free/starter/business with price in paise) and **inline** in `routes/tenant.js` (starter/business with different amounts). No single source of truth; payment flow doesn’t use `plans.js`.

### 1.6 No Centralized Error Handling
- Every route uses ad-hoc `try/catch` and `res.status(500).json({ error: ... })`. No global error middleware, no error classes, no consistent error codes or logging. Unhandled promise rejections could crash the process or leak stack traces.

### 1.7 No Input Validation
- Request bodies and query params are used **without validation** (e.g. `/api/signup`, `/api/login`, `/api/upload`, `/api/rules`, `/api/tenant/purchase`, CSV columns). Invalid or malicious input can cause DB errors, bad data, or injection-style issues (even with parameterized queries, type/length checks are missing).

### 1.8 Scalability and Configuration
- **Single DB pool** with no connection limits or timeouts documented; no read replicas or connection strategy for scaling.
- **CORS** is in `package.json` but **not used** in `app.js`; if a frontend on another origin calls the API, browsers may block requests.
- **No rate limiting** on login, signup, or payment-related endpoints.

---

## 2. Security Risks

### 2.1 Critical
- **Missing `findOrCreateTenant`**: `/api/google-login` will throw and may expose stack traces if unhandled.
- **`purchase_requests` table missing**: Purchase flow will throw on INSERT; no schema for payment state.
- **Tenant schema mismatch**: If `tenants` doesn’t have `email`, `password`, `role`, `plan`, `jobs_used`, `job_limit`, signup/login and tenant features will fail or behave unpredictably.

### 2.2 High
- **No payment verification**: `/api/tenant/purchase` only inserts a row; there is **no Razorpay (or other gateway) integration**, no idempotency key, and **no webhook** to confirm payment before upgrading plan. Risk of “pay without paying” or inconsistent plan state.
- **Weak auth surface**: Login returns JWT with long expiry (1d); no refresh tokens, no revocation. Stolen token gives full access until expiry. Admin vs tenant is only role-based; no extra checks (e.g. tenant_id in JWT vs resource).
- **Passwords**: bcrypt is used (good), but no minimum length or complexity enforced at API level; signup accepts any string.

### 2.3 Medium
- **No request validation**: Body/query/params not validated/sanitized; possible DoS (huge payloads), bad data, or unexpected types causing 500s.
- **CSV upload**: No limit on file size (beyond multer default), no strict column whitelist; `meta: row` stores full row (could store unexpected keys). No virus/scan consideration for production.
- **Error messages**: Some responses may leak internal details (e.g. `err.message`); no sanitization for production.
- **CORS**: Not configured; default behavior may be too open or too strict depending on environment.
- **Secrets**: `JWT_SECRET` and DB URL must be in env; ensure `.env` is in `.gitignore` and not committed (no `.env.example` present to document required vars).

### 2.4 Lower
- **Admin routes**: Only protected by JWT `role === 'admin'`; no audit log, no IP or device binding.
- **Template rendering**: `renderTemplate` does simple `{{ var }}` substitution; if template comes from DB, ensure no user-controlled script injection (e.g. if template ever includes HTML and is sent to clients).

---

## 3. Clean Folder Structure Suggestion

Target layout **without** moving everything at once (you can grow into this):

```
project/
├── .env.example
├── package.json
├── server.js                 # Entry: load env, init DB, start HTTP + optional worker
├── app.js                    # Express app only (no listen): middleware + route mounting
│
├── config/
│   └── index.js              # Env validation, constants (e.g. JWT expiry, limits)
│
├── middleware/
│   ├── auth.js               # JWT auth (single place), attach req.user
│   ├── authTenant.js         # Optional: thin wrapper that requires role === 'user'
│   ├── errorHandler.js       # Central 4-arg error middleware
│   ├── validateRequest.js    # Wrapper around validation (e.g. express-validator)
│   └── rateLimit.js         # Optional: rate limit for auth/payment
│
├── routes/
│   ├── index.js              # Aggregator: mount auth, admin, tenant, public routes
│   ├── auth.js               # POST /login, /signup, /google-login
│   ├── admin.js              # GET /admin/stats, /admin/tenants (adminOnly)
│   ├── tenant.js             # Tenant stats, jobs, purchase (authTenant)
│   ├── rules.js              # POST /rules, GET (if any)
│   ├── customers.js          # Upload CSV, upcoming-expiries, test-send, history
│   └── health.js             # GET /health
│
├── controllers/
│   ├── authController.js
│   ├── adminController.js
│   ├── tenantController.js
│   ├── rulesController.js
│   ├── customersController.js
│   └── healthController.js
│
├── services/
│   ├── authService.js        # login, signup, findOrCreateTenant, issueToken
│   ├── tenantService.js      # getStats, createJob, createPurchaseRequest
│   ├── notificationService.js # sendNotification, renderTemplate
│   ├── schedulerService.js   # runScheduler (creates jobs)
│   ├── jobExecutorService.js # runJobExecutor (processes pending jobs)
│   └── paymentService.js    # createOrder, verifyWebhook, activatePlan (when ready)
│
├── db/                       # or "repositories" / "data"
│   ├── index.js              # pool, initDB
│   ├── tenants.js            # tenant CRUD, findOrCreate
│   ├── customers.js
│   ├── rules.js
│   ├── jobs.js
│   └── migrations/           # Optional: versioned SQL or migrate lib
│       └── 001_tenant_plan_columns.sql
│
├── lib/
│   ├── plans.js              # Single source of truth for plans (used by payment + UI)
│   └── errors.js             # AppError, error codes, map to HTTP status
│
├── public/
├── admin/
└── (tests when added)
```

**Principles**: Routes only call controllers; controllers call services; services use db/ and lib. No business logic in routes; no raw pool in controllers (only in db layer or services that need it).

---

## 4. Step-by-Step Refactor Plan (Non-Breaking)

Follow in order; each step keeps existing endpoints working.

### Phase A — Fix Blockers and Schema (Do First)

| Step | Action | Why |
|------|--------|-----|
| A1 | **Define `findOrCreateTenant`** (e.g. in `app.js` or a new `services/authService.js`): lookup tenant by email; if not found, INSERT and return. Use same `tenants` table and ensure it has `email` (and optionally `name`). | Prevents `/api/google-login` from crashing. |
| A2 | **Align DB schema with code**: In `initDB()` (or a migration), add to `tenants`: `email` (UNIQUE), `password` (nullable for Google-only), `role`, `plan`, `jobs_used`, `job_limit`, and create `purchase_requests(tenant_id, plan, amount, payment_method, status, created_at, ...)`. Remove or document `businesses` usage. | Prevents signup/login and tenant/purchase from failing. |
| A3 | **Fix `db.js` export**: Use a single `module.exports = { pool, initDB, insertCustomer, ... }` and remove the early `module.exports = pool`. | Avoids subtle bugs for anyone requiring `db` as default. |

### Phase B — Centralized Error Handling and Validation

| Step | Action | Why |
|------|--------|-----|
| B1 | **Add error middleware**: Create `middleware/errorHandler.js` (4-arg function). In production, don’t send stack or internal messages. Attach it **after** all routes. In each route, replace `res.status(500).json(...)` with `next(err)` (or throw in an async route and let a wrapper call `next(err)`). | Consistent errors and no stack leaks. |
| B2 | **Introduce validation**: Add e.g. `express-validator`. Create validation schemas for `/api/signup`, `/api/login`, `/api/rules`, `/api/tenant/purchase`, and CSV (max size, required columns). Return 400 with clear messages when validation fails. | Safer input and better UX. |
| B3 | **Optional**: Add `lib/errors.js` with `AppError` (status, code, message) and use it in services; error handler maps it to JSON. | Cleaner error handling in code. |

### Phase C — Extract Services (Logic Out of app.js)

| Step | Action | Why |
|------|--------|-----|
| C1 | **Notification service**: Move `renderTemplate` and `sendNotification` into `services/notificationService.js`. Require it in `app.js` and call it from the current route/handler and from the job executor. | Reusable and testable; single place for SendGrid/Twilio. |
| C2 | **Scheduler and executor**: Move `runScheduler` and `runJobExecutor` into `services/schedulerService.js` and `services/jobExecutorService.js`. Keep calling them from `app.listen` for now (no process split yet). | Prep for moving to a worker later. |
| C3 | **Auth service**: Add `services/authService.js` with `findOrCreateTenant`, and optionally `login`, `signup`, `issueToken`. Use it from `/api/google-login` (and later from auth routes). | Fixes Google login and centralizes auth logic. |
| C4 | **Tenant service**: Add `services/tenantService.js` for getStats, createJob (with limit check), createPurchaseRequest. Use it from `routes/tenant.js`. | Keeps routes thin and logic testable. |

### Phase D — Controllers and Routes (Service–Controller Split)

| Step | Action | Why |
|------|--------|-----|
| D1 | **Health**: Move `/health` to `routes/health.js` + minimal controller that calls DB and returns JSON. Mount at `/health`. | Template for other routes. |
| D2 | **Auth routes**: Create `routes/auth.js` and `controllers/authController.js`. Move `/api/signup`, `/api/login`, `/api/google-login` into controller methods; controller calls authService. Mount under `/api`. | Clear auth boundary. |
| D3 | **Admin routes**: Create `routes/admin.js` and `controllers/adminController.js`. Move `/api/admin/stats` and `/api/admin/tenants`; keep `auth` + `adminOnly`. Mount under `/api`. | Same pattern as auth. |
| D4 | **Tenant routes**: Keep `routes/tenant.js` but have it call a **tenantController** that uses **tenantService** (and optionally paymentService). Remove duplicate `app.use("/api", tenantRoutes)`. | One mount; logic in controller/service. |
| D5 | **Customers/rules/history**: Create `routes/customers.js` and `routes/rules.js` (or one “api” router). Move upload, upcoming-expiries, test-send, history, and rules CRUD into controllers that use services/db. Mount under `/api`. | Completes route/controller split. |
| D6 | **Route aggregator**: Add `routes/index.js` that mounts auth, admin, tenant, customers, rules, health. In `app.js`, use only `app.use('/api', require('./routes'))` (and public/admin static). | Single place for API structure. |

### Phase E — Payment and Security Hardening

| Step | Action | Why |
|------|--------|-----|
| E1 | **Single plans source**: Use `lib/plans.js` everywhere (tenant purchase, UI). Remove inline plan object from `routes/tenant.js`; add `plan` validation against `plans.js` keys. | Consistent pricing and limits. |
| E2 | **Purchase flow safety**: (a) Add idempotency key (e.g. client sends `Idempotency-Key`; store and reject duplicates). (b) When integrating Razorpay: create order in paymentService, return order_id to client; add **webhook** that verifies signature, then updates `purchase_requests` and tenant `plan`/`job_limit`. Never upgrade plan on client-only action. | Prevents double upgrades and fraud. |
| E3 | **CORS**: Add `cors` middleware in `app.js` with explicit origin(s) (or env-based whitelist). | Safe cross-origin requests. |
| E4 | **Rate limiting**: Add rate limit (e.g. `express-rate-limit`) for `/api/login`, `/api/signup`, and `/api/tenant/purchase`. | Mitigates brute force and abuse. |
| E5 | **JWT**: Consider shorter expiry and refresh token; store refresh tokens if you need revocation. Document required env in `.env.example`. | Reduces impact of token theft. |

### Phase F — Data Layer and Optional Worker

| Step | Action | Why |
|------|--------|-----|
| F1 | **DB module split**: Keep one `db/index.js` that exports `pool` and `initDB`. Move `insertCustomer`, `createRule`, `getActiveRules`, job helpers into `db/customers.js`, `db/rules.js`, `db/jobs.js`, and tenant helpers into `db/tenants.js`. Services require from `db/*`. | Clear data layer; easier to add caching or replicas later. |
| F2 | **Migrations**: Add a simple migrations folder or use a small library. New schema changes (e.g. `purchase_requests`, tenant columns) go in migrations; `initDB` only ensures base tables or runs migrations. | Safe, repeatable schema updates. |
| F3 | **Optional**: Move scheduler + job executor to a separate Node process or worker (e.g. `worker.js`) that shares config and DB, or use a job queue (Bull/Agenda) with Redis. Keep HTTP in `server.js`. | Better scalability and reliability. |

---

## 5. Summary Table

| Area | Current issue | Refactor direction |
|------|----------------|--------------------|
| **Architecture** | Monolithic app, mixed auth, logic in routes | Service–controller–routes + single auth model |
| **DB** | Schema mismatch, missing tables, duplicate/confusing exports | Align schema, add migrations, split db/ modules |
| **Errors** | Ad-hoc 500s, possible stack leak | Central error middleware + AppError |
| **Validation** | None | express-validator (or similar) on all inputs |
| **Payment** | No gateway, no webhook, no idempotency | Plans from lib, Razorpay + webhook, idempotency |
| **Security** | CORS unused, no rate limit, long-lived JWT | CORS, rate limit, optional refresh tokens |
| **Scalability** | Scheduler/executor in same process | Extract services first, then optional worker/queue |

Implementing **Phase A** first unblocks the app; **B** and **C** improve safety and structure without changing URLs or behavior. **D** and **E** complete the architecture and payment safety; **F** sets you up for scale. Do **not** rewrite everything at once; migrate one route or one service at a time and keep tests or manual checks after each step.
