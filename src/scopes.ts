// Vault paths and token scopes.
//
// Documents live in three folders and are addressed by id: "personality/communication",
// "details/sizes", "taste/fashion/shoes". The logbook is addressed as "logbook" or, per tag,
// "logbook/<tag>".
//
// A scope is "<verb>:<path>": read:taste, read:taste/fashion, write:personality, append:logbook,
// read:logbook/shoes, read:*. A scope covers its path and everything below it.

import { VaultError } from './errors.ts';

export const DOC_FOLDERS = ['personality', 'details', 'taste'] as const;
export type Verb = 'read' | 'write' | 'append';

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TAG = /^[a-z0-9][a-z0-9._-]{0,47}(\/[a-z0-9][a-z0-9._-]{0,47}){0,3}$/;
const isFolder = (s: string | undefined): boolean => (DOC_FOLDERS as readonly string[]).includes(s ?? '');

export function normalizeDocId(raw: unknown): string {
  const id = String(raw ?? '').trim().replace(/^\/+/, '').replace(/\.md$/i, '').toLowerCase();
  const [folder, ...rest] = id.split('/');
  if (!isFolder(folder) || rest.length < 1 || rest.length > 3 || !rest.every((p) => SEGMENT.test(p))) {
    throw new VaultError(400, `bad document id "${String(raw)}": use <${DOC_FOLDERS.join('|')}>/<name>, e.g. taste/food`);
  }
  return id;
}

export function normalizeTag(raw: unknown): string {
  const tag = String(raw ?? '').trim().replace(/^#/, '').toLowerCase();
  if (!TAG.test(tag)) throw new VaultError(400, `bad tag "${String(raw)}": use lowercase words like "fashion" or "fashion/shoes"`);
  return tag;
}

export function parseScope(raw: string): string {
  const m = /^(read|write|append):(.+)$/.exec(raw.trim().toLowerCase());
  if (!m) throw new VaultError(400, `bad scope "${raw}": expected <read|write|append>:<path>`);
  const verb = m[1] as Verb;
  const path = m[2] as string;
  if (path === '*') return `${verb}:*`;
  const [root, ...rest] = path.split('/');
  if (root === 'logbook') {
    if (verb === 'write') throw new VaultError(400, 'the logbook is append-only: use append:logbook');
    if (rest.length) normalizeTag(rest.join('/'));
  } else if (isFolder(root)) {
    if (verb === 'append') throw new VaultError(400, `append only applies to the logbook, not ${root}`);
    if (!rest.every((p) => SEGMENT.test(p))) throw new VaultError(400, `bad scope path "${path}"`);
  } else {
    throw new VaultError(400, `bad scope "${raw}": path must start with ${[...DOC_FOLDERS, 'logbook'].join(', ')} or be *`);
  }
  return `${verb}:${path}`;
}

export function validateScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes) || !scopes.length) throw new VaultError(400, 'a token needs at least one scope');
  return [...new Set(scopes.map((s) => parseScope(String(s))))];
}

export function allows(scopes: readonly string[], verb: Verb, resource: string): boolean {
  return scopes.some((scope) => {
    const i = scope.indexOf(':');
    const path = scope.slice(i + 1);
    return scope.slice(0, i) === verb && (path === '*' || resource === path || resource.startsWith(path + '/'));
  });
}
