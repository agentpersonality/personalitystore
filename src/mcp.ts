// MCP server (stdio) for Claude Code, Codex and any other MCP client.
// It holds only the agent's token (PST_TOKEN) and talks to the vault service (PST_URL);
// the vault key never enters the agent's process. Agents start it with each session, so it also
// tells the vault an agent came alive, which lets the curator catch up in the background.

import { VERSION } from './version.ts';

export const DEFAULT_URL = 'http://127.0.0.1:7457';

const INSTRUCTIONS = `This is the user's personal vault: their personality, personal details, tastes, and a dated logbook of what they did.
- Before choosing, recommending or buying something for the user, read the matching taste/ document (vault_list shows what exists).
- Match their communication and work style from personality/ documents.
- Record notable actions, purchases, decisions and feedback with logbook_append; the vault turns the logbook into updated tastes on its own.
- Never store secrets, passwords or payment details.`;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: Tool[] = [
  {
    name: 'vault_whoami',
    description: "Show which parts of the user's vault this agent's token can read or write.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vault_list',
    description:
      "List documents in the user's vault that this token can read. Folders: personality/ (how the user thinks, communicates and works), " +
      'details/ (facts such as sizes, devices, locations), taste/ (preferences per domain, e.g. taste/food, taste/fashion).',
    inputSchema: {
      type: 'object',
      properties: { prefix: { type: 'string', description: "Optional folder or path prefix, e.g. 'taste' or 'taste/fashion'." } },
    },
  },
  {
    name: 'vault_read',
    description: "Read one vault document by id, e.g. 'taste/food' or 'personality/communication'.",
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Document id: <personality|details|taste>/<name>' } },
      required: ['id'],
    },
  },
  {
    name: 'vault_write',
    description:
      'Create or replace a vault document (Markdown). Only for durable facts or preferences the user stated or confirmed; ' +
      'read the existing document first and keep what is still true.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id: <personality|details|taste>/<name>' },
        content: { type: 'string', description: 'Full Markdown content' },
      },
      required: ['id', 'content'],
    },
  },
  {
    name: 'logbook_append',
    description:
      "Record something the user did or decided in today's logbook, e.g. action 'purchased', item 'Nike Pegasus 41'. " +
      'Use for notable actions, purchases, decisions and feedback, not routine chatter.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Verb, e.g. purchased, booked, liked, rejected, decided, asked' },
        item: { type: 'string', description: 'What it was about' },
        details: { type: 'object', description: 'Optional structured details (size, price, reason, link, ...)' },
        tags: { type: 'array', items: { type: 'string' }, description: "Lowercase domain tags, e.g. ['fashion', 'fashion/shoes']" },
      },
      required: ['action', 'item'],
    },
  },
  {
    name: 'logbook_search',
    description: "Search the user's dated logbook of past actions, newest first. Defaults to the last 7 days.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD' },
        to: { type: 'string', description: 'End date YYYY-MM-DD' },
        tag: { type: 'string', description: 'Only entries with this tag (or a sub-tag)' },
        query: { type: 'string', description: 'Text to look for in action, item and details' },
        limit: { type: 'number', description: 'Max entries (default 50)' },
      },
    },
  },
];

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<unknown>;

const docPath = (id: unknown) => String(id ?? '').split('/').map(encodeURIComponent).join('/');

function query(params: Record<string, unknown>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') s.set(k, String(v));
  return s.size ? `?${s}` : '';
}

export function createClient({ url = DEFAULT_URL, token }: { url?: string; token?: string | undefined }) {
  const base = url.replace(/\/+$/, '');
  const api = async (method: string, pathname: string, body?: unknown): Promise<any> => {
    if (!token) throw new Error('PST_TOKEN is not set for this MCP server; create one with `pst connect`');
    let res: Response;
    try {
      res = await fetch(base + pathname, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`vault service is not reachable at ${url}; start it with \`pst serve\` or \`pst service install\``);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(`vault: ${data.error ?? res.statusText} (${res.status})`);
    return data;
  };

  const handlers: Record<string, Handler> = {
    vault_whoami: () => api('GET', '/v1/whoami'),
    vault_list: (a) => api('GET', `/v1/docs${query({ prefix: a.prefix })}`),
    vault_read: async (a) => {
      const doc = await api('GET', `/v1/docs/${docPath(a.id)}`);
      return `# ${doc.id}\n_updated ${doc.updated_at} by ${doc.updated_by}_\n\n${doc.content}`;
    },
    vault_write: (a) => api('PUT', `/v1/docs/${docPath(a.id)}`, { content: a.content }),
    logbook_append: (a) => api('POST', '/v1/logbook', { action: a.action, item: a.item, details: a.details, tags: a.tags }),
    logbook_search: (a) => api('GET', `/v1/logbook${query({ from: a.from, to: a.to, tag: a.tag, q: a.query, limit: a.limit ?? 50 })}`),
  };

  /** Fire-and-forget: never delays or breaks the agent's start-up. */
  const hello = (): void => {
    if (!token || process.env.PST_CURATOR) return;
    fetch(`${base}/v1/agent/hello`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) })
      .catch(() => {});
  };

  return { handlers, hello };
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Args };
}

class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export async function handleMessage(msg: RpcMessage, handlers: Record<string, Handler>, onInitialize?: () => void): Promise<unknown> {
  switch (msg.method) {
    case 'initialize':
      onInitialize?.();
      return {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'personalitystore', version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const handler = handlers[msg.params?.name ?? ''];
      if (!handler) throw new RpcError(-32602, `unknown tool ${msg.params?.name}`);
      try {
        const out = await handler(msg.params?.arguments ?? {});
        return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    }
    default:
      throw new RpcError(-32601, `method not found: ${msg.method}`);
  }
}

export async function runMcp({ url = process.env.PST_URL || DEFAULT_URL, token = process.env.PST_TOKEN } = {}): Promise<void> {
  const { handlers, hello } = createClient({ url, token });
  const write = (msg: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const respond = async (line: string) => {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return write({ id: null, error: { code: -32700, message: 'parse error' } });
    }
    if (msg.id === undefined || msg.id === null) return; // notification
    try {
      write({ id: msg.id, result: await handleMessage(msg, handlers, hello) });
    } catch (err) {
      write({ id: msg.id, error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  };
  // Bun's console is an async iterator over stdin lines. Requests are answered concurrently.
  for await (const line of console) {
    if (line.trim()) void respond(line);
  }
}
