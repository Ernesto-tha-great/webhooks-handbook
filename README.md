# webhooks-handbook

Reliable webhook delivery in Node.js and TypeScript, built to the [Standard Webhooks](https://www.standardwebhooks.com) spec. Both sides: the API that sends webhooks, and the app that receives them.

This is the companion code for my article **The Webhooks Handbook: Reliable Delivery With Node.js and TypeScript**.

![The whole system, sender and receiver](./docs/images/architecture.svg)

## What's in here

| | Sender (`src/sender`) | Receiver (`src/receiver`) |
|---|---|---|
| Never lose an event | Transactional outbox: the event is written with the change | Inbox: stored before the 204, processed after |
| Trust | Standard Webhooks signatures, several at once for rotation | Raw-body verification, constant-time compare, 5-minute replay window |
| Safety | SSRF guard at registration and at connect time, no redirects | Duplicates stop at the inbox's primary key |
| Failure | Retries on Svix's schedule with jitter, dead letters, 410 handling | Version checks so late events can't undo newer ones |
| Catching up | `GET /events?after=` feed | `reconcile()` pages through it from a saved cursor |

## Quick start

You need Node 22.13 or newer (for the built-in `node:sqlite`).

```bash
git clone https://github.com/Ernesto-tha-great/webhooks-handbook.git
cd webhooks-handbook
npm install

npm test          # 18 tests, including interop with the official standardwebhooks package
npm run chaos     # naive vs handbook against the same misbehaving receiver
npm run chart     # redraws docs/images/chaos.svg from results/chaos.json
```

Run the two sides yourself:

```bash
npm run sender                                    # API on :4000, dispatcher every second
curl -X POST localhost:4000/endpoints -d '{"url":"http://localhost:4001/webhooks"}'
# → {"id":"ep_…","secret":"whsec_…"}

WEBHOOK_SECRET=whsec_… npm run receiver           # receiver on :4001
curl -X POST localhost:4000/orders -d '{"customer":"sam","total_cents":4200}'
```

## Results

![Naive webhooks versus the handbook against the same flaky receiver](./docs/images/chaos.svg)

From `npm run chaos` (`results/chaos.md`). The receiver fails 15% of requests, drops the connection after doing the work on 8%, stalls on 4% and is down for 1.5 seconds. The naive sender lost 29.7% of 600 events, applied 7.3% twice and left 20% of orders in the wrong state. The handbook version lost none, applied none twice and got every order right, absorbing 73 duplicate deliveries on the way.

## Licence

MIT
