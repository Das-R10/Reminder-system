const express = require("express");
const router = express.Router();
const authTenant = require("../middleware/authTenant");
const tenantService = require("../services/tenantService");
const paymentService = require("../services/paymentService");

/* ============================
   TENANT STATS
============================ */
router.get("/tenant/stats", authTenant, async (req, res) => {
  try {
    const rows = await tenantService.getStats(req.user.id);
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
  try {
    const rows = await tenantService.getJobLogs(req.user.id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load jobs" });
  }
});

/* ============================
   CREATE JOB (LIMIT ENFORCED)
============================ */
router.post("/jobs", authTenant, async (req, res) => {
  const { channel, recipient, message } = req.body;

  if (!channel || !recipient || !message) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const result = await tenantService.createJobWithLimitCheck(
      req.user.id,
      channel,
      recipient,
      message
    );
    res.json({ success: true, job_id: result.job_id });
  } catch (err) {
    if (err.code === "LIMIT_EXCEEDED") {
      return res.status(403).json({ error: err.message });
    }
    if (err.code === "TENANT_NOT_FOUND") {
      return res.status(404).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to create job" });
  }
});

/* ============================
   PURCHASE REQUEST (REAL PAYMENT FLOW)
============================ */
router.post("/tenant/purchase", authTenant, async (req, res) => {
  const { plan, payment_method } = req.body;

  try {
    await paymentService.createPurchaseRequest(req.user.id, plan, payment_method);
    res.json({
      success: true,
      message: "Purchase request created. Complete payment to activate plan."
    });
  } catch (err) {
    if (err.code === "INVALID_PLAN" || err.code === "INVALID_PAYMENT_METHOD") {
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: "Purchase request failed" });
  }
});

module.exports = router;
