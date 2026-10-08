// Logbook entries and the local-time helpers they are bucketed by.

import crypto from 'node:crypto';
import { VaultError } from './errors.ts';
import { normalizeTag } from './scopes.ts';
import type { LogCursor, LogEntry, LogInput } from './types.ts';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** ISO 8601 in this machine's timezone, e.g. 2026-10-08T14:32:05+04:00, so a day file holds a local day. */
export function localIso(date: Date = new Date(), withMs = false): string {
  const offset = -date.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, withMs ? 23 : 19);
  return `${local}${offset >= 0 ? '+' : '-'}${pad(offset / 60)}:${pad(offset % 60)}`;
}

export const today = (): string => localIso().slice(0, 10);

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Dates from `to` back to `from`, newest first. Defaults to the last 7 days. */
export function dateRange(from?: string | null, to?: string | null, maxDays = 366): string[] {
  const end = to || today();
  const start = from || shiftDate(end, -6);
  for (const d of [start, end]) {
    if (!DATE.test(d) || Number.isNaN(Date.parse(d))) throw new VaultError(400, `bad date "${d}": use YYYY-MM-DD`);
  }
  if (start > end) throw new VaultError(400, '"from" is after "to"');
  const days: string[] = [];
  for (let d = end; d >= start; d = shiftDate(d, -1)) {
    if (days.length === maxDays) throw new VaultError(400, `date range is longer than ${maxDays} days`);
    days.push(d);
  }
  return days;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new VaultError(400, `"${field}" is required`);
  if (value.length > max) throw new VaultError(400, `"${field}" is longer than ${max} characters`);
  return value.trim();
}

/** `agent` comes from the authenticated token, never from the request body. */
export function normalizeEntry(input: LogInput, agent: string): LogEntry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new VaultError(400, 'entry must be a JSON object');
  const ts = input.ts == null ? localIso() : String(input.ts);
  if (!ISO.test(ts) || Number.isNaN(Date.parse(ts))) {
    throw new VaultError(400, 'ts must be ISO 8601 with a timezone, e.g. 2026-10-08T14:32:05+04:00');
  }
  if (input.tags != null && !Array.isArray(input.tags)) throw new VaultError(400, '"tags" must be a list');
  const tags = [...new Set(((input.tags as unknown[] | undefined) ?? []).map(normalizeTag))];
  if (tags.length > 20) throw new VaultError(400, 'at most 20 tags');
  const { details } = input;
  if (details != null && (typeof details !== 'object' || Array.isArray(details))) {
    throw new VaultError(400, '"details" must be a JSON object');
  }
  if (details != null && JSON.stringify(details).length > 8192) throw new VaultError(413, '"details" is larger than 8 KB');
  return {
    id: `log_${crypto.randomBytes(6).toString('hex')}`,
    ts,
    logged_at: localIso(new Date(), true),
    agent,
    action: text(input.action, 'action', 100),
    item: text(input.item, 'item', 500),
    ...(details != null && { details: details as Record<string, unknown> }),
    tags,
  };
}

const loggedAt = (e: LogEntry): number => Date.parse(e.logged_at);

/** Oldest-written first; ties broken by id so batches are deterministic. */
export function byLoggedAt(a: LogEntry, b: LogEntry): number {
  return loggedAt(a) - loggedAt(b) || a.id.localeCompare(b.id);
}

export function isAfterCursor(entry: LogEntry, cursor: LogCursor | null): boolean {
  if (!cursor) return true;
  const at = Date.parse(cursor.at);
  const t = loggedAt(entry);
  return t > at || (t === at && !cursor.ids.includes(entry.id));
}

/** Moves the cursor past `batch` (sorted by byLoggedAt). */
export function advanceCursor(cursor: LogCursor | null, batch: readonly LogEntry[]): LogCursor | null {
  const last = batch.at(-1);
  if (!last) return cursor;
  const at = loggedAt(last);
  const ids = batch.filter((e) => loggedAt(e) === at).map((e) => e.id);
  if (cursor && Date.parse(cursor.at) === at) ids.push(...cursor.ids);
  return { at: last.logged_at, ids: [...new Set(ids)] };
}
