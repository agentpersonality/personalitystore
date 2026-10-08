// HTTP API for agents (Bun.serve). Every route except /v1/health needs "Authorization: Bearer pst_...".
//
//   GET    /v1/health
//   GET    /v1/whoami
//   POST   /v1/agent/hello          an agent session started; lets the curator catch up if due
//   GET    /v1/docs?prefix=taste
//   GET    /v1/docs/<id>            e.g. /v1/docs/taste/food
//   PUT    /v1/docs/<id>            {"content": "..."}
//   DELETE /v1/docs/<id>
//   GET    /v1/logbook?from=YYYY-MM-DD&to=YYYY-MM-DD&tag=&q=&limit=
//   POST   /v1/logbook              {"action", "item", "details"?, "tags"?, "ts"?}

import { AgentSession } from './access.ts';
import { VaultError, errorMessage } from './errors.ts';
import type { Vault } from './vault.ts';
import type { Curator } from './curator/curator.ts';
import type { Token } from './types.ts';

const MAX_BODY = 1_000_000;
const HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: HEADERS });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new VaultError(400, 'request body must be a JSON object');
  return body as Record<string, unknown>;
}

function limitParam(value: string | null): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 2000) : 200;
}

export function createHandler(vault: Vault, { curator }: { curator?: Curator } = {}): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /v1/health') return json(200, { ok: true });

      const auth = req.headers.get('authorization') ?? '';
      let token: Token;
      try {
        token = vault.authenticate(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
      } catch (err) {
        vault.audit({ actor: 'unknown', op: 'auth', target: url.pathname, ok: false, error: errorMessage(err) });
        throw err;
      }
      const session = new AgentSession(vault, token);
      const q = url.searchParams;

      if (route === 'GET /v1/whoami') return json(200, session.whoami());
      if (route === 'POST /v1/agent/hello') {
        session.hello();
        if (!curator) return json(202, { curator: 'off' });
        const due = curator.isDue();
        if (due) curator.maybeRun(`agent:${token.name}`).catch((err: unknown) => console.error(`curator: ${errorMessage(err)}`));
        return json(202, { curator: due ? 'started' : 'idle' });
      }
      if (route === 'GET /v1/docs') return json(200, { docs: session.listDocs(q.get('prefix') ?? '') });
      if (url.pathname.startsWith('/v1/docs/')) {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice('/v1/docs/'.length));
        } catch {
          throw new VaultError(400, 'bad document path');
        }
        if (req.method === 'GET') return json(200, session.readDoc(id));
        if (req.method === 'PUT') return json(200, session.writeDoc(id, (await readJson(req)).content));
        if (req.method === 'DELETE') return json(200, session.deleteDoc(id));
      }
      if (route === 'GET /v1/logbook') {
        return json(200, session.readLog({
          from: q.get('from') || undefined,
          to: q.get('to') || undefined,
          tag: q.get('tag') || undefined,
          query: q.get('q') || undefined,
          limit: limitParam(q.get('limit')),
        }));
      }
      if (route === 'POST /v1/logbook') return json(201, { entry: session.appendLog(await readJson(req)) });
      return json(404, { error: `no route ${route}` });
    } catch (err) {
      if (err instanceof VaultError) return json(err.status, { error: err.message });
      console.error(err);
      return json(500, { error: 'internal error' });
    }
  };
}

export function startServer(
  vault: Vault,
  { hostname = '127.0.0.1', port = 7457, curator }: { hostname?: string; port?: number; curator?: Curator } = {},
) {
  return Bun.serve({ hostname, port, maxRequestBodySize: MAX_BODY, fetch: createHandler(vault, curator ? { curator } : {}) });
}
