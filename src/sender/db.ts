import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { generateSecret } from '../signing.js';

export interface OrderRow { id: string; customer: string; total_cents: number; status: string; version: number; updated_at: string }
export interface EventRow { seq: number; id: string; type: string; payload: string; created_at: string }
export interface EndpointRow { id: string; url: string; secrets: string; status: 'active' | 'disabled'; consecutive_failures: number }
export interface StoredSecret { secret: string; expiresAt: string | null }

/**
 * The sender's database. The important table is `events`: it's the outbox,
 * written in the same transaction as the business change, and it doubles as
 * the log consumers can page through to catch up on anything they missed.
 */
export class SenderDb {
  readonly sqlite: DatabaseSync;

  constructor(path = ':memory:') {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, customer TEXT NOT NULL, total_cents INTEGER NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS endpoints (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, secrets TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', consecutive_failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        event_seq INTEGER NOT NULL, endpoint_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', last_error TEXT,
        PRIMARY KEY (event_seq, endpoint_id)
      );
      CREATE INDEX IF NOT EXISTS due_deliveries ON deliveries (status, next_attempt_at);
    `);
  }

  transaction<T>(work: () => T): T {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.sqlite.exec('COMMIT');
      return result;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  // --- Endpoints -----------------------------------------------------------

  addEndpoint(url: string): { id: string; secret: string } {
    const id = `ep_${randomUUID().slice(0, 8)}`;
    const secret = generateSecret();
    const secrets: StoredSecret[] = [{ secret, expiresAt: null }];
    this.sqlite.prepare('INSERT INTO endpoints (id, url, secrets) VALUES (?, ?, ?)').run(id, url, JSON.stringify(secrets));
    return { id, secret };
  }

  /**
   * Rotation without downtime: the new secret is added, and the old one keeps
   * being used for signing until `overlapHours` have passed. Receivers can
   * switch whenever they like inside that window.
   */
  rotateSecret(endpointId: string, overlapHours = 24, now = new Date()): string {
    const endpoint = this.endpoint(endpointId);
    if (!endpoint) throw new Error(`No endpoint ${endpointId}`);
    const expiresAt = new Date(now.getTime() + overlapHours * 3_600_000).toISOString();
    const current = (JSON.parse(endpoint.secrets) as StoredSecret[]).map((s) => ({ ...s, expiresAt: s.expiresAt ?? expiresAt }));
    const secret = generateSecret();
    const secrets = [{ secret, expiresAt: null }, ...current];
    this.sqlite.prepare('UPDATE endpoints SET secrets = ? WHERE id = ?').run(JSON.stringify(secrets), endpointId);
    return secret;
  }

  endpoint(id: string): EndpointRow | undefined {
    return this.sqlite.prepare('SELECT * FROM endpoints WHERE id = ?').get(id) as EndpointRow | undefined;
  }

  // --- Business writes, each with its event, in one transaction --------------

  createOrder(customer: string, totalCents: number, now = new Date()): OrderRow {
    return this.transaction(() => {
      const order: OrderRow = {
        id: `ord_${randomUUID().slice(0, 12)}`, customer, total_cents: totalCents,
        status: 'created', version: 1, updated_at: now.toISOString(),
      };
      this.sqlite.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)')
        .run(order.id, order.customer, order.total_cents, order.status, order.version, order.updated_at);
      this.recordEvent('order.created', order, now);
      return order;
    });
  }

  updateOrderStatus(orderId: string, status: string, now = new Date()): OrderRow {
    return this.transaction(() => {
      const current = this.sqlite.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow | undefined;
      if (!current) throw new Error(`No order ${orderId}`);
      const order: OrderRow = { ...current, status, version: current.version + 1, updated_at: now.toISOString() };
      this.sqlite.prepare('UPDATE orders SET status = ?, version = ?, updated_at = ? WHERE id = ?')
        .run(order.status, order.version, order.updated_at, order.id);
      this.recordEvent('order.updated', order, now);
      return order;
    });
  }

  /** The outbox write: the event and one delivery job per active endpoint, inside the caller's transaction. */
  private recordEvent(type: string, data: OrderRow, now: Date): void {
    const id = `msg_${randomUUID().replace(/-/g, '')}`;
    const payload = JSON.stringify({ type, timestamp: now.toISOString(), data });
    const { lastInsertRowid } = this.sqlite
      .prepare('INSERT INTO events (id, type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(id, type, payload, now.toISOString());
    this.sqlite
      .prepare(`INSERT INTO deliveries (event_seq, endpoint_id, next_attempt_at)
                SELECT ?, id, ? FROM endpoints WHERE status = 'active'`)
      .run(lastInsertRowid, now.getTime());
  }

  // --- Reading -----------------------------------------------------------------

  eventsAfter(seq: number, limit = 100): EventRow[] {
    return this.sqlite.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit) as unknown as EventRow[];
  }

  orders(): OrderRow[] {
    return (this.sqlite.prepare('SELECT * FROM orders ORDER BY id').all() as unknown as OrderRow[]).map((row) => ({ ...row }));
  }

  pendingDeliveries(): number {
    return (this.sqlite.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'pending'").get() as { n: number }).n;
  }
}
