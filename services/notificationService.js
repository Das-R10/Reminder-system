// services/notificationService.js
// Providers: SendGrid (email), MSG91 (SMS), Gupshup (WhatsApp)
// Also handles inbound delivery status webhooks from all three providers.

const sgMail        = require('@sendgrid/mail');
const axios         = require('axios');
const { pool }      = require('../db');
const { notify: log, webhook: wlog } = require('./logger');

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ── Template renderer ─────────────────────────────────────────────────────────
function renderTemplate(tpl = '', vars = {}) {
  return tpl.replace(/{{\s*([\w]+)\s*}}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : ''
  );
}

function buildVars(job) {
  return {
    first_name:   job.first_name   || '',
    last_name:    job.last_name    || '',
    expiry_date:  job.expiry_date ? new Date(job.expiry_date).toISOString().slice(0, 10) : '',
    company_name: job.company_name || '',
    days_left:    job.days_left    || ''
  };
}

// ── EMAIL via SendGrid ────────────────────────────────────────────────────────
async function sendEmail(job) {
  if (!job.email) throw new Error('No email address for job');
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM)
    throw new Error('SendGrid not configured');

  const vars    = buildVars(job);
  const body    = job.template ? renderTemplate(job.template, vars)
    : `Hi ${vars.first_name}, your subscription expires on ${vars.expiry_date}. Please renew to continue.`;
  const subject = job.subject_template ? renderTemplate(job.subject_template, vars)
    : 'Subscription Expiry Reminder';

  const response = await sgMail.send({
    to: job.email, from: process.env.SENDGRID_FROM,
    subject, text: body, html: body.replace(/\n/g, '<br/>')
  });

  const first   = Array.isArray(response) ? response[0] : response;
  const headers = first?.headers || {};
  const msgId   = headers['x-message-id'] || headers['X-Message-Id'] || `sg_${Date.now()}`;
  log.info({ job_id: job.id, msg_id: msgId }, 'Email sent via SendGrid');
  return msgId;
}

// ── SMS via MSG91 ─────────────────────────────────────────────────────────────
async function sendSMS(job) {
  if (!job.phone) throw new Error('No phone number for job');
  if (!process.env.MSG91_AUTH_KEY) throw new Error('MSG91 not configured');

  const vars = buildVars(job);
  const body = job.template ? renderTemplate(job.template, vars)
    : `Hi ${vars.first_name}, your subscription expires on ${vars.expiry_date}. Renew now.`;

  let phone = job.phone.replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;

  const payload = {
    sender: process.env.MSG91_SENDER_ID || 'NOTIFY',
    route: '4', country: '91',
    sms: [{ message: body, to: [phone] }]
  };
  if (process.env.MSG91_TEMPLATE_ID) payload.sms[0].template_id = process.env.MSG91_TEMPLATE_ID;

  const res = await axios.post('https://api.msg91.com/api/v2/sendsms', payload, {
    headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
    timeout: 10000
  });

  if (res.data?.type === 'error') throw new Error(`MSG91 error: ${res.data.message}`);
  const msgId = res.data?.request_id || `msg91_${Date.now()}`;
  log.info({ job_id: job.id, msg_id: msgId }, 'SMS sent via MSG91');
  return msgId;
}

// ── WHATSAPP via Gupshup ──────────────────────────────────────────────────────
async function sendWhatsApp(job) {
  if (!job.phone) throw new Error('No phone for WhatsApp job');
  if (!process.env.GUPSHUP_API_KEY || !process.env.GUPSHUP_APP_NAME || !process.env.GUPSHUP_SRC_PHONE)
    throw new Error('Gupshup not configured');

  const vars = buildVars(job);
  const body = job.template ? renderTemplate(job.template, vars)
    : `Hi ${vars.first_name}, your subscription expires on ${vars.expiry_date}. Please renew. Thank you!`;

  let phone = job.phone.replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;

  const params = new URLSearchParams({
    channel: 'whatsapp', source: process.env.GUPSHUP_SRC_PHONE,
    destination: phone, message: JSON.stringify({ type: 'text', text: body }),
    'src.name': process.env.GUPSHUP_APP_NAME
  });

  const res = await axios.post('https://api.gupshup.io/sm/api/v1/msg', params.toString(), {
    headers: { apikey: process.env.GUPSHUP_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000
  });

  if (res.data?.status === 'error') throw new Error(`Gupshup error: ${res.data.message}`);
  const msgId = res.data?.messageId || `gupshup_${Date.now()}`;
  log.info({ job_id: job.id, msg_id: msgId }, 'WhatsApp sent via Gupshup');
  return msgId;
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function sendNotification(job) {
  switch (job.channel) {
    case 'email':    return sendEmail(job);
    case 'sms':      return sendSMS(job);
    case 'whatsapp': return sendWhatsApp(job);
    default: throw new Error(`Unknown channel: ${job.channel}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIVERY WEBHOOKS
// Each provider calls back with delivery status. We find the job by
// provider_msg_id and update delivery_status.
// ─────────────────────────────────────────────────────────────────────────────

// Map provider status strings → our canonical status
const STATUS_MAP = {
  // SendGrid
  delivered: 'delivered', open: 'opened', click: 'clicked',
  bounce: 'bounced', blocked: 'bounced', dropped: 'bounced',
  spamreport: 'spam', unsubscribe: 'unsubscribed',
  // MSG91
  'DELIVRD': 'delivered', 'UNDELIV': 'failed', 'REJECTD': 'failed',
  'EXPIRED': 'failed',
  // Gupshup
  'DELIVERED': 'delivered', 'READ': 'opened', 'FAILED': 'failed',
  'SENT': 'sent_to_provider'
};

async function updateDeliveryStatus(providerMsgId, rawStatus, rawPayload = {}) {
  const status = STATUS_MAP[rawStatus] || rawStatus.toLowerCase();
  try {
    const { rowCount } = await pool.query(
      `UPDATE jobs
       SET delivery_status = $1, delivery_updated_at = NOW(), delivery_raw = $2
       WHERE provider_msg_id = $3`,
      [status, JSON.stringify(rawPayload), providerMsgId]
    );
    if (rowCount === 0) {
      wlog.warn({ provider_msg_id: providerMsgId, status }, 'Delivery webhook — no job found');
    } else {
      wlog.info({ provider_msg_id: providerMsgId, status }, 'Delivery status updated');
    }
  } catch (err) {
    wlog.error({ err, provider_msg_id: providerMsgId }, 'Failed to update delivery status');
  }
}

// ── SendGrid delivery webhook handler ─────────────────────────────────────────
// SendGrid sends an array of events per request.
async function handleSendGridWebhook(events) {
  for (const event of events) {
    if (!event.sg_message_id) continue;
    // sg_message_id has format: <id>.<more_stuff> — we only stored the first part
    const msgId = event.sg_message_id.split('.')[0];
    await updateDeliveryStatus(msgId, event.event, event);
  }
}

// ── MSG91 delivery webhook handler ────────────────────────────────────────────
// MSG91 sends a single JSON object per webhook call.
async function handleMsg91Webhook(body) {
  // MSG91 report format: { report: [{ requestId, status, ... }] }
  const reports = body.report || (Array.isArray(body) ? body : [body]);
  for (const report of reports) {
    const msgId  = report.requestId || report.request_id;
    const status = report.status    || report.Status;
    if (msgId && status) await updateDeliveryStatus(msgId, status, report);
  }
}

// ── Gupshup delivery webhook handler ─────────────────────────────────────────
async function handleGupshupWebhook(body) {
  // Gupshup sends: { app, timestamp, version, type, payload: { id, type, ... } }
  const msgId  = body?.payload?.id   || body?.messageId;
  const status = body?.payload?.type || body?.type;
  if (msgId && status) await updateDeliveryStatus(msgId, status, body);
}

module.exports = {
  renderTemplate, sendNotification, sendEmail, sendSMS, sendWhatsApp,
  handleSendGridWebhook, handleMsg91Webhook, handleGupshupWebhook,
  updateDeliveryStatus
};
