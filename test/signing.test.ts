import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Webhook } from 'standardwebhooks';
import { generateSecret, signHeaders, verify, WebhookVerificationError } from '../src/signing';

const body = JSON.stringify({ type: 'order.updated', timestamp: '2026-10-08T09:00:00.000Z', data: { id: 'ord_1', status: 'paid' } });

describe('Standard Webhooks signatures', () => {
  it('produces signatures the official library accepts', () => {
    const secret = generateSecret();
    const headers = signHeaders([secret], 'msg_1', body);
    assert.doesNotThrow(() => new Webhook(secret).verify(body, { ...headers }));
  });

  it('accepts signatures the official library produces', () => {
    const secret = generateSecret();
    const now = new Date();
    const official = new Webhook(secret).sign('msg_2', now, body);
    const headers = { 'webhook-id': 'msg_2', 'webhook-timestamp': String(Math.floor(now.getTime() / 1000)), 'webhook-signature': official };
    assert.doesNotThrow(() => verify(secret, body, headers));
  });

  it('rejects a body that changed after signing, even by one space', () => {
    const secret = generateSecret();
    const headers = signHeaders([secret], 'msg_3', body);
    const reformatted = JSON.stringify(JSON.parse(body), null, 1);
    assert.throws(() => verify(secret, reformatted, { ...headers }), WebhookVerificationError);
  });

  it('rejects an old request replayed later', () => {
    const secret = generateSecret();
    const headers = signHeaders([secret], 'msg_4', body, new Date(Date.now() - 10 * 60_000));
    assert.throws(() => verify(secret, body, { ...headers }), /tolerance/);
  });

  it('rejects the wrong secret, and garbage, without throwing anything else', () => {
    const headers = signHeaders([generateSecret()], 'msg_5', body);
    assert.throws(() => verify(generateSecret(), body, { ...headers }), WebhookVerificationError);
    assert.throws(() => verify(generateSecret(), body, { ...headers, 'webhook-signature': 'v1,short' }), WebhookVerificationError);
  });

  it('signs with both secrets during a rotation, so either side can switch first', () => {
    const oldSecret = generateSecret();
    const newSecret = generateSecret();
    const headers = signHeaders([newSecret, oldSecret], 'msg_6', body);
    assert.equal(headers['webhook-signature'].split(' ').length, 2);
    assert.doesNotThrow(() => verify(oldSecret, body, { ...headers }));
    assert.doesNotThrow(() => verify(newSecret, body, { ...headers }));
  });
});
