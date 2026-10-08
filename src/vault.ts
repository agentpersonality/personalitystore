// The vault on disk. Every file is sealed with a key derived from the master key, which lives in
// macOS Keychain (or PST_MASTER_KEY / PST_MASTER_KEY_FILE on servers and other platforms).
//
//   <home>/
//     personality/*.md.enc   details/*.md.enc   taste/*.md.enc     documents (Markdown)
//     logbook/YYYY/MM/YYYY-MM-DD.jsonl.enc                          one sealed entry per line
//     .vault/meta.json  config.json  keycheck.enc  tokens.enc  curator.enc
//     .vault/audit/YYYY-MM-DD.jsonl.enc   .vault/history/<doc id>/<version>.md.enc

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateKey, parseKey, dataKey, sealJson, openJson, sealLine, openLine, sha256 } from './crypto.ts';
import { keychainAvailable, keychainGet, keychainSet } from './keychain.ts';
import { DOC_FOLDERS, normalizeDocId, validateScopes } from './scopes.ts';
import { localIso, today, shiftDate, dateRange, normalizeEntry, byLoggedAt, isAfterCursor } from './logbook.ts';
import { VaultError } from './errors.ts';
import type {
  AuditEvent, AuditRecord, CuratorState, Doc, DocInfo, DocVersion, LogCursor, LogEntry, LogInput, LogQuery,
  Token, TokenRecord, VaultConfig, VaultMeta,
} from './types.ts';

export { VaultError };

const META = '.vault/meta.json';
const CONFIG = '.vault/config.json';
const KEYCHECK = '.vault/keycheck.enc';
const TOKENS = '.vault/tokens.enc';
const CURATOR = '.vault/curator.enc';
const HISTORY = '.vault/history';
const LOCKS = '.vault/locks';
const MAX_DOC_BYTES = 256 * 1024;
const HISTORY_KEEP = 20;
const TOKEN_RE = /^pst_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const VERSION_RE = /^\d{13}-[0-9a-f]{4}$/;

export const DEFAULT_CONFIG: VaultConfig = {
  curator: {
    enabled: true,
    intervalHours: 6,
    backend: 'claude',
    claudeModel: 'sonnet',
    codexModel: null,
    command: null,
    maxEntriesPerRun: 200,
    claudePath: null,
    codexPath: null,
  },
};

export function vaultHome(): string {
  return process.env.PST_HOME || path.join(os.homedir(), '.personalitystore', 'vault');
}

function writeAtomic(file: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function appendLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, line + '\n', { mode: 0o600 });
}

function walkFiles(dir: string, suffix: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walkFiles(p, suffix);
    return e.name.endsWith(suffix) ? [p] : [];
  });
}

function envKey(): Buffer | null {
  if (process.env.PST_MASTER_KEY) return parseKey(process.env.PST_MASTER_KEY);
  if (process.env.PST_MASTER_KEY_FILE) return parseKey(fs.readFileSync(process.env.PST_MASTER_KEY_FILE, 'utf8'));
  return null;
}

export function parseTtl(ttl: string): number | null {
  if (ttl === 'never') return null;
  const m = /^(\d+)([mhd])$/.exec(ttl);
  if (!m || Number(m[1]) === 0) throw new VaultError(400, `bad ttl "${ttl}": use e.g. 30m, 12h, 90d or never`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

const publicToken = ({ hash: _hash, ...rest }: TokenRecord): Token => rest;

export function initVault(home: string = vaultHome()): Vault {
  if (fs.existsSync(path.join(home, META))) throw new VaultError(409, `a vault already exists at ${home}`);
  const id = crypto.randomBytes(8).toString('hex');
  let master = envKey();
  let keySource: VaultMeta['key_source'] = 'env';
  if (!master) {
    if (!keychainAvailable()) {
      throw new VaultError(400, 'no Keychain on this system: set PST_MASTER_KEY or PST_MASTER_KEY_FILE (e.g. from `openssl rand -hex 32`)');
    }
    master = generateKey();
    keychainSet(`vault-${id}`, master.toString('hex'));
    keySource = 'keychain';
  }
  for (const dir of ['.vault', 'logbook', ...DOC_FOLDERS]) fs.mkdirSync(path.join(home, dir), { recursive: true, mode: 0o700 });
  const key = dataKey(master);
  writeAtomic(path.join(home, KEYCHECK), sealJson(key, { vault: id }, 'keycheck'));
  writeAtomic(path.join(home, TOKENS), sealJson(key, { tokens: [] }, 'tokens'));
  writeAtomic(path.join(home, CONFIG), JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  const meta: VaultMeta = { version: 1, id, key_source: keySource, created_at: localIso() };
  writeAtomic(path.join(home, META), JSON.stringify(meta, null, 2) + '\n');
  return openVault(home);
}

export function openVault(home: string = vaultHome()): Vault {
  let meta: VaultMeta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(home, META), 'utf8')) as VaultMeta;
  } catch {
    throw new VaultError(404, `no vault at ${home}: run \`pst init\` first`);
  }
  let master = envKey();
  if (!master && meta.key_source === 'keychain') {
    const hex = keychainGet(`vault-${meta.id}`);
    if (hex) master = parseKey(hex);
  }
  if (!master) throw new VaultError(500, 'vault key not available: Keychain item missing and PST_MASTER_KEY not set');
  const key = dataKey(master);
  let check: { vault?: string } | undefined;
  try {
    check = openJson(key, fs.readFileSync(path.join(home, KEYCHECK)), 'keycheck') as { vault?: string };
  } catch {}
  if (check?.vault !== meta.id) throw new VaultError(500, 'the vault key does not match this vault');
  return new Vault(home, meta, key);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Vault {
  readonly home: string;
  readonly meta: VaultMeta;
  readonly #key: Buffer;

  constructor(home: string, meta: VaultMeta, key: Buffer) {
    this.home = home;
    this.meta = meta;
    this.#key = key;
  }

  #file(...parts: string[]): string {
    return path.join(this.home, ...parts);
  }

  #open<T>(sealed: Buffer, aad: string, what: string): T {
    try {
      return openJson(this.#key, sealed, aad) as T;
    } catch {
      throw new VaultError(500, `${what} is corrupted or was modified outside the vault`);
    }
  }

  // ---- config -------------------------------------------------------------

  readConfig(): VaultConfig {
    let raw: Partial<VaultConfig> = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.#file(CONFIG), 'utf8')) as Partial<VaultConfig>;
    } catch {}
    return { curator: { ...DEFAULT_CONFIG.curator, ...raw.curator } };
  }

  writeConfig(config: VaultConfig): void {
    writeAtomic(this.#file(CONFIG), JSON.stringify(config, null, 2) + '\n');
  }

  // ---- documents ----------------------------------------------------------

  #docFile(id: string): string {
    return this.#file(...id.split('/')) + '.md.enc';
  }

  #historyDir(id: string): string {
    return this.#file(HISTORY, ...id.split('/'));
  }

  listDocs(prefix = ''): DocInfo[] {
    const want = prefix.trim().replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '').toLowerCase();
    return DOC_FOLDERS.flatMap((folder) => walkFiles(this.#file(folder), '.md.enc'))
      .map((file) => ({
        id: path.relative(this.home, file).split(path.sep).join('/').slice(0, -'.md.enc'.length),
        modified: localIso(fs.statSync(file).mtime),
      }))
      .filter((d) => !want || d.id === want || d.id.startsWith(want + '/'))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  readDoc(rawId: unknown): Doc {
    const id = normalizeDocId(rawId);
    let sealed: Buffer;
    try {
      sealed = fs.readFileSync(this.#docFile(id));
    } catch {
      throw new VaultError(404, `no document "${id}"`);
    }
    return { id, ...this.#open<Omit<Doc, 'id'>>(sealed, `doc:${id}`, `document "${id}"`) };
  }

  writeDoc(rawId: unknown, content: unknown, by: string): Omit<Doc, 'content'> {
    const id = normalizeDocId(rawId);
    if (typeof content !== 'string') throw new VaultError(400, '"content" must be a string');
    if (Buffer.byteLength(content) > MAX_DOC_BYTES) throw new VaultError(413, 'document is larger than 256 KB');
    const doc = { content, updated_at: localIso(), updated_by: by };
    this.#archive(id);
    writeAtomic(this.#docFile(id), sealJson(this.#key, doc, `doc:${id}`));
    return { id, updated_at: doc.updated_at, updated_by: by };
  }

  /** Moves the document into its history, so it can still be read with readVersion. */
  deleteDoc(rawId: unknown): { id: string; deleted: true } {
    const id = normalizeDocId(rawId);
    if (!fs.existsSync(this.#docFile(id))) throw new VaultError(404, `no document "${id}"`);
    this.#archive(id);
    return { id, deleted: true };
  }

  // The sealed file moves as-is: its AAD is still "doc:<id>", so it stays readable and unforgeable.
  #archive(id: string): void {
    const file = this.#docFile(id);
    if (!fs.existsSync(file)) return;
    const dir = this.#historyDir(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Version names must sort in archive order, even for two writes within one millisecond.
    const latest = fs.readdirSync(dir).filter((n) => n.endsWith('.md.enc')).sort().at(-1);
    const stamp = Math.max(Date.now(), latest ? Number(latest.slice(0, 13)) + 1 : 0);
    fs.renameSync(file, path.join(dir, `${stamp}-${crypto.randomBytes(2).toString('hex')}.md.enc`));
    const versions = fs.readdirSync(dir).filter((n) => n.endsWith('.md.enc')).sort();
    for (const old of versions.slice(0, -HISTORY_KEEP)) fs.rmSync(path.join(dir, old), { force: true });
  }

  listVersions(rawId: unknown): DocVersion[] {
    const id = normalizeDocId(rawId);
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.#historyDir(id)).filter((n) => n.endsWith('.md.enc'));
    } catch {}
    return names
      .map((n) => n.slice(0, -'.md.enc'.length))
      .sort()
      .reverse()
      .map((version) => ({ version, archived_at: localIso(new Date(Number(version.split('-')[0]))) }));
  }

  readVersion(rawId: unknown, version: string): Doc {
    const id = normalizeDocId(rawId);
    if (!VERSION_RE.test(version)) throw new VaultError(400, `bad version "${version}"`);
    let sealed: Buffer;
    try {
      sealed = fs.readFileSync(path.join(this.#historyDir(id), `${version}.md.enc`));
    } catch {
      throw new VaultError(404, `no version ${version} of "${id}"`);
    }
    return { id, ...this.#open<Omit<Doc, 'id'>>(sealed, `doc:${id}`, `version ${version} of "${id}"`) };
  }

  // ---- logbook ------------------------------------------------------------

  #logFile(date: string): string {
    return this.#file('logbook', date.slice(0, 4), date.slice(5, 7), `${date}.jsonl.enc`);
  }

  #readLogFile(file: string, date: string): { entries: LogEntry[]; unreadable: number } {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { entries: [], unreadable: 0 };
    }
    const entries: LogEntry[] = [];
    let unreadable = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        entries.push(openLine(this.#key, line, `log:${date}`) as LogEntry);
      } catch {
        unreadable++;
      }
    }
    return { entries, unreadable };
  }

  appendLog(input: LogInput, by: string): LogEntry {
    const entry = normalizeEntry(input, by);
    const date = entry.ts.slice(0, 10);
    appendLine(this.#logFile(date), sealLine(this.#key, entry, `log:${date}`));
    return entry;
  }

  /** Entries by the date they happened, newest first. `filter` hides entries a token may not see. */
  readLog({ from, to, tag, query, limit = 200, filter }: LogQuery = {}): { entries: LogEntry[]; unreadable: number } {
    const needle = query ? query.toLowerCase() : null;
    const entries: LogEntry[] = [];
    let unreadable = 0;
    for (const date of dateRange(from, to)) {
      const day = this.#readLogFile(this.#logFile(date), date);
      unreadable += day.unreadable;
      for (const e of day.entries.reverse()) {
        if (tag && !e.tags.some((t) => t === tag || t.startsWith(tag + '/'))) continue;
        if (needle && !JSON.stringify([e.action, e.item, e.details ?? null]).toLowerCase().includes(needle)) continue;
        if (filter && !filter(e)) continue;
        entries.push(e);
        if (entries.length >= limit) return { entries, unreadable };
      }
    }
    return { entries, unreadable };
  }

  /**
   * Entries written after `cursor`, oldest-written first: the curator's work queue. Day files are
   * skipped by mtime, so backdated entries written later are still found.
   */
  readLogSince(cursor: LogCursor | null, limit: number): { entries: LogEntry[]; remaining: number } {
    const since = cursor ? Date.parse(cursor.at) : -Infinity;
    const fresh: LogEntry[] = [];
    for (const file of walkFiles(this.#file('logbook'), '.jsonl.enc')) {
      if (fs.statSync(file).mtimeMs < since - 2_000) continue;
      const { entries } = this.#readLogFile(file, path.basename(file).slice(0, 10));
      fresh.push(...entries.filter((e) => isAfterCursor(e, cursor)));
    }
    fresh.sort(byLoggedAt);
    return { entries: fresh.slice(0, limit), remaining: Math.max(0, fresh.length - limit) };
  }

  // ---- tokens -------------------------------------------------------------
  // Tokens look like pst_<id>_<secret>. Only sha256(secret) is stored, inside the sealed registry,
  // so the registry can't be read or edited (e.g. to add a token) without the vault key.

  #readTokens(): TokenRecord[] {
    return this.#open<{ tokens: TokenRecord[] }>(fs.readFileSync(this.#file(TOKENS)), 'tokens', 'token registry').tokens;
  }

  #writeTokens(tokens: TokenRecord[]): void {
    writeAtomic(this.#file(TOKENS), sealJson(this.#key, { tokens }, 'tokens'));
  }

  createToken({ name, scopes, ttl = '90d' }: { name: string; scopes: unknown; ttl?: string | undefined }): { token: string; record: Token } {
    if (!NAME_RE.test(name)) throw new VaultError(400, `bad token name "${name}": use lowercase letters, digits, . _ -`);
    const validScopes = validateScopes(scopes);
    const ttlMs = parseTtl(ttl);
    const tokens = this.#readTokens();
    if (tokens.some((t) => t.name === name && !t.revoked_at)) {
      throw new VaultError(409, `an active token named "${name}" already exists; revoke it or pick another name`);
    }
    let id: string;
    do id = crypto.randomBytes(4).toString('hex');
    while (tokens.some((t) => t.id === id));
    const secret = crypto.randomBytes(32).toString('base64url');
    const record: TokenRecord = {
      id,
      name,
      scopes: validScopes,
      hash: sha256(secret).toString('hex'),
      created_at: localIso(),
      expires_at: ttlMs ? localIso(new Date(Date.now() + ttlMs)) : null,
      revoked_at: null,
    };
    this.#writeTokens([...tokens, record]);
    return { token: `pst_${id}_${secret}`, record: publicToken(record) };
  }

  listTokens(): Token[] {
    return this.#readTokens().map(publicToken);
  }

  revokeToken(ref: string): Token {
    const tokens = this.#readTokens();
    const record = tokens.find((t) => !t.revoked_at && (t.id === ref || t.name === ref));
    if (!record) throw new VaultError(404, `no active token "${ref}"`);
    record.revoked_at = localIso();
    this.#writeTokens(tokens);
    return publicToken(record);
  }

  authenticate(token: string): Token {
    const m = TOKEN_RE.exec(token);
    const record = m ? this.#readTokens().find((t) => t.id === m[1]) : undefined;
    if (!m || !record || !crypto.timingSafeEqual(Buffer.from(record.hash, 'hex'), sha256(m[2] as string))) {
      throw new VaultError(401, 'invalid token');
    }
    if (record.revoked_at) throw new VaultError(401, 'token revoked');
    if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) throw new VaultError(401, 'token expired');
    return publicToken(record);
  }

  // ---- curator state ------------------------------------------------------

  readCuratorState(): CuratorState {
    if (!fs.existsSync(this.#file(CURATOR))) return { cursor: null, last_attempt_at: null, runs: [] };
    return this.#open<CuratorState>(fs.readFileSync(this.#file(CURATOR)), 'curator', 'curator state');
  }

  writeCuratorState(state: CuratorState): void {
    writeAtomic(this.#file(CURATOR), sealJson(this.#key, state, 'curator'));
  }

  // ---- locks (mkdir is atomic, so this works across processes) -------------

  async withLock<T>(name: string, fn: () => Promise<T>, { waitMs = 0, staleMs = 30 * 60_000 } = {}): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const dir = this.#file(LOCKS, `${name}.lock`);
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        fs.mkdirSync(dir);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) {
            fs.rmSync(dir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) return { acquired: false };
        await sleep(200);
      }
    }
    try {
      return { acquired: true, value: await fn() };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ---- audit --------------------------------------------------------------

  audit(event: AuditEvent): void {
    try {
      const ts = localIso();
      const date = ts.slice(0, 10);
      appendLine(this.#file('.vault', 'audit', `${date}.jsonl.enc`), sealLine(this.#key, { ts, ...event }, `audit:${date}`));
    } catch {}
  }

  readAudit({ limit = 50, days = 30 } = {}): AuditRecord[] {
    const events: AuditRecord[] = [];
    for (const date of dateRange(shiftDate(today(), 1 - days), today(), days)) {
      let text: string;
      try {
        text = fs.readFileSync(this.#file('.vault', 'audit', `${date}.jsonl.enc`), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n').filter(Boolean).reverse()) {
        try {
          events.push(openLine(this.#key, line, `audit:${date}`) as AuditRecord);
        } catch {}
        if (events.length >= limit) return events;
      }
    }
    return events;
  }
}
