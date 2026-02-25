// plans.js — Single source of truth for per-channel plans
// Tenants buy channel add-ons; each has its own monthly quota.

const CHANNEL_PLANS = {
  // ── EMAIL ────────────────────────────────────────────────────────────────
  email_free: {
    id: 'email_free',
    channel: 'email',
    name: 'Email Free',
    price: 0,           // INR per month
    quota: 500,
    description: '500 emails / month',
    badge: 'Free'
  },
  email_starter: {
    id: 'email_starter',
    channel: 'email',
    name: 'Email Starter',
    price: 499,
    quota: 5000,
    description: '5,000 emails / month',
    badge: 'Popular'
  },
  email_pro: {
    id: 'email_pro',
    channel: 'email',
    name: 'Email Pro',
    price: 1499,
    quota: 25000,
    description: '25,000 emails / month',
    badge: 'Pro'
  },

  // ── SMS (via MSG91) ───────────────────────────────────────────────────────
  sms_starter: {
    id: 'sms_starter',
    channel: 'sms',
    name: 'SMS Starter',
    price: 599,
    quota: 1000,
    description: '1,000 SMS / month',
    badge: 'Popular'
  },
  sms_pro: {
    id: 'sms_pro',
    channel: 'sms',
    name: 'SMS Pro',
    price: 1999,
    quota: 5000,
    description: '5,000 SMS / month',
    badge: 'Pro'
  },

  // ── WHATSAPP (via Gupshup) ────────────────────────────────────────────────
  whatsapp_starter: {
    id: 'whatsapp_starter',
    channel: 'whatsapp',
    name: 'WhatsApp Starter',
    price: 799,
    quota: 1000,
    description: '1,000 WhatsApp msgs / month',
    badge: 'Popular'
  },
  whatsapp_pro: {
    id: 'whatsapp_pro',
    channel: 'whatsapp',
    name: 'WhatsApp Pro',
    price: 2499,
    quota: 5000,
    description: '5,000 WhatsApp msgs / month',
    badge: 'Pro'
  },
};

// Combo bundles (pre-priced discounts)
const COMBO_PLANS = {
  combo_sms_whatsapp: {
    id: 'combo_sms_whatsapp',
    name: 'SMS + WhatsApp Bundle',
    channels: ['sms', 'whatsapp'],
    price: 1199,   // saves ~200 vs buying separately
    quotas: { sms: 1000, whatsapp: 1000 },
    description: '1,000 SMS + 1,000 WhatsApp / month',
    badge: 'Save ₹200'
  },
  combo_all: {
    id: 'combo_all',
    name: 'All Channels Bundle',
    channels: ['email', 'sms', 'whatsapp'],
    price: 2499,
    quotas: { email: 5000, sms: 1000, whatsapp: 1000 },
    description: '5,000 Email + 1,000 SMS + 1,000 WhatsApp / month',
    badge: 'Best Value'
  }
};

function getChannelPlan(planId) {
  return CHANNEL_PLANS[planId] || COMBO_PLANS[planId] || null;
}

function getPlansByChannel(channel) {
  return Object.values(CHANNEL_PLANS).filter(p => p.channel === channel);
}

function getAllPlans() {
  return {
    channels: CHANNEL_PLANS,
    combos: COMBO_PLANS
  };
}

// Given a tenant's active_plans array, return which channels they can use
function getEnabledChannels(activePlans = []) {
  const channels = new Set();
  for (const planId of activePlans) {
    const plan = getChannelPlan(planId);
    if (!plan) continue;
    if (plan.channel) channels.add(plan.channel);
    if (plan.channels) plan.channels.forEach(c => channels.add(c));
  }
  return Array.from(channels);
}

// Get quota for a specific channel from active plans
function getChannelQuota(activePlans = [], channel) {
  let quota = 0;
  for (const planId of activePlans) {
    const plan = getChannelPlan(planId);
    if (!plan) continue;
    if (plan.channel === channel) quota += plan.quota;
    if (plan.quotas && plan.quotas[channel]) quota += plan.quotas[channel];
  }
  // email_free is always active
  if (channel === 'email' && !activePlans.some(p => p.startsWith('email'))) {
    quota = 500;
  }
  return quota;
}

module.exports = {
  CHANNEL_PLANS,
  COMBO_PLANS,
  getChannelPlan,
  getPlansByChannel,
  getAllPlans,
  getEnabledChannels,
  getChannelQuota
};