import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks signatures (https://www.standardwebhooks.com).
 *
 *   signed content:   `${webhook-id}.${webhook-timestamp}.${raw body}`
 *   signature:        base64(HMAC-SHA256(secret, signed content))
 *   header value:     "v1,<signature>", space-separated when there are several
 *   secret format:    "whsec_" + base64(random bytes)
 */

export const SECRET_PREFIX = 'whsec_';
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

export function generateSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString('base64');
}

function keyOf(secret: string): Buffer {
  return Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, 'base64');
}

export function signature(secret: string, id: string, timestamp: number, body: string): string {
  const hmac = createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${hmac}`;
}

/**
 * Signs with every secret you pass. During a key rotation you send two
 * signatures, so receivers on the old secret and the new one both verify.
 */
export function signHeaders(secrets: readonly string[], id: string, body: string, now = new Date()): WebhookHeaders {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': secrets.map((secret) => signature(secret, id, timestamp, body)).join(' '),
  };
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Verifies a request on the receiving side. `body` must be the raw bytes as
 * they arrived. Parse JSON first and re-serialise it, and the signature will
 * (correctly) fail, because key order and whitespace are part of what was signed.
 */
export function verify(
  secret: string,
  body: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  options: { toleranceSeconds?: number; now?: Date } = {},
): void {
  const id = single(headers['webhook-id']);
  const timestamp = single(headers['webhook-timestamp']);
  const signatures = single(headers['webhook-signature']);
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError('Missing webhook headers');

  // Replay protection: a captured request stops working after a few minutes.
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const sent = Number(timestamp);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isInteger(sent) || Math.abs(now - sent) > tolerance) {
    throw new WebhookVerificationError('Timestamp outside the tolerance window');
  }

  const expected = Buffer.from(signature(secret, id, sent, body.toString()).slice('v1,'.length), 'base64');
  for (const candidate of signatures.split(' ')) {
    const [version, value] = candidate.split(',');
    if (version !== 'v1' || !value) continue;
    const received = Buffer.from(value, 'base64');
    // Constant-time comparison: === leaks how many leading bytes matched.
    if (received.length === expected.length && timingSafeEqual(received, expected)) return;
  }
  throw new WebhookVerificationError('No matching signature');
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
