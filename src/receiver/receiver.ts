import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { verify, WebhookVerificationError } from '../signing.js';

interface OrderData { id: string; status: string; version: number; updated_at: string }
interface WebhookEvent { type: string; timestamp: string; data: OrderData }

/**
 * The receiver keeps an inbox: every verified webhook is written down (keyed by
 * its webhook-id) *before* we say 200, and processed afterwards. Duplicates
 * hit the primary key and vanish. A crash after the 200 loses nothing.
 */
export class ReceiverDb {
  readonly sqlite: DatabaseSync;

  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS inbox (
        webhook_id TEXT PRIMARY KEY, payload TEXT NOT NULL, source TEXT NOT NULL,
        received_at INTEGER NOT NULL, processed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, status TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    `);
  }

  /** Returns false when we've seen this webhook-id before. */
  store(webhookId: string, payload: string, source: 'webhook' | 'reconcile'): boolean {
    const { changes } = this.sqlite
      .prepare('INSERT OR IGNORE INTO inbox (webhook_id, payload, source, received_at) VALUES (?, ?, ?, ?)')
      .run(webhookId, payload, source, Date.now());
    return changes === 1;
  }

  /** Applies everything in the inbox that hasn't been applied yet. */
  processInbox(): number {
    const rows = this.sqlite.prepare('SELECT webhook_id, payload FROM inbox WHERE processed_at IS NULL ORDER BY received_at')
      .all() as Array<{ webhook_id: string; payload: string }>;
    for (const row of rows) {
      const event = JSON.parse(row.payload) as WebhookEvent;
      // Events can arrive out of order. The version on the order decides,
      // not the order the requests happened to land in.
      this.sqlite.prepare(`
        INSERT INTO orders (id, status, version) VALUES (?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET status = excluded.status, version = excluded.version
        WHERE excluded.version > orders.version`).run(event.data.id, event.data.status, event.data.version);
      this.sqlite.prepare('UPDATE inbox SET processed_at = ? WHERE webhook_id = ?').run(Date.now(), row.webhook_id);
    }
    return rows.length;
  }

  orders(): Array<{ id: string; status: string; version: number }> {
    const rows = this.sqlite.prepare('SELECT * FROM orders ORDER BY id').all() as Array<{ id: string; status: string; version: number }>;
    return rows.map((row) => ({ ...row }));
  }

  cursor(name: string): number {
    return (this.sqlite.prepare('SELECT value FROM cursors WHERE name = ?').get(name) as { value: number } | undefined)?.value ?? 0;
  }

  setCursor(name: string, value: number): void {
    this.sqlite.prepare('INSERT INTO cursors VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value').run(name, value);
  }
}

export interface ReceiverStats { received: number; duplicates: number; rejected: number }

export interface ReceiverOptions {
  db: ReceiverDb;
  /** Accept any of these. Keep the old one here while the sender rotates. */
  secrets: string[];
  /** For the chaos test: lets you make the receiver misbehave on purpose. */
  chaos?: (req: IncomingMessage) => 'fail-before-store' | 'drop-after-store' | 'slow-after-store' | 'ok';
}

export function createReceiver(options: ReceiverOptions) {
  const stats: ReceiverStats = { received: 0, duplicates: 0, rejected: 0 };

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks') return reply(res, 404);
    const chaos = options.chaos?.(req) ?? 'ok';
    if (chaos === 'fail-before-store') return reply(res, 500);

    // Verify the raw bytes, exactly as they arrived.
    const raw = await readRaw(req);
    if (!verifiesWithAny(options.secrets, raw, req.headers)) {
      stats.rejected++;
      return reply(res, 401);
    }

    stats.received++;
    const fresh = options.db.store(String(req.headers['webhook-id']), raw.toString(), 'webhook');
    if (!fresh) stats.duplicates++;

    if (chaos === 'drop-after-store') return req.socket.destroy(); // stored, but the sender never hears back
    if (chaos === 'slow-after-store') await new Promise((resolve) => setTimeout(resolve, 3_000));

    // Acknowledge fast. The work happens off the request path.
    return reply(res, 204);
  });

  return { server, stats };
}

/**
 * Catch up on anything the webhooks didn't deliver: page through the sender's
 * events feed from where we last stopped.
 */
export async function reconcile(db: ReceiverDb, senderUrl: string): Promise<number> {
  let recovered = 0;
  for (;;) {
    const res = await fetch(`${senderUrl}/events?after=${db.cursor('events')}&limit=200`);
    if (!res.ok) throw new Error(`events feed returned ${res.status}`);
    const page = (await res.json()) as { events: Array<{ seq: number; id: string; payload: unknown }>; next: number };
    for (const event of page.events) {
      if (db.store(event.id, JSON.stringify(event.payload), 'reconcile')) recovered++;
    }
    if (page.events.length === 0) return recovered;
    db.setCursor('events', page.next);
  }
}

function verifiesWithAny(secrets: string[], raw: Buffer, headers: IncomingMessage['headers']): boolean {
  for (const secret of secrets) {
    try {
      verify(secret, raw, headers);
      return true;
    } catch (err) {
      if (!(err instanceof WebhookVerificationError)) throw err;
    }
  }
  return false;
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function reply(res: ServerResponse, status: number): void {
  res.writeHead(status).end();
}
