import { test, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempVault, fakeModel } from './helpers.ts';
import type { TempVault } from './helpers.ts';
import { startServer } from '../src/server.ts';
import { Curator } from '../src/curator/curator.ts';

const PST = path.join(import.meta.dir, '..', 'src', 'bin', 'pst.ts');

let ctx: TempVault;
let server: ReturnType<typeof startServer>;
let url: string;
let agentToken: string;
const model = fakeModel(() => ({ updates: [{ id: 'taste/food', content: '- Spicy\n- Loves dosa', reason: 'liked masala dosa' }] }));

beforeAll(() => {
  ctx = tempVault();
  ctx.vault.writeDoc('taste/food', 'Spicy, vegetarian on weekdays', 'owner');
  ctx.vault.writeDoc('details/address', 'private', 'owner');
  agentToken = ctx.vault.createToken({ name: 'claude-code', scopes: ['read:taste', 'read:logbook', 'append:logbook'] }).token;
  server = startServer(ctx.vault, { port: 0, curator: new Curator(ctx.vault, { ask: model.ask }) });
  url = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
  ctx.cleanup();
});

async function call(method: string, pathname: string, { token = agentToken as string | null, body }: { token?: string | null; body?: unknown } = {}) {
  const res = await fetch(url + pathname, {
    method,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await Bun.sleep(20);
  }
}

/** Reads a child's stdout one line at a time. */
function lineReader(stream: ReadableStream<Uint8Array>): () => Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buffer += decoder.decode(value, { stream: true });
    }
  };
}

test('HTTP API enforces the token', async () => {
  assert.equal((await call('GET', '/v1/health', { token: null })).status, 200);
  assert.equal((await call('GET', '/v1/docs/taste/food', { token: null })).status, 401);
  assert.equal((await call('GET', '/v1/docs/taste/food', { token: 'pst_00000000_' + 'A'.repeat(43) })).status, 401);

  const doc = await call('GET', '/v1/docs/taste/food');
  assert.equal(doc.status, 200);
  assert.equal(doc.body.content, 'Spicy, vegetarian on weekdays');

  assert.equal((await call('GET', '/v1/docs/details/address')).status, 403);
  assert.equal((await call('PUT', '/v1/docs/taste/food', { body: { content: 'x' } })).status, 403);
  assert.deepEqual((await call('GET', '/v1/docs')).body.docs.map((d: { id: string }) => d.id), ['taste/food']);
  assert.equal((await call('GET', '/v1/docs/%E0%A4%A')).status, 400);

  const created = await call('POST', '/v1/logbook', { body: { action: 'ordered', item: 'Paneer tikka', tags: ['food'], agent: 'spoofed' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.entry.agent, 'claude-code');
  const found = await call('GET', '/v1/logbook?tag=food');
  assert.deepEqual(found.body.entries.map((e: { item: string }) => e.item), ['Paneer tikka']);

  assert.equal((await call('POST', '/v1/logbook', { body: { item: 'missing action' } })).status, 400);
  assert.equal((await call('POST', '/v1/logbook', { body: [1, 2] })).status, 400);
});

test('MCP server exposes the vault through the token, and its start wakes the curator', async () => {
  const child = Bun.spawn([process.execPath, PST, 'mcp'], {
    env: { PATH: process.env.PATH, PST_URL: url, PST_TOKEN: agentToken },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const nextLine = lineReader(child.stdout);
  const send = (msg: unknown) => {
    child.stdin.write(JSON.stringify(msg) + '\n');
    child.stdin.flush();
  };
  let id = 0;
  const rpc = async (method: string, params?: unknown) => {
    send({ jsonrpc: '2.0', id: ++id, method, params });
    return JSON.parse(await nextLine());
  };
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'personalitystore');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // The vault has unprocessed entries and the curator has never run, so the hello starts a run.
    await until(() => ctx.vault.readCuratorState().runs.length === 1);
    assert.equal(ctx.vault.readCuratorState().runs[0]!.trigger, 'agent:claude-code');
    assert.match(ctx.vault.readDoc('taste/food').content, /Loves dosa/);
    assert.ok(ctx.vault.readAudit({ limit: 50 }).some((e) => e.op === 'agent.hello' && e.actor === 'claude-code'));

    const tools = (await rpc('tools/list')).result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(tools, ['vault_whoami', 'vault_list', 'vault_read', 'vault_write', 'logbook_append', 'logbook_search']);

    const read = await rpc('tools/call', { name: 'vault_read', arguments: { id: 'taste/food' } });
    assert.match(read.result.content[0].text, /Loves dosa/);

    const denied = await rpc('tools/call', { name: 'vault_read', arguments: { id: 'details/address' } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /no read access/);

    const logged = await rpc('tools/call', { name: 'logbook_append', arguments: { action: 'liked', item: 'Masala dosa', tags: ['food'] } });
    assert.equal(logged.result.isError, undefined);
    const search = await rpc('tools/call', { name: 'logbook_search', arguments: { query: 'dosa' } });
    assert.match(search.result.content[0].text, /Masala dosa/);

    assert.equal((await rpc('nope')).error.code, -32601);
  } finally {
    child.kill();
  }

  // A second agent starting right away doesn't trigger another run: the interval hasn't passed.
  const hello = await call('POST', '/v1/agent/hello');
  assert.deepEqual(hello.body, { curator: 'idle' });
  assert.equal(model.prompts.length, 1);
});
