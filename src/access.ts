// What one authenticated token may do. Every call is scope-checked and written to the audit log.

import { allows, normalizeDocId, normalizeTag } from './scopes.ts';
import type { Verb } from './scopes.ts';
import { VaultError } from './errors.ts';
import type { Vault } from './vault.ts';
import type { Doc, DocInfo, LogEntry, LogInput, LogQuery, Token } from './types.ts';

export class AgentSession {
  readonly vault: Vault;
  readonly token: Token;

  constructor(vault: Vault, token: Token) {
    this.vault = vault;
    this.token = token;
  }

  #audit(op: string, target: string, ok: boolean, error?: string): void {
    this.vault.audit({ actor: this.token.name, token_id: this.token.id, op, target, ok, ...(error && { error }) });
  }

  #require(verb: Verb, resource: string, op: string): void {
    if (allows(this.token.scopes, verb, resource)) return;
    this.#audit(op, resource, false, 'forbidden');
    throw new VaultError(403, `token "${this.token.name}" has no ${verb} access to ${resource}`);
  }

  whoami(): Pick<Token, 'name' | 'scopes' | 'expires_at'> {
    const { name, scopes, expires_at } = this.token;
    return { name, scopes, expires_at };
  }

  hello(): void {
    this.#audit('agent.hello', this.token.name, true);
  }

  listDocs(prefix = ''): DocInfo[] {
    const docs = this.vault.listDocs(prefix).filter((d) => allows(this.token.scopes, 'read', d.id));
    this.#audit('docs.list', prefix || '*', true);
    return docs;
  }

  readDoc(rawId: unknown): Doc {
    const id = normalizeDocId(rawId);
    this.#require('read', id, 'docs.read');
    const doc = this.vault.readDoc(id);
    this.#audit('docs.read', id, true);
    return doc;
  }

  writeDoc(rawId: unknown, content: unknown): Omit<Doc, 'content'> {
    const id = normalizeDocId(rawId);
    this.#require('write', id, 'docs.write');
    const result = this.vault.writeDoc(id, content, this.token.name);
    this.#audit('docs.write', id, true);
    return result;
  }

  deleteDoc(rawId: unknown): { id: string; deleted: true } {
    const id = normalizeDocId(rawId);
    this.#require('write', id, 'docs.delete');
    const result = this.vault.deleteDoc(id);
    this.#audit('docs.delete', id, true);
    return result;
  }

  /** append:logbook allows any entry; append:logbook/<tag> only entries whose tags all fall under it. */
  appendLog(input: LogInput): LogEntry {
    const tags = Array.isArray(input?.tags) ? input.tags.map(normalizeTag) : [];
    const scopes = this.token.scopes;
    const ok = allows(scopes, 'append', 'logbook') || (tags.length > 0 && tags.every((t) => allows(scopes, 'append', `logbook/${t}`)));
    if (!ok) {
      this.#audit('log.append', tags.length ? `logbook/${tags.join(',')}` : 'logbook', false, 'forbidden');
      throw new VaultError(403, `token "${this.token.name}" may not append ${tags.length ? `entries tagged ${tags.join(', ')}` : 'untagged entries'} to the logbook`);
    }
    const entry = this.vault.appendLog(input, this.token.name);
    this.#audit('log.append', entry.id, true);
    return entry;
  }

  /** read:logbook sees everything; read:logbook/<tag> sees only entries with a matching tag. */
  readLog(query: Omit<LogQuery, 'filter'> = {}): { entries: LogEntry[]; unreadable: number } {
    const scopes = this.token.scopes;
    const all = allows(scopes, 'read', 'logbook');
    if (!all && !scopes.some((s) => s.startsWith('read:logbook/'))) {
      this.#audit('log.read', 'logbook', false, 'forbidden');
      throw new VaultError(403, `token "${this.token.name}" has no read access to the logbook`);
    }
    const filter = all ? null : (e: LogEntry) => e.tags.some((t) => allows(scopes, 'read', `logbook/${t}`));
    const tag = query.tag ? normalizeTag(query.tag) : undefined;
    const result = this.vault.readLog({ ...query, tag, filter });
    this.#audit('log.read', `${query.from ?? ''}..${query.to ?? ''}${tag ? ` #${tag}` : ''}`, true);
    return result;
  }
}
