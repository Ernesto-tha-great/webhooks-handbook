# webhooks-handbook

Reliable webhooks in Node.js and TypeScript, built to the [Standard Webhooks](https://www.standardwebhooks.com) spec. Both sides: the API that sends webhooks, and the app that receives them.

This is the finished code for my tutorial, **[Building Reliable Webhooks With Node.js and TypeScript](https://github.com/Ernesto-tha-great/Ernesto-tha-great/blob/main/articles/05-webhooks-handbook/article.md)**. If you're following along, build it from the article, step by step. This repo is here so you can check your work, or skip ahead.

![The whole system, sender and receiver](./docs/images/architecture.svg)

## What's in here

| | Sender (`src/sender`) | Receiver (`src/receiver`) |
|---|---|---|
| Never lose an event | Transactional outbox: the event is written with the change | Inbox: stored before the 204, processed after |
| Trust | Standard Webhooks signatures, several at once for rotation | Raw-body verification, constant-time compare, 5-minute replay window |
| Safety | SSRF checks at registration and at connect time, no redirects | Duplicates stop at the inbox's primary key |
| Failure | Retries on Svix's schedule with jitter, dead letters, 410 handling | Version checks so late events can't undo newer ones |
| Catching up | `GET /events?after=` feed | `reconcile()` pages through it from a saved cursor |

## Run it

You need Node.js 22.13 or newer (for the built-in `node:sqlite`).

```bash
git clone https://github.com/Ernesto-tha-great/webhooks-handbook.git
cd webhooks-handbook
npm install

npm test             # 19 tests, including interop with the official standardwebhooks package
npm run sign         # signs a webhook and checks it with our code and the official library
npm run outbox       # shows what the outbox records for one order
npm run check-urls   # runs some webhook URLs past both SSRF checks
npm run chaos        # naive vs handbook against the same misbehaving receiver
npm run chart        # redraws docs/images/chaos.svg from results/chaos.json
```

Run the two sides yourself, in separate terminals:

```bash
npm run sender                                    # API on :4000, dispatcher every second
curl -X POST localhost:4000/endpoints -d '{"url":"http://localhost:4001/webhooks"}'
# → {"id":"ep_…","secret":"whsec_…"}

WEBHOOK_SECRET=whsec_… npm run receiver           # receiver on :4001
curl -X POST localhost:4000/orders -d '{"customer":"sam","total_cents":4200}'
```

Locally (when `NODE_ENV` isn't `production`), the sender allows private addresses, so it can reach a receiver on localhost, and retries on a schedule of seconds instead of hours. Start the sender before the receiver, so the receiver can catch up from its events feed on startup.

## Results

![Naive webhooks versus the handbook against the same flaky receiver](./docs/images/chaos.svg)

From `npm run chaos` ([results/chaos.md](results/chaos.md)), which takes about 30 seconds. The receiver fails 15% of requests, drops the connection after doing the work on 8%, stalls past the sender's timeout on 4% and fails every request for 1.5 seconds in the middle. The naive sender lost 29.0% of 600 events, applied 7.7% more than once and left 19.3% of orders in the wrong state. The handbook version lost none, applied none more than once and got every order right, absorbing 73 duplicate deliveries on the way. The outage is timed by the clock, so the numbers move a little between runs.

## Licence

MIT
