// notificationService.js
// Providers: SendGrid (email), MSG91 (SMS), Gupshup (WhatsApp)

const sgMail = require('@sendgrid/mail');
const axios  = require('axios');

// ── SendGrid setup ────────────────────────────────────────────────────────────
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// ── Template renderer ─────────────────────────────────────────────────────────
function renderTemplate(tpl = '', vars = {}) {
  return tpl.replace(/{{\s*([\w]+)\s*}}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key)
      ? String(vars[key] ?? '')
      : '';
  });
}

// ── Build template vars from job ──────────────────────────────────────────────
function buildVars(job) {
  return {
    first_name:   job.first_name   || '',
    last_name:    job.last_name    || '',
    expiry_date:  job.expiry_date
      ? new Date(job.expiry_date).toISOString().slice(0, 10)
      : '',
    company_name: job.company_name || '',
    days_left:    job.days_left    || ''
  };
}

// ── EMAIL via SendGrid ────────────────────────────────────────────────────────
async function sendEmail(job) {
  if (!job.email) throw new Error('No email address for job');
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM) {
    throw new Error('SendGrid not configured (SENDGRID_API_KEY / SENDGRID_FROM missing)');
  }

  const vars    = buildVars(job);
  const body    = job.template ? renderTemplate(job.template, vars)
                               : `Hi ${vars.first_name}, your subscription expires on ${vars.expiry_date}. Please renew to continue enjoying our services.`;
  const subject = job.subject_template
    ? renderTemplate(job.subject_template, vars)
    : 'Subscription Expiry Reminder';

  const msg = {
    to:      job.email,
    from:    process.env.SENDGRID_FROM,
    subject,
    text:    body,
    html:    body.replace(/\n/g, '<br/>')
  };

  const response = await sgMail.send(msg);
  try {
    const first   = Array.isArray(response) ? response[0] : response;
    const headers = first?.headers || {};
    return headers['x-message-id'] || headers['X-Message-Id'] || `sg_${Date.now()}`;
  } catch {
    return `sg_${Date.now()}`;
  }
}

// ── SMS via MSG91 ─────────────────────────────────────────────────────────────
async function sendSMS(job) {
  if (!job.phone) throw new Error('No phone number for job');

  const authKey  = process.env.MSG91_AUTH_KEY;
  const senderId = process.env.MSG91_SENDER_ID || 'NOTIFY';
  const templateId = process.env.MSG91_TEMPLATE_ID; // DLT registered template ID

  if (!authKey) {
    throw new Error('MSG91 not configured (MSG91_AUTH_KEY missing)');
  }

  const vars = buildVars(job);
  const body = job.template
    ? renderTemplate(job.template, vars)
    : `Hi ${vars.first_name}, your subscription expires on ${vars.expiry_date}. Renew now to avoid interruption.`;

  // Normalize phone: ensure country code (add +91 if no country code)
  let phone = job.phone.replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;

  const payload = {
    sender:    senderId,
    route:     '4',           // transactional
    country:   '91',
    sms: [{
      message: body,
      to:      [phone]
    }]
  };

  if (templateId) payload.sms[0].template_id = templateId;

  const res = await axios.post(
    'https://api.msg91.com/api/v2/sendsms',
    payload,
    {
      headers: {
        authkey:        authKey,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );

  if (res.data && res.data.type === 'error') {
    throw new Error(`MSG91 error: ${res.data.message}`);
  }

  return res.data?.request_id || `msg91_${Date.now()}`;
}

// ── WHATSAPP via Gupshup ──────────────────────────────────────────────────────
async function sendWhatsApp(job) {
  if (!job.phone) throw new Error('No phone number for WhatsApp job');

  const apiKey  = process.env.GUPSHUP_API_KEY;
  const appName = process.env.GUPSHUP_APP_NAME;
  const srcPhone = process.env.GUPSHUP_SRC_PHONE; // your Gupshup registered number

  if (!apiKey || !appName || !srcPhone) {
    throw new Error('Gupshup not configured (GUPSHUP_API_KEY / GUPSHUP_APP_NAME / GUPSHUP_SRC_PHONE missing)');
  }

  const vars = buildVars(job);
  const body = job.template
    ? renderTemplate(job.template, vars)
    : `Hi ${vars.first_name}, your subscription expires on ${vars.expiry_date}. Please renew to continue. Thank you!`;

  // Normalize phone
  let phone = job.phone.replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;

  // Gupshup session/template message
  const params = new URLSearchParams({
    channel:  'whatsapp',
    source:   srcPhone,
    destination: phone,
    message:  JSON.stringify({ type: 'text', text: body }),
    'src.name': appName
  });

  const res = await axios.post(
    'https://api.gupshup.io/sm/api/v1/msg',
    params.toString(),
    {
      headers: {
        apikey:         apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    }
  );

  if (res.data && res.data.status === 'error') {
    throw new Error(`Gupshup error: ${res.data.message}`);
  }

  return res.data?.messageId || `gupshup_${Date.now()}`;
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function sendNotification(job) {
  switch (job.channel) {
    case 'email':     return sendEmail(job);
    case 'sms':       return sendSMS(job);
    case 'whatsapp':  return sendWhatsApp(job);
    default:
      throw new Error(`Unknown channel: ${job.channel}`);
  }
}

module.exports = {
  renderTemplate,
  sendNotification,
  sendEmail,
  sendSMS,
  sendWhatsApp
};