/**
 * Runs the sending side: the orders API on :4000 and the dispatcher, ticking
 * once a second.
 *
 *   npm run sender
 *   curl -X POST localhost:4000/endpoints -d '{"url":"http://localhost:4001/webhooks"}'
 *   curl -X POST localhost:4000/orders -d '{"customer":"sam","total_cents":4200}'
 */
import { createSafeAgent } from '../ssrf.js';
import { createSenderApi } from './api.js';
import { SenderDb } from './db.js';
import { Dispatcher } from './dispatcher.js';

const local = process.env.NODE_ENV !== 'production';
const db = new SenderDb(process.env.SENDER_DB ?? 'sender.db');
// Locally your receiver is on localhost, so private addresses are allowed. In production they never are.
const dispatcher = new Dispatcher(db, { agent: createSafeAgent({ allowPrivate: local }), disableAfter: 50 });

createSenderApi(db, { allowHttpEndpoints: local }).listen(4000, () => console.log('sender API on http://localhost:4000'));

setInterval(async () => {
  const report = await dispatcher.tick();
  if (report.attempted) console.log(`dispatched ${report.attempted}: ${report.delivered} delivered, ${report.retrying} retrying, ${report.dead} dead`);
}, 1_000);
