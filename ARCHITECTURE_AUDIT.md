# Expiry Notifier — Full Architecture Audit & Migration Plan

**Scope:** Multi-tenant Node.js SaaS (JWT, Google login, CSV upload, scheduled reminders, Email/SMS, usage limits, manual UPI upgrade, tenant dashboard, home pricing).  
**Constraints:** No full rewrite; no breaking of endpoints or frontend; incremental upgrades only.

---

## 1. Architecture Problems

### 1.1 Structural Issues

| Issue | Location | Detail |
|-------|----------|--------|
| **Monolithic app.js** | `app.js` (~420 lines) | Express setup, auth middleware, scheduler, job executor, notification sending, and all route handlers in one file. Hard to test, scale, or change safely. |
| **No layer separation** | Entire app | Routes, business logic, and data access are mixed. No clear controllers → services → db boundary. |
| **Duplicate route mount** | `app.js` L249–251 | `app.use("/api", tenantRoutes)` is registered twice. |
| **Scattered API surface** | `app.js` + `routes/tenant.js` | No single manifest of API routes; some in app.js (auth, upload, rules, history, admin, upcoming-expiries), others in tenant.js (stats, jobs, purchase). |
| **Two job models, one table** | `db.js` jobs table + `routes/tenant.js` | (1) Rule-based jobs: `customer_id`, `rule_id`, `scheduled_at`; executor joins `customers` for email/phone. (2) Tenant “send now” jobs: INSERT with `channel`, `recipient`, `message`, `status` only — but schema has `customer_id INT NOT NULL`, so this INSERT can fail unless schema was manually altered. GET /api/jobs expects `recipient`, `message` (nullable for rule-based rows). |
| **Plans defined twice** | `plans.js` vs `routes/tenant.js` | `plans.js`: free/starter/business, price in **paise** (99900, 399900). `routes/tenant.js`: inline object with amounts 999, 3999 (rupees). Payment flow does not use `plans.js`. |
| **Dead / inconsistent code** | `app.js` | `requireAdmin` (x-tenant-id + `tenants.tenant_id` which does not exist; tenants use `id`) is defined but never used. Admin routes use `auth` + `adminOnly` only. |
| **Google login response mismatch** | `app.js` + `public/index.html` | Backend returns `{ tenant_id: tenant.id }`; frontend expects `data.token` and `data.company_name` and only then stores token and reloads. So Google login never logs the user in on the frontend. |
| **Missing endpoint** | Frontend | `index.html` calls `POST /api/send-now`; this route does not exist in app.js → 404. |
| **authTenant vs auth** | app vs routes/tenant | `auth` (app.js): any valid JWT, sets `req.user`. `authTenant`: requires `decoded.role === "user"`. Admin users (role `admin`) would be rejected from tenant routes. Intent is clear but two middleware names and two files for “who is the user” is confusing. |

### 1.2 Security Risks

| Risk | Severity | Detail |
|------|----------|--------|
| **findOrCreateTenant missing** | **Critical** | `/api/google-login` calls `findOrCreateTenant(email, name)` which is **not defined** anywhere → runtime error on Google login; possible stack trace to client. |
| **Tenants schema vs usage** | **Critical** | `initDB()` creates `tenants` with only `id`, `name`, `created_at`. Code assumes `email`, `password`, `role` (signup/login) and `plan`, `jobs_used`, `job_limit` (tenant stats, limits, purchase). Fresh install will fail or behave unpredictably. |
| **purchase_requests table missing** | **Critical** | `routes/tenant.js` INSERTs into `purchase_requests`; table is **never created** in `initDB()` → runtime error on purchase. |
| **No payment verification** | **High** | `/api/tenant/purchase` only inserts a row. No Razorpay (or other gateway), no webhook, no idempotency. Plan is never upgraded automatically; “payment” is trust-based. Risk of abuse and inconsistent state. |
| **JWT long-lived, no revocation** | **High** | 1d expiry; no refresh tokens or revocation. Stolen token = full access until expiry. |
| **Passwords** | **Medium** | bcrypt used (good); no min length or complexity at API level. |
| **No rate limiting** | **Medium** | Login, signup, purchase, and upload are not rate-limited → brute force and abuse. |
| **CORS unused** | **Medium** | `cors` in package.json but not applied in app.js. Cross-origin frontends may be blocked or overly permissive by default. |
| **Error and body handling** | **Medium** | Some responses use `err.message`; no global error middleware; no request body validation (DoS, bad data). |
| **CSV upload** | **Medium** | No file size limit (beyond multer default), no column whitelist; `meta: row` stores full row. No virus/scan for production. |
| **Secrets** | **Low** | No `.env.example` documenting required vars (JWT_SECRET, DATABASE_URL, SendGrid, Twilio, Google client ID). |

### 1.3 Scaling Risks

| Risk | Detail |
|------|--------|
| **Scheduler + executor in-process** | `runScheduler()` and `runJobExecutor()` run in the same Node process as HTTP (inside `app.listen` + setInterval). Under load, long-running job loops can block the event loop and delay requests. |
| **No job queue** | Pending jobs are read from DB and processed in a loop. No backpressure, no retries beyond marking failed, no distributed worker. |
| **Single DB pool** | One pool, no documented limits/timeouts; no read replicas or connection strategy. |
| **N+1 in scheduler** | For each rule, all customers are loaded; for each customer × lead_days × channels, `jobExists` and `createJob` are called individually → many round-trips. |

### 1.4 Data Consistency Problems

| Problem | Detail |
|--------|--------|
| **Tenants table** | Schema in code (email, password, role, plan, jobs_used, job_limit) not created in initDB; no single migration path. |
| **businesses table** | Created in initDB but never used; signup uses `tenants`. Confusing naming and unused table. |
| **jobs table** | Two usage patterns (rule-based with customer_id/rule_id vs tenant “instant” with recipient/message). `customer_id NOT NULL` makes tenant INSERT invalid unless schema was altered. Unique index on (tenant_id, customer_id, rule_id, channel, scheduled_at) can conflict with jobs that have no rule_id/customer_id. |
| **jobs_used increment** | In `routes/tenant.js`, `jobs_used` is incremented on POST /jobs (instant send). Rule-based expiry jobs (created by scheduler, sent by executor) are **not** counted toward `jobs_used` in current code → usage limits apply only to one path. |
| **db.js export** | Early `module.exports = pool` (L16) then later `module.exports = { pool, initDB, ... }`. Final export is the object; any code that did `const pool = require('./db')` expecting the default as pool could break if such usage exists. |

### 1.5 Payment Flow Weaknesses

| Weakness | Detail |
|----------|--------|
| **No gateway** | Razorpay in package.json but not used. Manual UPI/bank only; no server-side payment confirmation. |
| **No idempotency** | Duplicate “Proceed” clicks or retries can create multiple purchase_requests. |
| **Plan upgrade is manual** | No webhook or cron to move `purchase_requests` → tenant plan/job_limit. Admin must do it out-of-band. |
| **Plans mismatch** | plans.js (paise) vs tenant route (rupees); payment flow doesn’t use plans.js. |

---

## 2. Risk Assessment Table

| # | Item | Severity | Category |
|---|------|----------|----------|
| 1 | findOrCreateTenant undefined → Google login crash | **Critical** | Security / Correctness |
| 2 | tenants table missing email, password, role, plan, jobs_used, job_limit | **Critical** | Data / Schema |
| 3 | purchase_requests table missing | **Critical** | Data / Schema |
| 4 | Google login response: no JWT returned → frontend never logs in | **Critical** | Correctness |
| 5 | No payment verification; plan never auto-upgraded | **High** | Security / Payment |
| 6 | JWT long-lived, no revocation | **High** | Security |
| 7 | POST /api/jobs (tenant) may fail (customer_id NOT NULL) | **High** | Data / Schema |
| 8 | jobs_used not incremented for scheduler/executor jobs | **High** | Consistency |
| 9 | No rate limiting on auth/payment/upload | **Medium** | Security |
| 10 | No CORS configuration | **Medium** | Security |
| 11 | No request/body validation | **Medium** | Security / Robustness |
| 12 | No global error handler; possible stack leak | **Medium** | Security / Ops |
| 13 | Scheduler/executor in same process as HTTP | **Medium** | Scaling |
| 14 | Two plans sources (plans.js vs inline) | **Medium** | Consistency |
| 15 | Duplicate app.use("/api", tenantRoutes) | **Low** | Structure |
| 16 | POST /api/send-now missing (frontend calls it) | **Low** | Correctness |
| 17 | requireAdmin dead code + wrong column name | **Low** | Structure |

---

## 3. Proposed Production Folder Structure

Target layout to grow into **incrementally** (no big-bang move):

```
project/
├── .env.example
├── package.json
├── server.js                    # Entry: load env, init DB, start HTTP (and optionally start worker)
├── app.js                       # Express app only (no listen): middleware + route mounting
│
├── config/
│   └── index.js                 # Env validation, constants (JWT expiry, limits, plan keys)
│
├── middleware/
│   ├── auth.js                  # Single JWT auth: verify token, set req.user
│   ├── authTenant.js            # Optional: require req.user.role === 'user'
│   ├── adminOnly.js             # Require req.user.role === 'admin'
│   ├── errorHandler.js          # Central 4-arg error middleware
│   ├── validateRequest.js       # Wrapper for express-validator (or similar)
│   └── rateLimit.js             # Rate limit for auth / payment / upload
│
├── routes/
│   ├── index.js                 # Aggregator: mount auth, admin, tenant, rules, customers, health
│   ├── auth.js                  # POST /login, /signup, /google-login
│   ├── admin.js                 # GET /admin/stats, /admin/tenants (auth + adminOnly)
│   ├── tenant.js                 # /tenant/stats, /jobs, /tenant/purchase, /tenant/upcoming-expiries
│   ├── rules.js                 # POST /rules (and GET if needed)
│   ├── customers.js              # POST /upload, GET /history, POST /test-send
│   └── health.js                 # GET /health
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
│   ├── authService.js           # login, signup, findOrCreateTenant, issueToken
│   ├── tenantService.js          # getStats, createJob (with limit), createPurchaseRequest
│   ├── notificationService.js  # sendNotification, renderTemplate
│   ├── schedulerService.js     # runScheduler (create reminder jobs)
│   ├── jobExecutorService.js   # runJobExecutor (process pending jobs)
│   └── paymentService.js       # createOrder, verifyWebhook, activatePlan (when ready)
│
├── db/
│   ├── index.js                 # pool, initDB (and run migrations)
│   ├── tenants.js               # tenant CRUD, findOrCreate
│   ├── customers.js             # insertCustomer, etc.
│   ├── rules.js                 # createRule, getActiveRules
│   ├── jobs.js                  # jobExists, createJob, getPendingJobs, markJobSent, markJobFailed
│   └── migrations/              # Versioned SQL or migrate runner
│       └── 001_tenant_auth_plan.sql
│       └── 002_purchase_requests.sql
│
├── jobs/                        # Optional: entrypoint for worker process
│   └── worker.js                # run scheduler + executor (same code as services, different process)
│
├── lib/
│   ├── plans.js                 # Single source of truth (used by payment + UI + limits)
│   └── errors.js                # AppError, map to HTTP status
│
├── utils/
│   └── template.js              # renderTemplate (or keep in notificationService)
│
├── public/
├── admin/
└── (tests when added)
```

**Principles:** Routes → controllers → services; services use db/ and lib. No business logic in routes; no raw pool in controllers. Same URL paths and response shapes to preserve frontend compatibility.

---

## 4. Non-Breaking Phased Migration Plan

### Phase 1 — Stabilize & Secure

| Step | Action | Preserves |
|------|--------|-----------|
| 1.1 | **Define findOrCreateTenant** in app.js (or new services/authService.js): lookup tenant by email; if not found INSERT (name, email, role='user') and return. Ensure tenants has `email` (and `name`) — add columns in initDB or migration. | All existing endpoints |
| 1.2 | **Google login response:** After findOrCreateTenant, call same JWT issue logic as login (e.g. `jwt.sign({ id, role, email, company_name }, JWT_SECRET, { expiresIn: '1d' })`) and return `{ token, role, company_name }` so frontend can store token and reload. | Frontend handleGoogleLogin |
| 1.3 | **Align tenants schema:** In initDB (or a migration), add to tenants: `email` UNIQUE, `password` (nullable), `role`, `plan`, `jobs_used`, `job_limit` (with sensible defaults). Remove or document `businesses`; keep signup/login writing to tenants. | Signup, login, tenant stats, limits |
| 1.4 | **Create purchase_requests:** Add table (tenant_id, plan, amount, payment_method, status, created_at, etc.) in initDB or migration. | POST /api/tenant/purchase |
| 1.5 | **Fix db.js export:** Remove early `module.exports = pool`; keep single `module.exports = { pool, initDB, ... }`. | Any require('./db') |
| 1.6 | **Optional:** Add `.env.example` with JWT_SECRET, DATABASE_URL, SENDGRID_*, TWILIO_*, GOOGLE_CLIENT_ID. | Ops |

Do not remove or rename any route or change response shapes in Phase 1.

---

### Phase 2 — Extract Services

| Step | Action | Preserves |
|------|--------|-----------|
| 2.1 | **Auth service:** Create services/authService.js with findOrCreateTenant, login, signup, issueToken. Use from /api/google-login, /api/login, /api/signup (move handler body into service calls). | All auth URLs and responses |
| 2.2 | **Notification service:** Move renderTemplate and sendNotification to services/notificationService.js. Require in app.js; use in job executor and in /api/test-send. | /api/test-send, executor behavior |
| 2.3 | **Scheduler / executor services:** Move runScheduler to services/schedulerService.js and runJobExecutor to services/jobExecutorService.js. Keep starting them from app.listen (same process). | Schedule and send behavior |
| 2.4 | **Tenant service:** Create services/tenantService.js (getStats, createJob with limit check, createPurchaseRequest). Have routes/tenant.js call tenantService instead of pool directly. | /api/tenant/stats, /api/jobs, /api/tenant/purchase |
| 2.5 | **Single plans source:** Use lib/plans.js in routes/tenant.js for plan keys and amounts (convert paise to rupees for API if needed). Remove inline plan object from tenant route. | Response shape; frontend pricing |

Still no URL or response shape changes; no new route files required yet.

---

### Phase 3 — Introduce Controllers

| Step | Action | Preserves |
|------|--------|-----------|
| 3.1 | **Health:** Move GET /health to routes/health.js + controllers/healthController.js. Mount at /health. | /health |
| 3.2 | **Auth routes:** Create routes/auth.js + controllers/authController.js. Move POST /api/signup, /api/login, /api/google-login into controller; controller calls authService. Mount under /api (e.g. app.use('/api', authRoutes)). Remove these handlers from app.js. | All auth URLs and responses |
| 3.3 | **Admin routes:** Create routes/admin.js + controllers/adminController.js. Move GET /api/admin/stats and /api/admin/tenants; keep auth + adminOnly. Mount under /api. Remove from app.js. | /api/admin/* |
| 3.4 | **Tenant routes:** Keep routes/tenant.js; introduce tenantController that uses tenantService. Route handlers become one-liners calling controller. Remove duplicate app.use("/api", tenantRoutes). | /api/tenant/*, /api/jobs |
| 3.5 | **Customers / rules / history:** Create routes/customers.js and routes/rules.js (or one combined api router). Move /api/upload, /api/history, /api/tenant/upcoming-expiries, /api/test-send and /api/rules into controllers. Mount under /api. Remove from app.js. | All existing paths |
| 3.6 | **Route aggregator:** Add routes/index.js that mounts auth, admin, tenant, customers, rules, health. In app.js use single app.use('/api', require('./routes')) (and static for public/admin). | Full API surface |

URLs and response bodies stay the same.

---

### Phase 4 — Proper Payment Handling

| Step | Action | Preserves |
|------|--------|-----------|
| 4.1 | **Idempotency:** For POST /api/tenant/purchase, accept optional Idempotency-Key header; store in purchase_requests or a small idempotency table; reject duplicate key with 409 and same body. | Frontend can send key; old clients unchanged |
| 4.2 | **Razorpay (optional):** In paymentService create order via Razorpay; return order_id/amount to client for checkout. Add POST /api/webhooks/razorpay (no JWT) that verifies signature and updates purchase_requests + tenant plan/job_limit. Keep manual UPI flow as fallback (create purchase_request, admin activates later). | Backward compatible; manual flow still works |
| 4.3 | **Activate plan:** When payment is verified (webhook or admin action), set tenant.plan and tenant.job_limit from plans.js; optionally reset jobs_used on cycle. | Tenant stats and limit enforcement |
| 4.4 | **Usage consistency:** When executor marks a job as sent (or failed), increment tenant jobs_used (or do it in one place when creating the job) so both “instant” jobs and scheduler jobs count toward limits. | Fair usage and correct limits |

Do not remove manual UPI path until Razorpay (or alternative) is fully tested.

---

### Phase 5 — Background Worker Separation

| Step | Action | Preserves |
|------|--------|-----------|
| 5.1 | **Config:** Move scheduler/executor interval and concurrency to config (or env). | Same behavior, configurable |
| 5.2 | **Worker entrypoint:** Add jobs/worker.js (or server-worker.js) that connects to DB and runs only scheduler + executor in a loop (no Express). Keep app.js as HTTP-only. | Same DB and job semantics |
| 5.3 | **Start options:** Either run `node server.js` (HTTP only) and `node jobs/worker.js` (worker only), or keep current single-process behavior as default and document worker as optional. | No breaking change; gradual move |
| 5.4 | **Optional:** Introduce a job queue (e.g. Bull with Redis) so executor pulls from queue instead of polling DB; scheduler pushes to queue. | Can be done after 5.2 |

HTTP API and responses unchanged.

---

### Phase 6 — Production Hardening

| Step | Action | Preserves |
|------|--------|-----------|
| 6.1 | **Error middleware:** Add middleware/errorHandler.js (4-arg); in handlers use next(err) instead of res.status(500).json(...). In production do not send stack or internal messages. | Same error codes and safe bodies |
| 6.2 | **Validation:** Add express-validator (or similar) for /api/signup, /api/login, /api/rules, /api/tenant/purchase, and CSV (max size, required columns). Return 400 with clear messages. | Stricter input; same success responses |
| 6.3 | **Rate limiting:** Apply rate limit to /api/login, /api/signup, /api/tenant/purchase, /api/upload. | Same behavior under limit |
| 6.4 | **CORS:** Add cors middleware with explicit origin(s) or env-based whitelist. | Controlled cross-origin access |
| 6.5 | **JWT:** Consider shorter expiry and refresh token; document in .env.example. | Optional; existing clients keep working with current expiry |
| 6.6 | **Missing endpoint:** Implement POST /api/send-now (e.g. “run executor once” or “send all pending for this tenant now”) or remove from frontend. Prefer implementing so “Send All Now” works. | Frontend sendNowDemo() |

---

## 5. Step-by-Step Upgrade Roadmap (Summary)

1. **Phase 1 – Stabilize & secure:** Fix Google login (findOrCreateTenant + return JWT), align tenants schema, add purchase_requests, fix db export. No route or response changes.
2. **Phase 2 – Extract services:** Auth, notification, scheduler, executor, tenant, plans in one place. Logic moves out of app.js and routes; URLs unchanged.
3. **Phase 3 – Controllers:** Health, auth, admin, tenant, customers, rules in separate route/controller files; single route aggregator. Same API surface.
4. **Phase 4 – Payment:** Idempotency, optional Razorpay + webhook, plan activation, consistent jobs_used for both job types. Manual UPI retained.
5. **Phase 5 – Worker:** Optional separate process for scheduler + executor; same DB and job semantics.
6. **Phase 6 – Hardening:** Global error handler, validation, rate limiting, CORS, optional JWT tightening, implement or remove /api/send-now.

**Do not:** rewrite the entire project, delete working endpoints, or break frontend compatibility. Migrate one route or one service at a time and verify after each step.
