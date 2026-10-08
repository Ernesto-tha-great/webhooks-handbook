/**
 * The same misbehaving receiver, two ways of sending to it.
 *
 *   naive:    POST the webhook from the request handler, retry 3 times on
 *             failure, receiver applies whatever arrives, in arrival order.
 *   handbook: outbox + dispatcher with backoff, inbox with dedupe, version
 *             checks, reconciliation at the end.
 *
 * The receiver fails 15% of requests outright, does the work and then drops
 * the connection on 8%, stalls past the sender's timeout on 4%, and fails
 * every request for 1.5 seconds in the middle. The misbehaviour is seeded;
 * the outage is timed by the clock, so the numbers move a little between runs.
 *
 *   npm run chaos
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fetch } from 'undici';
import { createReceiver, reconcile, ReceiverDb } from '../src/receiver/receiver';
import { createSenderApi } from '../src/sender/api';
import { SenderDb } from '../src/sender/db';
import { Dispatcher } from '../src/sender/dispatcher';
import { generateSecret, signHeaders, verify } from '../src/signing';
import { createSafeAgent } from '../src/ssrf';

const ORDERS = 150;
const STATUSES = ['paid', 'shipped', 'delivered'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** The receiver's bad behaviour, shared by both runs. */
function misbehaviour(seed: number, startedAt: () => number) {
  const random = seeded(seed);
  return (_req: IncomingMessage): 'fail-before-store' | 'drop-after-store' | 'slow-after-store' | 'ok' => {
    const elapsed = Date.now() - startedAt();
    if (elapsed > 1_500 && elapsed < 3_000) return 'fail-before-store'; // the outage
    const roll = random();
    if (roll < 0.15) return 'fail-before-store';
    if (roll < 0.23) return 'drop-after-store';
    if (roll < 0.27) return 'slow-after-store';
    return 'ok';
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A plan of business writes: create every order, then walk each one through its statuses, interleaved. */
function plan(seed: number): Array<{ order: number; status: string | null }> {
  const random = seeded(seed);
  const steps: Array<{ order: number; status: string | null }> = [];
  for (let o = 0; o < ORDERS; o++) steps.push({ order: o, status: null });
  const updates = [];
  for (let o = 0; o < ORDERS; o++) for (const status of STATUSES) updates.push({ order: o, status });
  // Shuffle updates but keep each order's own statuses in sequence.
  const queues = new Map<number, string[]>();
  for (const u of updates) queues.set(u.order, [...(queues.get(u.order) ?? []), u.status]);
  while (queues.size) {
    const orders = [...queues.keys()];
    const order = orders[Math.floor(random() * orders.length)]!;
    const queue = queues.get(order)!;
    steps.push({ order, status: queue.shift()! });
    if (queue.length === 0) queues.delete(order);
  }
  return steps;
}

interface Outcome {
  approach: string;
  events: number;
  appliedAtLeastOnce: number;
  appliedMoreThanOnce: number;
  lost: number;
  wrongFinalState: number;
  recoveredByReconciliation: number;
}

// ---------------------------------------------------------------------------
async function naive(seed: number): Promise<Outcome> {
  let started = 0;
  const chaos = misbehaviour(seed, () => started);
  const secret = generateSecret();
  const applied = new Map<string, number>();
  const receiverOrders = new Map<string, string>();

  const receiver = createServer(async (req, res) => {
    const mode = chaos(req);
    if (mode === 'fail-before-store') return res.writeHead(500).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    try { verify(secret, raw, req.headers); } catch { return res.writeHead(401).end(); }
    const event = JSON.parse(raw.toString()) as { data: { id: string; status: string } };
    // No inbox, no dedupe, no versions: whatever arrives last wins.
    applied.set(String(req.headers['webhook-id']), (applied.get(String(req.headers['webhook-id'])) ?? 0) + 1);
    receiverOrders.set(event.data.id, event.data.status);
    if (mode === 'drop-after-store') return req.socket.destroy();
    if (mode === 'slow-after-store') await sleep(3_000);
    res.writeHead(204).end();
  });
  const url = await listen(receiver);

  const truth = new Map<string, string>();
  const ids: string[] = [];
  let events = 0;
  const inflight: Promise<void>[] = [];
  const sendWebhook = (eventId: string, payload: string) => inflight.push((async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${url}/webhooks`, {
          method: 'POST', body: payload,
          headers: { ...signHeaders([secret], eventId, payload), 'content-type': 'application/json' },
          signal: AbortSignal.timeout(1_000),
        });
        if (res.ok) return;
      } catch { /* retry */ }
    }
  })());

  started = Date.now();
  let version = 0;
  for (const step of plan(seed)) {
    const id = step.status === null ? `ord_${step.order}` : ids[step.order]!;
    if (step.status === null) ids[step.order] = id;
    const status = step.status ?? 'created';
    truth.set(id, status);
    const eventId = `msg_naive_${++version}`;
    events++;
    sendWebhook(eventId, JSON.stringify({ type: 'order.updated', timestamp: new Date().toISOString(), data: { id, status } }));
    await sleep(8);
  }
  await Promise.all(inflight);
  receiver.closeAllConnections();
  receiver.close();

  const counts = [...applied.values()];
  return {
    approach: 'Naive: send inline, retry 3×, apply on arrival',
    events,
    appliedAtLeastOnce: counts.length,
    appliedMoreThanOnce: counts.filter((n) => n > 1).length,
    lost: events - counts.length,
    wrongFinalState: [...truth].filter(([id, status]) => receiverOrders.get(id) !== status).length,
    recoveredByReconciliation: 0,
  };
}

// ---------------------------------------------------------------------------
async function handbook(seed: number): Promise<Outcome> {
  let started = 0;
  const senderDb = new SenderDb();
  const senderApi = createSenderApi(senderDb);
  const senderUrl = await listen(senderApi);

  const receiverDb = new ReceiverDb();
  // Log every time an event is applied, so "applied more than once" is counted, not assumed.
  receiverDb.sqlite.exec(`
    CREATE TABLE applied (webhook_id TEXT NOT NULL);
    CREATE TRIGGER log_apply AFTER UPDATE OF processed_at ON inbox BEGIN INSERT INTO applied VALUES (NEW.webhook_id); END;`);
  const { secret } = senderDb.addEndpoint('placeholder');
  const { server, stats } = createReceiver({ db: receiverDb, secrets: [secret], chaos: misbehaviour(seed, () => started) });
  const receiverUrl = await listen(server);
  senderDb.sqlite.prepare('UPDATE endpoints SET url = ?').run(`${receiverUrl}/webhooks`);

  const agent = createSafeAgent({ allowPrivate: true });
  // The real schedule, compressed from about 28 hours into about a second.
  const dispatcher = new Dispatcher(senderDb, { agent, timeoutMs: 1_000, scheduleMs: [0, 100, 200, 300, 400] });

  let running = true;
  const loop = (async () => {
    while (running || senderDb.pendingDeliveries() > 0) {
      await dispatcher.tick();
      receiverDb.processInbox();
      await sleep(50);
    }
  })();

  started = Date.now();
  const ids: string[] = [];
  let events = 0;
  for (const step of plan(seed)) {
    if (step.status === null) ids[step.order] = senderDb.createOrder(`customer-${step.order}`, 1_000 + step.order).id;
    else senderDb.updateOrderStatus(ids[step.order]!, step.status);
    events++;
    await sleep(8);
  }
  running = false;
  await loop;

  // How many orders would be wrong if we stopped here, without the events feed?
  const truth = new Map(senderDb.orders().map((o) => [o.id, o.status]));
  const wrongBeforeReconcile = receiverDb.orders().filter((o) => truth.get(o.id) !== o.status).length + (truth.size - receiverDb.orders().length);

  // Anything that ran out of retries during the outage comes back via the events feed.
  const recovered = await reconcile(receiverDb, senderUrl);
  receiverDb.processInbox();

  const applied = receiverDb.sqlite.prepare('SELECT COUNT(DISTINCT webhook_id) AS once, (SELECT COUNT(*) FROM (SELECT 1 FROM applied GROUP BY webhook_id HAVING COUNT(*) > 1)) AS more FROM applied').get() as { once: number; more: number };
  const theirs = new Map(receiverDb.orders().map((o) => [o.id, o.status]));

  server.closeAllConnections();
  server.close();
  senderApi.close();
  await agent.close();

  return {
    approach: 'Handbook: outbox, backoff, inbox, versions, reconcile',
    events,
    appliedAtLeastOnce: applied.once,
    appliedMoreThanOnce: applied.more,
    lost: events - applied.once,
    wrongFinalState: [...truth].filter(([id, status]) => theirs.get(id) !== status).length,
    recoveredByReconciliation: recovered,
    ...{ duplicatesAbsorbed: stats.duplicates, wrongBeforeReconcile },
  } as Outcome;
}

// ---------------------------------------------------------------------------
const seed = Number(process.env.SEED ?? 7);
const results = [await naive(seed), await handbook(seed)];

const pct = (n: number, of: number) => `${n} (${((100 * n) / of).toFixed(1)}%)`;
const table = [
  `Seed ${seed}. ${ORDERS} orders, each created then moved through ${STATUSES.join(' → ')}.`,
  '',
  '| Approach | Events | Lost | Applied more than once | Wrong final order state | Recovered by reconciliation |',
  '|---|---:|---:|---:|---:|---:|',
  ...results.map((r) => `| ${r.approach} | ${r.events} | ${pct(r.lost, r.events)} | ${pct(r.appliedMoreThanOnce, r.events)} | ${pct(r.wrongFinalState, ORDERS)} | ${r.recoveredByReconciliation} |`),
].join('\n');
console.log(table);
const { duplicatesAbsorbed: absorbed, wrongBeforeReconcile } = results[1] as Outcome & { duplicatesAbsorbed: number; wrongBeforeReconcile: number };
console.log(`\nThe handbook receiver absorbed ${absorbed} duplicate deliveries without applying them twice.`);
console.log(`Before it caught up from the events feed, ${wrongBeforeReconcile} of its orders were in the wrong state.`);

mkdirSync('results', { recursive: true });
writeFileSync('results/chaos.md', table + `\n\nDuplicate deliveries absorbed by the inbox: ${absorbed}. Orders in the wrong state before reconciliation: ${wrongBeforeReconcile}.\n`);
writeFileSync('results/chaos.json', JSON.stringify({ seed, orders: ORDERS, results }, null, 2) + '\n');
