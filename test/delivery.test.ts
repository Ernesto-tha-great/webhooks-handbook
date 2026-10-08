import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { createReceiver, reconcile, ReceiverDb } from '../src/receiver/receiver';
import { createSenderApi } from '../src/sender/api';
import { SenderDb } from '../src/sender/db';
import { Dispatcher } from '../src/sender/dispatcher';
import { createSafeAgent } from '../src/ssrf';

const agent = createSafeAgent({ allowPrivate: true });
const servers: Server[] = [];
after(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await agent.close();
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A clock we control, so retries happen when the test says so. */
function clock() {
  let t = Date.now();
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('the outbox', () => {
  it('writes the order, the event and the delivery job together, or not at all', () => {
    const db = new SenderDb();
    db.addEndpoint('https://example.com/hook');
    db.createOrder('sam', 4200);
    assert.equal(db.eventsAfter(0).length, 1);
    assert.equal(db.pendingDeliveries(), 1);

    assert.throws(() => db.updateOrderStatus('ord_missing', 'paid'));
    assert.equal(db.eventsAfter(0).length, 1, 'the failed update left no event behind');
  });
});

describe('the dispatcher', () => {
  it('retries on the schedule until the receiver recovers', async () => {
    let calls = 0;
    const url = await listen(createServer((_req, res) => res.writeHead(++calls < 3 ? 503 : 204).end()));
    const db = new SenderDb();
    db.addEndpoint(`${url}/hook`);
    db.createOrder('sam', 100);
    const time = clock();
    const dispatcher = new Dispatcher(db, { agent, scheduleMs: [0, 1_000, 10_000], now: time.now, random: () => 0.5 });

    assert.deepEqual(await dispatcher.tick(), { attempted: 1, delivered: 0, retrying: 1, dead: 0 });
    assert.equal((await dispatcher.tick()).attempted, 0, 'not due yet');
    time.advance(1_000);
    assert.equal((await dispatcher.tick()).retrying, 1);
    time.advance(10_000);
    assert.equal((await dispatcher.tick()).delivered, 1);
    assert.equal(db.pendingDeliveries(), 0);
  });

  it('gives up after the last scheduled attempt', async () => {
    const url = await listen(createServer((_req, res) => res.writeHead(500).end()));
    const db = new SenderDb();
    db.addEndpoint(`${url}/hook`);
    db.createOrder('sam', 100);
    const time = clock();
    const dispatcher = new Dispatcher(db, { agent, scheduleMs: [0, 10, 10], now: time.now, random: () => 0.5 });
    const outcomes = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push(await dispatcher.tick());
      time.advance(100);
    }
    assert.equal(outcomes.at(-1)!.dead, 1);
  });

  it('treats a redirect as a failure instead of following it', async () => {
    let followed = false;
    const url = await listen(createServer((req, res) => {
      if (req.url === '/elsewhere') followed = true;
      res.writeHead(302, { location: '/elsewhere' }).end();
    }));
    const db = new SenderDb();
    db.addEndpoint(`${url}/hook`);
    db.createOrder('sam', 100);
    const report = await new Dispatcher(db, { agent }).tick();
    assert.equal(report.retrying, 1);
    assert.equal(followed, false);
  });

  it('stops sending to an endpoint that answers 410 Gone', async () => {
    const url = await listen(createServer((_req, res) => res.writeHead(410).end()));
    const db = new SenderDb();
    const { id } = db.addEndpoint(`${url}/hook`);
    db.createOrder('sam', 100);
    await new Dispatcher(db, { agent }).tick();
    assert.equal(db.endpoint(id)!.status, 'disabled');
  });
});

describe('the receiver', () => {
  it('processes a duplicate delivery once', async () => {
    const receiverDb = new ReceiverDb();
    const senderDb = new SenderDb();
    const { secret } = senderDb.addEndpoint('placeholder');
    const { server, stats } = createReceiver({ db: receiverDb, secrets: [secret] });
    const url = await listen(server);
    senderDb.sqlite.prepare('UPDATE endpoints SET url = ?').run(`${url}/webhooks`);
    senderDb.createOrder('sam', 100);

    // Deliver, then pretend we never heard back and deliver the same event again.
    const time = clock();
    const dispatcher = new Dispatcher(senderDb, { agent, now: time.now });
    await dispatcher.tick();
    senderDb.sqlite.prepare("UPDATE deliveries SET status = 'pending', next_attempt_at = 0").run();
    await dispatcher.tick();

    assert.equal(stats.received, 2);
    assert.equal(stats.duplicates, 1);
    assert.equal(receiverDb.processInbox(), 1);
  });

  it('sends a delivery once even when two ticks overlap', async () => {
    const receiverDb = new ReceiverDb();
    const senderDb = new SenderDb();
    const { secret } = senderDb.addEndpoint('placeholder');
    const { server, stats } = createReceiver({ db: receiverDb, secrets: [secret] });
    const url = await listen(server);
    senderDb.sqlite.prepare('UPDATE endpoints SET url = ?').run(`${url}/webhooks`);
    senderDb.createOrder('sam', 100);

    const dispatcher = new Dispatcher(senderDb, { agent });
    await Promise.all([dispatcher.tick(), dispatcher.tick()]);

    assert.equal(stats.received, 1);
  });

  it('keeps the newest version when events arrive out of order', () => {
    const db = new ReceiverDb();
    const event = (version: number, status: string) =>
      JSON.stringify({ type: 'order.updated', timestamp: '', data: { id: 'ord_1', status, version, updated_at: '' } });
    db.store('msg_v3', event(3, 'shipped'), 'webhook');
    db.store('msg_v2', event(2, 'paid'), 'webhook');
    db.processInbox();
    assert.deepEqual(db.orders(), [{ id: 'ord_1', status: 'shipped', version: 3 }]);
  });

  it('rejects a request it cannot verify', async () => {
    const { server, stats } = createReceiver({ db: new ReceiverDb(), secrets: ['whsec_' + Buffer.from('k').toString('base64')] });
    const url = await listen(server);
    const res = await fetch(`${url}/webhooks`, {
      method: 'POST',
      headers: { 'webhook-id': 'msg_x', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAA' },
      body: '{}',
    });
    assert.equal(res.status, 401);
    assert.equal(stats.rejected, 1);
  });

  it('recovers events the webhooks never delivered by reading the events feed', async () => {
    const senderDb = new SenderDb();
    senderDb.addEndpoint('https://example.com/hook'); // deliveries to it never happen in this test
    for (let i = 0; i < 5; i++) senderDb.createOrder(`customer-${i}`, i * 100);
    const senderUrl = await listen(createSenderApi(senderDb));

    const receiverDb = new ReceiverDb();
    assert.equal(await reconcile(receiverDb, senderUrl), 5);
    assert.equal(await reconcile(receiverDb, senderUrl), 0, 'the cursor remembers where we got to');
    receiverDb.processInbox();
    assert.equal(receiverDb.orders().length, 5);
  });
});
