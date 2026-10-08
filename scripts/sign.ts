/**
 * Signs a webhook, checks it with our verify() and with the official Standard
 * Webhooks library, then shows what tampering, replays and rotation look like.
 *
 *   npm run sign
 */
import { Webhook } from 'standardwebhooks';
import { generateSecret, signHeaders, verify } from '../src/signing';

const secret = generateSecret();
const body = JSON.stringify({ type: 'order.created', timestamp: new Date().toISOString(), data: { id: 'ord_1', status: 'created', version: 1 } });
const headers = signHeaders([secret], 'msg_1', body);
console.log(headers, '\n');

function check(label: string, run: () => void): void {
  try {
    run();
    console.log(`✓ ${label}`);
  } catch (err) {
    console.log(`✗ ${label}: ${(err as Error).message}`);
  }
}

check('our verify() accepts it', () => verify(secret, body, { ...headers }));
check('the official library accepts it', () => new Webhook(secret).verify(body, { ...headers }));
check('a changed body', () => verify(secret, body.replace('ord_1', 'ord_2'), { ...headers }));
check('the same request, ten minutes later', () => verify(secret, body, { ...headers }, { now: new Date(Date.now() + 10 * 60_000) }));

// Rotation: sign with the new secret and the old one, and receivers on either still verify.
const newSecret = generateSecret();
const rotated = signHeaders([newSecret, secret], 'msg_2', body);
console.log(`\nduring a rotation: ${rotated['webhook-signature']}\n`);
check('a receiver still on the old secret', () => verify(secret, body, { ...rotated }));
check('a receiver already on the new secret', () => verify(newSecret, body, { ...rotated }));
