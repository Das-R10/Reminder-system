// app.js — Phase 5 (lean bootstrap, no business logic)
require('dotenv').config();
const express = require('express');
const path    = require('path');

const { initDB }             = require('./db');
const schedulerService       = require('./services/schedulerService');
const jobExecutorService     = require('./services/jobExecutorService');

const PORT = process.env.PORT || 3000;
if (!process.env.JWT_SECRET) { console.error('❌ JWT_SECRET missing'); process.exit(1); }

async function start() {
  await initDB();

  const app = express();
  app.use(express.json());
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
  app.use('/',      express.static(path.join(__dirname, 'public')));
  app.use('/admin', express.static(path.join(__dirname, 'admin')));

  // ── Route modules ────────────────────────────────────────────────────────────
  app.use('/api',       require('./routes/auth'));      // public + shared tenant actions
  app.use('/api',       require('./routes/tenant'));    // tenant dashboard endpoints
  app.use('/api/admin', require('./routes/admin'));     // platform-admin endpoints

  app.listen(PORT, () => {
    console.log(`🚀 RenewPulse listening on http://localhost:${PORT}`);

    schedulerService.runScheduler();
    setInterval(schedulerService.runScheduler, 24 * 60 * 60 * 1000);

    jobExecutorService.runJobExecutor();
    setInterval(jobExecutorService.runJobExecutor, 60 * 1000);
  });
}

start().catch(err => { console.error('Startup failed:', err); process.exit(1); });