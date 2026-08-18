import assert from 'node:assert';
import { extractDirectAnswer } from './extract-answer.js';

// Reproduces the reported bug: a multi-pair Q&A knowledge item (the format
// AddKnowledgeModal/EditKnowledgeModal save via JSON.stringify(pairs)) must
// never leak raw JSON into a prompt/reply, even for a query that doesn't
// closely match any single pair.
const kbItemContent = JSON.stringify([
  { question: 'What is your name?', answer: "I'm Aria, your assistant." },
  { question: 'What are your hours?', answer: 'We are open 9am-6pm, Mon-Sat.' },
  { question: 'How do I reset my password?', answer: 'Go to Settings > Security > Reset password.' },
]);

const offTopicAnswer = extractDirectAnswer(kbItemContent, "what's your name?");
assert.ok(!offTopicAnswer.includes('{'), 'must not leak raw JSON braces');
assert.ok(!offTopicAnswer.includes('"question"'), 'must not leak JSON field names');
assert.ok(offTopicAnswer.includes('Aria'), 'must pick the best-matching pair');

const hoursAnswer = extractDirectAnswer(kbItemContent, 'what are your hours');
assert.strictEqual(hoursAnswer, 'We are open 9am-6pm, Mon-Sat.');

const singlePair = JSON.stringify([{ question: 'Refund policy?', answer: 'Refunds within 7 days.' }]);
assert.strictEqual(extractDirectAnswer(singlePair, 'anything'), 'Refunds within 7 days.');

const plainDoc = 'Title: Shipping\nType: document\nWe ship worldwide in 3-5 days.';
assert.strictEqual(
  extractDirectAnswer(plainDoc, 'shipping time'),
  'We ship worldwide in 3-5 days.'
);

console.log('extract-answer.check.ts: ok');
