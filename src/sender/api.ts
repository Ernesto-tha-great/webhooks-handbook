import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { assertAcceptableUrl, UnsafeUrlError } from '../ssrf.js';
import type { SenderDb } from './db.js';

/**
 * The sending side's HTTP API: a tiny orders service, endpoint management,
 * and the events feed that lets receivers reconcile.
 */
export function createSenderApi(db: SenderDb, options: { allowHttpEndpoints?: boolean } = {}) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/orders') {
        const body = await readJson(req);
        return send(res, 201, db.createOrder(String(body.customer ?? 'anonymous'), Number(body.total_cents ?? 0)));
      }

      const statusMatch = url.pathname.match(/^\/orders\/([^/]+)$/);
      if (req.method === 'PATCH' && statusMatch) {
        const body = await readJson(req);
        return send(res, 200, db.updateOrderStatus(statusMatch[1]!, String(body.status)));
      }

      if (req.method === 'POST' && url.pathname === '/endpoints') {
        const body = await readJson(req);
        const target = assertAcceptableUrl(String(body.url ?? ''), { allowHttp: options.allowHttpEndpoints });
        // The secret is shown once, now. Store it like a password on your side.
        return send(res, 201, db.addEndpoint(target.toString()));
      }

      const rotateMatch = url.pathname.match(/^\/endpoints\/([^/]+)\/rotate$/);
      if (req.method === 'POST' && rotateMatch) {
        return send(res, 200, { secret: db.rotateSecret(rotateMatch[1]!) });
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        // The reconciliation feed: every event, in order, from a cursor.
        const after = Number(url.searchParams.get('after') ?? 0);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
        const events = db.eventsAfter(after, limit).map((e) => ({ seq: e.seq, id: e.id, payload: JSON.parse(e.payload) }));
        return send(res, 200, { events, next: events.at(-1)?.seq ?? after });
      }

      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof UnsafeUrlError) return send(res, 422, { error: 'unsafe_url', message: err.message });
      return send(res, 400, { error: 'bad_request', message: (err as Error).message });
    }
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
