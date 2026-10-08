/**
 * Runs a receiver on :4001 that verifies, stores and processes webhooks, and
 * reconciles against the sender's events feed every 30 seconds.
 *
 *   WEBHOOK_SECRET=whsec_... npm run receiver
 */
import { createReceiver, reconcile, ReceiverDb } from './receiver.js';

const secrets = (process.env.WEBHOOK_SECRET ?? '').split(',').filter(Boolean);
if (secrets.length === 0) {
  console.error('Set WEBHOOK_SECRET to the secret you got when you registered the endpoint.');
  process.exit(1);
}

const db = new ReceiverDb(process.env.RECEIVER_DB ?? 'receiver.db');
const { server } = createReceiver({ db, secrets });
server.listen(4001, () => console.log('receiver on http://localhost:4001/webhooks'));

setInterval(() => {
  const processed = db.processInbox();
  if (processed) console.log(`processed ${processed} events`);
}, 500);

const senderUrl = process.env.SENDER_URL ?? 'http://localhost:4000';
setInterval(async () => {
  const recovered = await reconcile(db, senderUrl).catch((err) => (console.warn(`reconcile failed: ${err.message}`), 0));
  if (recovered) console.log(`reconciled ${recovered} events the webhooks missed`);
}, 30_000);
