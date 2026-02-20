const express = require("express");
const router = express.Router();
const { pool } = require("../db");


const authTenant = require("../middleware/authTenant");

/* ============================
   TENANT STATS
============================ */
router.get("/tenant/stats", authTenant, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT plan, jobs_used, job_limit,
        (SELECT COUNT(*) FROM jobs
         WHERE tenant_id = $1 AND status = 'failed') AS failed_jobs
       FROM tenants WHERE id = $1`,
      [req.user.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

/* ============================
   JOB LOGS
============================ */
router.get("/jobs", authTenant, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT channel, recipient, status, created_at
     FROM jobs
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.user.id]
  );

  res.json(rows);
});

/* ============================
   CREATE JOB (LIMIT ENFORCED)
============================ */
router.post("/jobs", authTenant, async (req, res) => {
  const { channel, recipient, message } = req.body;

  if (!channel || !recipient || !message) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const tenantRes = await pool.query(
    "SELECT jobs_used, job_limit FROM tenants WHERE id=$1",
    [req.user.id]
  );

  const tenant = tenantRes.rows[0];

  if (tenant.jobs_used >= tenant.job_limit) {
    return res.status(403).json({
      error: "Plan limit exceeded. Please upgrade."
    });
  }

  const jobRes = await pool.query(
    `INSERT INTO jobs (tenant_id, channel, recipient, message, status)
     VALUES ($1, $2, $3, $4, 'sent')
     RETURNING id`,
    [req.user.id, channel.toLowerCase(), recipient, message]
  );

  await pool.query(
    "UPDATE tenants SET jobs_used = jobs_used + 1 WHERE id=$1",
    [req.user.id]
  );

  res.json({ success: true, job_id: jobRes.rows[0].id });
});

/* ============================
   PURCHASE REQUEST (REAL PAYMENT FLOW)
============================ */
router.post("/tenant/purchase", authTenant, async (req, res) => {
  const { plan, payment_method } = req.body;

  const plans = {
    starter: { amount: 999, jobs: 2000 },
    business: { amount: 3999, jobs: 10000 }
  };

  if (!plans[plan]) {
    return res.status(400).json({ error: "Invalid plan" });
  }

  if (!["upi", "bank", "international"].includes(payment_method)) {
    return res.status(400).json({ error: "Invalid payment method" });
  }

  await pool.query(
    `INSERT INTO purchase_requests
     (tenant_id, plan, amount, payment_method)
     VALUES ($1, $2, $3, $4)`,
    [req.user.id, plan, plans[plan].amount, payment_method]
  );

  res.json({
    success: true,
    message: "Purchase request created. Complete payment to activate plan."
  });
});

module.exports = router;
