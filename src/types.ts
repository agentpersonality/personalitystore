export type KeySource = 'keychain' | 'env';

export interface VaultMeta {
  version: 1;
  id: string;
  key_source: KeySource;
  created_at: string;
}

export interface TokenRecord {
  id: string;
  name: string;
  scopes: string[];
  /** sha256 of the token secret, hex */
  hash: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export type Token = Omit<TokenRecord, 'hash'>;

export interface Doc {
  id: string;
  content: string;
  updated_at: string;
  updated_by: string;
}

export interface DocInfo {
  id: string;
  modified: string;
}

export interface DocVersion {
  version: string;
  archived_at: string;
}

export interface LogEntry {
  id: string;
  /** When it happened. */
  ts: string;
  /** When it was written to the vault; the curator's cursor follows this. */
  logged_at: string;
  agent: string;
  action: string;
  item: string;
  details?: Record<string, unknown>;
  tags: string[];
}

export interface LogInput {
  action?: unknown;
  item?: unknown;
  details?: unknown;
  tags?: unknown;
  ts?: unknown;
}

export interface LogQuery {
  from?: string | undefined;
  to?: string | undefined;
  tag?: string | undefined;
  query?: string | undefined;
  limit?: number | undefined;
  filter?: ((entry: LogEntry) => boolean) | null | undefined;
}

export interface AuditEvent {
  actor: string;
  token_id?: string;
  op: string;
  target?: string;
  ok: boolean;
  error?: string;
}

export type AuditRecord = AuditEvent & { ts: string };

export type Backend = 'claude' | 'codex' | 'command';

export interface CuratorConfig {
  enabled: boolean;
  intervalHours: number;
  backend: Backend;
  claudeModel: string | null;
  codexModel: string | null;
  /** For backend "command": a program that reads the prompt on stdin and prints the JSON answer. */
  command: string[] | null;
  maxEntriesPerRun: number;
  claudePath: string | null;
  codexPath: string | null;
}

export interface VaultConfig {
  curator: CuratorConfig;
}

/** Everything logged up to `at`, plus these ids logged exactly at `at`, has been processed. */
export interface LogCursor {
  at: string;
  ids: string[];
}

export interface CuratorChange {
  id: string;
  reason: string;
}

export interface CuratorRun {
  trigger: string;
  started_at: string;
  finished_at: string;
  processed: number;
  changes: CuratorChange[];
  error?: string;
}

export interface CuratorState {
  cursor: LogCursor | null;
  last_attempt_at: string | null;
  /** Newest first. */
  runs: CuratorRun[];
}
