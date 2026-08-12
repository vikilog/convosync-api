import assert from 'node:assert/strict';
import { serializeLandingPlan } from './subscriptionPlans.js';

const sample = {
  id: 'db1',
  slug: 'growth',
  planCode: 'tier_grwth',
  name: 'GROWTH',
  labelColor: '#0f766e',
  priceMonthly: 4999,
  priceAnnual: 49990,
  priceMonthlyPaise: 499_900,
  priceAnnualPaise: 4_999_000,
  razorpayPlanIdMonthly: null,
  razorpayPlanIdAnnual: null,
  priceLabel: null,
  popular: false,
  borderColor: null,
  editButtonStyle: 'blue',
  sortOrder: 2,
  trialDays: 14,
  isActive: true,
  features: {
    contacts: 'Unlimited',
    teamMembers: '8',
    aiAgents: '3',
    channels: 'WhatsApp + Instagram',
    emailsPerMonth: 2500,
    walletCredits: '750 CC',
    aiCopilot: true,
    socialListening: false,
    voiceAgent: false,
    developers: false,
    whatsappPay: false,
    ctwaAds: false,
    reports: 'Basic',
    storageGb: 1,
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

const landing = serializeLandingPlan(sample as never);
assert.equal(landing.id, 'growth');
assert.equal(landing.name, 'Growth');
assert.equal(landing.priceMonthly, 4999);
assert.equal(landing.ctaKind, 'trial');
assert.equal(landing.comparison.seats, '8');
assert.equal(landing.comparison.aiCopilot, true);
assert.equal(landing.comparison.storage, '1 GB');
assert.ok(landing.highlights.includes('8 seats'));
assert.ok(landing.highlights.includes('3 AI Agents'));
assert.ok(landing.highlights.some((h) => h.includes('CC wallet')));
assert.ok(landing.highlights.some((h) => h.includes('storage')));
assert.ok(!landing.highlights.some((h) => /email/i.test(h)));
assert.ok(!('emails' in landing.comparison));

console.log('subscriptionPlans.landing check ok');
