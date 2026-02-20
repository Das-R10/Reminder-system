// lib/plans.js
module.exports = {
  plans: {
    free: { name: 'Free', price: 0, jobs: 100, channels: ['email'] },
    starter: { name: 'Starter', price: 99900, jobs: 2000, channels: ['email','sms'] }, // price in paise
    business: { name: 'Business', price: 399900, jobs: 10000, channels: ['email','sms','api'] }
  },
  getPlan(planKey) {
    return this.plans[planKey] || this.plans.free;
  }
};
