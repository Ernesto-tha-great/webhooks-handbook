import type { Dispatcher as UndiciDispatcher } from 'undici';
import { fetch } from 'undici';
import { signHeaders } from '../signing';
import type { SenderDb, StoredSecret } from './db';

/**
 * Svix's published retry schedule, which the Standard Webhooks spec points
 * to: immediately, then 5 s, 5 min, 30 min, 2 h, 5 h, 10 h and 10 h.
 * A little over a day in total before we give up.
 */
export const DEFAULT_SCHEDULE_MS = [0, 5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000];

export interface DispatcherOptions {
  agent?: UndiciDispatcher;
  scheduleMs?: number[];
  timeoutMs?: number;
  /** Disable an endpoint after this many failed attempts in a row, across all its events. */
  disableAfter?: number;
  batchSize?: number;
  now?: () => number;
  random?: () => number;
}

interface DueRow {
  event_seq: number; endpoint_id: string; attempts: number;
  event_id: string; payload: string; url: string; secrets: string;
}

export interface TickReport { attempted: number; delivered: number; retrying: number; dead: number }

export class Dispatcher {
  private readonly schedule: number[];
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly db: SenderDb, private readonly options: DispatcherOptions = {}) {
    this.schedule = options.scheduleMs ?? DEFAULT_SCHEDULE_MS;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** Sends everything that's due, once. Call it on an interval. */
  async tick(): Promise<TickReport> {
    const due = this.db.transaction(() => {
      const rows = this.db.sqlite.prepare(`
        SELECT d.event_seq, d.endpoint_id, d.attempts, e.id AS event_id, e.payload, ep.url, ep.secrets
        FROM deliveries d
        JOIN events e ON e.seq = d.event_seq
        JOIN endpoints ep ON ep.id = d.endpoint_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND ep.status = 'active'
        ORDER BY d.event_seq
        LIMIT ?`).all(this.now(), this.options.batchSize ?? 50) as unknown as DueRow[];
      // Claim them: push each one's next attempt past the request timeout, so another
      // tick (or another dispatcher) doesn't send it again while we wait for an answer.
      const claimedUntil = this.now() + (this.options.timeoutMs ?? 10_000) + 5_000;
      const claim = this.db.sqlite.prepare('UPDATE deliveries SET next_attempt_at = ? WHERE event_seq = ? AND endpoint_id = ?');
      for (const row of rows) claim.run(claimedUntil, row.event_seq, row.endpoint_id);
      return rows;
    });

    const report: TickReport = { attempted: due.length, delivered: 0, retrying: 0, dead: 0 };
    await Promise.all(due.map(async (row) => {
      const outcome = await this.deliver(row);
      report[outcome]++;
    }));
    return report;
  }

  private async deliver(row: DueRow): Promise<'delivered' | 'retrying' | 'dead'> {
    const now = this.now();
    const secrets = (JSON.parse(row.secrets) as StoredSecret[])
      .filter((s) => s.expiresAt === null || Date.parse(s.expiresAt) > now)
      .map((s) => s.secret);
    const headers = signHeaders(secrets, row.event_id, row.payload, new Date(now));

    let error: string;
    try {
      const res = await fetch(row.url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', 'user-agent': 'webhooks-handbook/1.0' },
        body: row.payload,
        // Never follow redirects: a 302 to an internal address would get around our SSRF checks.
        redirect: 'manual',
        dispatcher: this.options.agent,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
      await res.body?.cancel();

      if (res.status >= 200 && res.status < 300) {
        this.markDelivered(row);
        return 'delivered';
      }
      if (res.status === 410) {
        // 410 Gone is the receiver telling us to stop. Respect it.
        this.disableEndpoint(row.endpoint_id);
        return this.fail(row, 'endpoint returned 410 Gone', true);
      }
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    }
    return this.fail(row, error, false);
  }

  private markDelivered(row: DueRow): void {
    this.db.transaction(() => {
      this.db.sqlite.prepare("UPDATE deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL WHERE event_seq = ? AND endpoint_id = ?")
        .run(row.event_seq, row.endpoint_id);
      this.db.sqlite.prepare('UPDATE endpoints SET consecutive_failures = 0 WHERE id = ?').run(row.endpoint_id);
    });
  }

  private fail(row: DueRow, error: string, final: boolean): 'retrying' | 'dead' {
    const attempts = row.attempts + 1;
    const exhausted = final || attempts >= this.schedule.length;
    // ±20% jitter so a recovered endpoint isn't hit by every retry in the same second.
    const delay = exhausted ? 0 : this.schedule[attempts]! * (0.8 + 0.4 * this.random());

    this.db.transaction(() => {
      this.db.sqlite.prepare('UPDATE deliveries SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ? WHERE event_seq = ? AND endpoint_id = ?')
        .run(attempts, exhausted ? 'dead' : 'pending', Math.round(this.now() + delay), error, row.event_seq, row.endpoint_id);
      const { consecutive_failures } = this.db.sqlite
        .prepare('UPDATE endpoints SET consecutive_failures = consecutive_failures + 1 WHERE id = ? RETURNING consecutive_failures')
        .get(row.endpoint_id) as { consecutive_failures: number };
      if (this.options.disableAfter && consecutive_failures >= this.options.disableAfter) {
        this.db.sqlite.prepare("UPDATE endpoints SET status = 'disabled' WHERE id = ?").run(row.endpoint_id);
      }
    });
    return exhausted ? 'dead' : 'retrying';
  }

  private disableEndpoint(id: string): void {
    this.db.sqlite.prepare("UPDATE endpoints SET status = 'disabled' WHERE id = ?").run(id);
  }
}
