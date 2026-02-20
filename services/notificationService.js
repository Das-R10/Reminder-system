const sgMail = require('@sendgrid/mail');
const Twilio = require('twilio');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function renderTemplate(tpl = '', vars = {}) {
  return tpl.replace(/{{\s*([\w]+)\s*}}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key] ?? '');
    }
    return '';
  });
}

async function sendNotification(job) {
  const { channel, email, phone, first_name, expiry_date, template } = job;

  const vars = {
    first_name: first_name || '',
    expiry_date: expiry_date ? (new Date(expiry_date)).toISOString().slice(0, 10) : ''
  };

  const bodyText = template
    ? renderTemplate(template, vars)
    : `Hi ${vars.first_name}, your plan expires on ${vars.expiry_date}`;

  if (channel === 'email') {
    if (!email) throw new Error('No email for job');

    if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM) {
      throw new Error('SendGrid not configured (SENDGRID_API_KEY / SENDGRID_FROM)');
    }

    const msg = {
      to: email,
      from: process.env.SENDGRID_FROM,
      subject: 'Subscription expiry reminder',
      text: bodyText,
      html: bodyText.replace(/\n/g, '<br/>')
    };

    const response = await sgMail.send(msg);
    try {
      const maybeFirst = Array.isArray(response) ? response[0] : response;
      const headers = maybeFirst && maybeFirst.headers ? maybeFirst.headers : {};
      const provId = headers['x-message-id'] || headers['X-Message-Id'] || headers['message-id'] || `sg_${Date.now()}`;
      return provId;
    } catch (e) {
      return `sg_${Date.now()}`;
    }
  }

  if (channel === 'sms') {
    if (!phone) throw new Error('No phone for job');

    if (!twilioClient || !process.env.TWILIO_FROM) {
      throw new Error('Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM)');
    }

    const msg = await twilioClient.messages.create({
      body: bodyText,
      from: process.env.TWILIO_FROM,
      to: phone
    });

    return msg && msg.sid ? msg.sid : `tw_${Date.now()}`;
  }

  throw new Error('Unknown channel: ' + channel);
}

module.exports = {
  renderTemplate,
  sendNotification
};
