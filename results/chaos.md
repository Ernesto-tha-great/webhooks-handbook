Seed 7. 150 orders, each created then moved through paid → shipped → delivered.

| Approach | Events | Lost | Applied more than once | Wrong final order state | Recovered by reconciliation |
|---|---:|---:|---:|---:|---:|
| Naive: send inline, retry 3×, apply on arrival | 600 | 178 (29.7%) | 44 (7.3%) | 30 (20.0%) | 0 |
| Handbook: outbox, backoff, inbox, versions, reconcile | 600 | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 3 |

Duplicate deliveries absorbed by the inbox: 73.
