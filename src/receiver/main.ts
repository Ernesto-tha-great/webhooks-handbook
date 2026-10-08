/**
 * Runs a receiver on :4001 that verifies, stores and processes webhooks, and
 * catches up on anything it missed from the sender's events feed, on startup
 * and every 30 seconds.
 *
 *   WEBHOOK_SECRET=whsec_... npm run receiver
 */
import { createReceiver, reconcile, ReceiverDb } from './receiver';

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
  if (processed) {
    console.log(`processed ${processed} event${processed === 1 ? '' : 's'}`);
    console.table(db.orders());
  }
}, 500);

// Catch up on anything the webhooks missed: once now, then every 30 seconds.
const senderUrl = process.env.SENDER_URL ?? 'http://localhost:4000';
async function catchUp(): Promise<void> {
  const recovered = await reconcile(db, senderUrl).catch((err) => (console.warn(`reconcile failed: ${err.message}`), 0));
  if (recovered) console.log(`reconciled ${recovered} event${recovered === 1 ? '' : 's'} the webhooks missed`);
}
void catchUp();
setInterval(catchUp, 30_000);
