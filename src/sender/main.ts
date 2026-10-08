/**
 * Runs the sending side: the orders API on :4000 and the dispatcher, ticking
 * once a second.
 *
 *   npm run sender
 *   curl -X POST localhost:4000/endpoints -d '{"url":"http://localhost:4001/webhooks"}'
 *   curl -X POST localhost:4000/orders -d '{"customer":"sam","total_cents":4200}'
 */
import { createSafeAgent } from '../ssrf';
import { createSenderApi } from './api';
import { SenderDb } from './db';
import { DEFAULT_SCHEDULE_MS, Dispatcher } from './dispatcher';

const local = process.env.NODE_ENV !== 'production';
const db = new SenderDb(process.env.SENDER_DB ?? 'sender.db');
const dispatcher = new Dispatcher(db, {
  // Locally your receiver is on localhost, so private addresses are allowed. In production they never are.
  agent: createSafeAgent({ allowPrivate: local }),
  // And locally, nobody wants to wait five minutes for a retry, so the schedule is in seconds.
  scheduleMs: local ? [0, 1_000, 5_000, 10_000, 30_000] : DEFAULT_SCHEDULE_MS,
  disableAfter: 50,
});

createSenderApi(db, { allowHttpEndpoints: local }).listen(4000, () => console.log('sender API on http://localhost:4000'));

setInterval(async () => {
  const report = await dispatcher.tick();
  if (report.attempted) {
    const time = new Date().toISOString().slice(11, 19);
    console.log(`${time} dispatched ${report.attempted}: ${report.delivered} delivered, ${report.retrying} retrying, ${report.dead} dead`);
  }
}, 1_000);
