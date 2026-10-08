/**
 * Creates an order, pays for it, and shows what the outbox recorded.
 *
 *   npm run outbox
 */
import { SenderDb } from '../src/sender/db';

const db = new SenderDb(); // in memory, so every run starts empty
db.addEndpoint('https://hooks.example.com/webhooks');
const order = db.createOrder('sam', 4200);
db.updateOrderStatus(order.id, 'paid');

console.table(db.sqlite.prepare('SELECT seq, id, type FROM events').all());
console.table(db.sqlite.prepare('SELECT event_seq, endpoint_id, attempts, status FROM deliveries').all());
console.log(db.eventsAfter(1)[0]!.payload);
