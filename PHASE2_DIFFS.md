# Phase 2 — Service Extraction (Diffs Summary)

Internal refactor only. No endpoint, response, schema, or frontend changes.

---

## 1. New files (no diff; full content)

### services/authService.js
- **findOrCreateTenant(email, name)** — lookup by email, insert if missing, return tenant row
- **signup(company_name, email, password)** — bcrypt hash, insert into tenants
- **login(email, password)** — find user, bcrypt compare, return `{ token, role, company_name }` or throw USER_NOT_FOUND / INVALID_PASSWORD
- **issueToken(tenant)** — JWT sign with id, role, email, company_name, 1d expiry

### services/notificationService.js
- **renderTemplate(tpl, vars)** — `{{ key }}` substitution
- **sendNotification(job)** — email via SendGrid or SMS via Twilio; returns provider message id
- Inits SendGrid/Twilio from `process.env` (same as former app.js)

### services/schedulerService.js
- **runScheduler()** — getActiveRules, for each rule load customers, create pending jobs (jobExists + createJob from db)

### services/jobExecutorService.js
- **runJobExecutor()** — getPendingJobs(50), for each job sendNotification then markJobSent/markJobFailed

### services/tenantService.js
- **getStats(tenantId)** — plan, jobs_used, job_limit, failed_jobs from tenants
- **getJobLogs(tenantId)** — last 50 jobs (channel, recipient, status, created_at)
- **createJobWithLimitCheck(tenantId, channel, recipient, message)** — check limit, insert job, increment jobs_used; throws LIMIT_EXCEEDED / TENANT_NOT_FOUND

### services/paymentService.js
- **createPurchaseRequest(tenantId, plan, payment_method)** — validate plan and method, insert purchase_requests (same amounts as before: 999, 3999)
- **getPlan(planKey)** — returns plan config (used internally)

---

## 2. app.js — Diffs

### Removed
- `require('@sendgrid/mail')`, `require('twilio')`, `require('bcrypt')`
- SendGrid setApiKey and Twilio client setup
- `getActiveRules`, `jobExists`, `createJob`, `getPendingJobs`, `markJobFailed` from db require (only pool, initDB, insertCustomer, createRule, markJobSent kept)
- `renderTemplate()` function
- `sendNotification()` function
- `runScheduler()` function
- `runJobExecutor()` function
- Inline `findOrCreateTenant()` function

### Added
- `const authService = require('./services/authService')`
- `const notificationService = require('./services/notificationService')`
- `const schedulerService = require('./services/schedulerService')`
- `const jobExecutorService = require('./services/jobExecutorService')`

### Replaced
- **POST /api/google-login** — uses `authService.findOrCreateTenant(email, name)` and `authService.issueToken(tenant)`; response shape unchanged: `{ token, role, company_name }`
- **POST /api/signup** — uses `authService.signup(company_name, email, password)`; response unchanged: `{ success: true }`
- **POST /api/login** — uses `authService.login(email, password)`; on throw sends 400 with "User not found" or "Invalid password"; response unchanged: `{ token, role, company_name }`
- **POST /api/test-send** — uses `notificationService.sendNotification(fakeJob)`; response unchanged: `{ success: true, providerId }`
- **app.listen callback** — calls `schedulerService.runScheduler()` and `jobExecutorService.runJobExecutor()` (and setIntervals same as before)

---

## 3. routes/tenant.js — Diffs

### Removed
- `const { pool } = require("../db")`
- All direct `pool.query` usage in the four handlers

### Added
- `const tenantService = require("../services/tenantService")`
- `const paymentService = require("../services/paymentService")`

### Replaced
- **GET /tenant/stats** — `tenantService.getStats(req.user.id)`; response unchanged: single stats object
- **GET /jobs** — `tenantService.getJobLogs(req.user.id)`; response unchanged: array of job rows
- **POST /jobs** — `tenantService.createJobWithLimitCheck(req.user.id, channel, recipient, message)`; 403 on LIMIT_EXCEEDED, 404 on TENANT_NOT_FOUND; response unchanged: `{ success: true, job_id }`
- **POST /tenant/purchase** — `paymentService.createPurchaseRequest(req.user.id, plan, payment_method)`; 400 on invalid plan/method; response unchanged: `{ success: true, message: "..." }`

---

## 4. Endpoints & responses (unchanged)

| Method | Path | Response shape |
|--------|------|----------------|
| POST | /api/google-login | `{ token, role, company_name }` |
| POST | /api/signup | `{ success: true }` |
| POST | /api/login | `{ token, role, company_name }` |
| GET | /api/tenant/stats | `{ plan, jobs_used, job_limit, failed_jobs }` |
| GET | /api/jobs | `[{ channel, recipient, status, created_at }, ...]` |
| POST | /api/jobs | `{ success: true, job_id }` |
| POST | /api/tenant/purchase | `{ success: true, message }` |
| POST | /api/test-send | `{ success: true, providerId }` |

No database schema changes. No frontend changes.
