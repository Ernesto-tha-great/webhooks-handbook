Seed 7. 150 orders, each created then moved through paid → shipped → delivered.

| Approach | Events | Lost | Applied more than once | Wrong final order state | Recovered by reconciliation |
|---|---:|---:|---:|---:|---:|
| Naive: send inline, retry 3×, apply on arrival | 600 | 174 (29.0%) | 46 (7.7%) | 29 (19.3%) | 0 |
| Handbook: outbox, backoff, inbox, versions, reconcile | 600 | 0 (0.0%) | 0 (0.0%) | 0 (0.0%) | 4 |

Duplicate deliveries absorbed by the inbox: 73. Orders in the wrong state before reconciliation: 0.
