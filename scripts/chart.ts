/** Draws results/chaos.json as docs/images/chaos.svg. */
import { readFileSync, writeFileSync } from 'node:fs';

interface Outcome { approach: string; events: number; lost: number; appliedMoreThanOnce: number; wrongFinalState: number }
const { results, orders, seed } = JSON.parse(readFileSync('results/chaos.json', 'utf8')) as { results: Outcome[]; orders: number; seed: number };
const [naive, handbook] = results as [Outcome, Outcome];

const metrics = [
  { label: 'Events lost', value: (o: Outcome) => o.lost / o.events },
  { label: 'Events applied more than once', value: (o: Outcome) => o.appliedMoreThanOnce / o.events },
  { label: 'Orders left in the wrong state', value: (o: Outcome) => o.wrongFinalState / orders },
];
const max = Math.max(...metrics.flatMap((m) => [m.value(naive), m.value(handbook)]));
const barMax = 520;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 420" width="1200" height="420" role="img" aria-labelledby="t d">
<title id="t">Naive webhooks versus the handbook, against the same flaky receiver</title>
<desc id="d">${metrics.map((m) => `${m.label}: naive ${pct(m.value(naive))}, handbook ${pct(m.value(handbook))}`).join('; ')}.</desc>
<style>
  svg { --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#8a8983; --naive:#eb6834; --hb:#2a78d6; }
  @media (prefers-color-scheme: dark) { svg { --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7; --ink-3:#8f8e86; --naive:#d95926; --hb:#3987e5; } }
  text { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: var(--ink); }
  .h1 { font-size: 22px; font-weight: 700; } .sub { font-size: 14px; fill: var(--ink-2); }
  .lbl { font-size: 14px; font-weight: 600; } .k { font-size: 13px; fill: var(--ink-2); } .val { font-size: 13px; font-weight: 600; }
  .note { font-size: 12px; fill: var(--ink-3); }
</style>
<rect width="100%" height="100%" fill="var(--surface)"/>
<text class="h1" x="40" y="44">Same flaky receiver, two senders</text>
<text class="sub" x="40" y="68">${naive.events} events for ${orders} orders. The receiver fails 15% of requests, drops 8% after doing the work, stalls on 4%, and is down for 1.5 s.</text>
<rect x="40" y="86" width="14" height="14" rx="3" fill="var(--naive)"/><text class="k" x="60" y="98">Naive: send inline, retry 3×, apply on arrival</text>
<rect x="400" y="86" width="14" height="14" rx="3" fill="var(--hb)"/><text class="k" x="420" y="98">Handbook: outbox, backoff, inbox, versions, reconcile</text>`];

metrics.forEach((metric, i) => {
  const y = 140 + i * 86;
  parts.push(`<text class="lbl" x="40" y="${y + 14}">${metric.label}</text>`);
  [[naive, 'var(--naive)'], [handbook, 'var(--hb)']].forEach(([outcome, color], j) => {
    const value = metric.value(outcome as Outcome);
    const w = value === 0 ? 0 : Math.max(2, (value / max) * barMax);
    const yy = y + 24 + j * 24;
    if (w > 0) parts.push(`<rect x="300" y="${yy}" width="${w.toFixed(1)}" height="18" rx="4" fill="${color}"/>`);
    else parts.push(`<rect x="300" y="${yy + 8}" width="2" height="2" fill="${color}"/>`);
    parts.push(`<text class="val" x="${(300 + w + 10).toFixed(1)}" y="${yy + 14}">${pct(value)}</text>`);
  });
});
parts.push(`<text class="note" x="40" y="400">Seed ${seed}. Source: npm run chaos. Every number is reproducible on your machine.</text>`, '</svg>');
writeFileSync('docs/images/chaos.svg', parts.join('\n') + '\n');
console.log('wrote docs/images/chaos.svg');
