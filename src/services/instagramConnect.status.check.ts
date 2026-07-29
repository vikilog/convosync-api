import { deriveInstagramStatusLabel } from './instagramConnect.js';

const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const past = new Date(Date.now() - 60_000);

console.assert(deriveInstagramStatusLabel({ status: 'connected', tokenExpiresAt: null }) === 'connected');
console.assert(deriveInstagramStatusLabel({ status: 'expired', tokenExpiresAt: null }) === 'expired');
console.assert(deriveInstagramStatusLabel({ status: 'connected', tokenExpiresAt: soon }) === 'expiring_soon');
console.assert(deriveInstagramStatusLabel({ status: 'connected', tokenExpiresAt: past }) === 'expired');
console.assert(deriveInstagramStatusLabel({ status: 'revoked', tokenExpiresAt: null }) === 'revoked');

console.log('instagramConnect statusLabel.check: ok');
