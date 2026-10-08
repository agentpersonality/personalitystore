// `pst`: owner CLI for the vault. Local commands use the vault key directly (actor "owner");
// agents go through `pst serve` + `pst mcp` with a scoped token instead.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { initVault, openVault, VaultError } from './vault.ts';
import type { Vault } from './vault.ts';
import { startServer } from './server.ts';
import { runMcp, DEFAULT_URL } from './mcp.ts';
import { Curator } from './curator/curator.ts';
import { localIso } from './logbook.ts';
import { VERSION } from './version.ts';
import { DEFAULT_REPO, assetName, compareVersions, fetchRelease, installRelease } from './upgrade.ts';
import type { CuratorConfig, CuratorRun, LogEntry, Token } from './types.ts';

const OWN_AGENT_SCOPES = ['read:personality', 'read:details', 'read:taste', 'read:logbook', 'append:logbook'];
const LAUNCHD_LABEL = 'ai.personalitystore.vault';

/** True for the standalone binary from a release; false when run from source with bun. */
const COMPILED = Bun.main.startsWith('/$bunfs/');

/** How to run this same `pst` again: the compiled binary itself, or bun plus this script. */
function selfCommand(): string[] {
  return COMPILED ? [process.execPath] : [process.execPath, Bun.main];
}

const HELP = `pst ${VERSION}: personalitystore vault

  pst init                                   create the vault (key is stored in macOS Keychain)
  pst status
  pst ls [prefix]                            list documents, e.g. pst ls taste
  pst read <id> [--version v]                print a document, e.g. pst read taste/food
  pst history <id>                           list earlier versions of a document
  pst write <id> [--file f]                  write a document from a file or stdin
  pst rm <id>
  pst log add --action <a> --item <i> [--tag t]... [--details '{"k":"v"}'] [--ts iso]
  pst log show [--date d | --from d --to d] [--tag t] [--query q] [--limit n] [--json]
  pst curator status                         what the curator has processed and when it runs next
  pst curator run                            update personality/details/taste from the logbook now
  pst config [get [key] | set <key> <value>] e.g. pst config set curator.intervalHours 12
  pst token create <name> --scope <s>... [--ttl 90d|never]
  pst token list
  pst token revoke <id|name>
  pst connect <claude|codex> [--name n] [--scope s]... [--ttl t]
                                             create a token for your agent and print its MCP setup command
  pst audit [--limit n]
  pst serve [--host 127.0.0.1] [--port 7457] run the vault service (and the curator schedule)
  pst service <install|uninstall|status>     run the vault service at login (macOS launchd)
  pst mcp                                    MCP server on stdio (reads PST_TOKEN, PST_URL)
  pst upgrade [--check] [--version vX.Y.Z]   update pst to the latest release (or a chosen one)
  pst version

Scopes: read:<path>  write:<path>  append:logbook
  <path> is personality, details, taste, logbook, or deeper: taste/fashion, logbook/shoes. read:* reads everything.
Env: PST_HOME (vault folder, default ~/.personalitystore/vault), PST_MASTER_KEY or PST_MASTER_KEY_FILE
     (use instead of Keychain), PST_URL (default ${DEFAULT_URL}), PST_TOKEN.`;

function need(value: string | undefined, usage: string): string {
  if (!value) throw new VaultError(400, `usage: ${usage}`);
  return value;
}

const when = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : 'never');

function printLog(entries: LogEntry[]): void {
  for (const e of entries) {
    const tags = e.tags.length ? '  ' + e.tags.map((t) => `#${t}`).join(' ') : '';
    const details = e.details ? `  ${JSON.stringify(e.details)}` : '';
    console.log(`${when(e.ts)}  ${e.agent.padEnd(12)}  ${e.action.padEnd(12)}  ${e.item}${tags}${details}`);
  }
}

function printTokens(tokens: Token[]): void {
  const now = Date.now();
  for (const t of tokens) {
    const status = t.revoked_at ? 'revoked' : t.expires_at && Date.parse(t.expires_at) <= now ? 'expired' : 'active';
    const expires = t.expires_at ? `expires ${t.expires_at.slice(0, 10)}` : 'no expiry';
    console.log(`${t.id}  ${t.name.padEnd(16)}  ${status.padEnd(8)}  ${expires.padEnd(18)}  ${t.scopes.join(' ')}`);
  }
}

function printRun(run: CuratorRun | null, label = ''): void {
  if (!run) return console.log(`${label}no run yet`);
  const indent = ' '.repeat(label.length);
  console.log(`${label}${when(run.started_at)} (${run.trigger}): ${run.processed} entries, ${run.changes.length} documents updated`);
  for (const c of run.changes) console.log(`${indent}  ${c.id}${c.reason ? `: ${c.reason}` : ''}`);
  if (run.error) console.log(`${indent}  error: ${run.error}`);
}

function backendLabel(c: CuratorConfig): string {
  const model = c.backend === 'claude' ? c.claudeModel : c.backend === 'codex' ? c.codexModel : null;
  return `${c.backend}${model ? ` (${model})` : ''}`;
}

function printCuratorStatus(vault: Vault): void {
  const s = new Curator(vault).status();
  const config = vault.readConfig().curator;
  console.log(`curator     ${s.enabled ? 'on' : 'off'} · every ${s.interval_hours}h · backend ${backendLabel(config)}`);
  console.log(`processed   logbook up to ${when(s.processed_up_to)} · ${s.pending} new ${s.pending === 1 ? 'entry' : 'entries'} waiting`);
  printRun(s.last_run, 'last run    ');
  if (s.enabled) console.log(`next check  ${when(s.next_check_at)} (or when an agent starts, if due by then)`);
}

// ---- config -----------------------------------------------------------------

type ConfigKey = keyof CuratorConfig;
const CONFIG_KEYS: Record<ConfigKey, (raw: string) => unknown> = {
  enabled: (raw) => {
    if (raw !== 'true' && raw !== 'false') throw new VaultError(400, 'curator.enabled is true or false');
    return raw === 'true';
  },
  intervalHours: (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0.25 || n > 24 * 30) throw new VaultError(400, 'curator.intervalHours is a number of hours between 0.25 and 720');
    return n;
  },
  backend: (raw) => {
    if (!['claude', 'codex', 'command'].includes(raw)) throw new VaultError(400, 'curator.backend is claude, codex or command');
    return raw;
  },
  claudeModel: (raw) => (raw === 'null' || raw === 'default' ? null : raw),
  codexModel: (raw) => (raw === 'null' || raw === 'default' ? null : raw),
  claudePath: (raw) => (raw === 'null' ? null : path.resolve(raw)),
  codexPath: (raw) => (raw === 'null' ? null : path.resolve(raw)),
  command: (raw) => {
    if (raw === 'null') return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {}
    if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === 'string')) {
      throw new VaultError(400, 'curator.command is a JSON list, e.g. \'["/usr/local/bin/my-llm", "--json"]\'');
    }
    return value;
  },
  maxEntriesPerRun: (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 2000) throw new VaultError(400, 'curator.maxEntriesPerRun is an integer from 1 to 2000');
    return n;
  },
};

function configCommand(vault: Vault, [sub, key, value]: string[]): void {
  const config = vault.readConfig();
  if (!sub || (sub === 'get' && !key)) return console.log(JSON.stringify(config, null, 2));
  const field = key?.replace(/^curator\./, '') as ConfigKey | undefined;
  if (!field || !(field in CONFIG_KEYS)) {
    throw new VaultError(400, `unknown key "${key}"; keys: ${Object.keys(CONFIG_KEYS).map((k) => `curator.${k}`).join(', ')}`);
  }
  if (sub === 'get') return console.log(JSON.stringify(config.curator[field]));
  if (sub !== 'set' || value === undefined) throw new VaultError(400, 'usage: pst config set <key> <value>');
  vault.writeConfig({ ...config, curator: { ...config.curator, [field]: CONFIG_KEYS[field](value) } });
  vault.audit({ actor: 'owner', op: 'config.set', target: `curator.${field}`, ok: true });
  console.log(`curator.${field} = ${JSON.stringify(vault.readConfig().curator[field])}`);
}

// ---- service ----------------------------------------------------------------

async function serverUp(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

export function launchdPlist(): string {
  const logDir = path.join(os.homedir(), '.personalitystore', 'logs');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', ...(process.env.PST_HOME && { PST_HOME: process.env.PST_HOME }) };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${[...selfCommand(), 'serve'].map((a) => `<string>${esc(a)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, 'server.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, 'server.log'))}</string>
</dict>
</plist>
`;
}

const launchdDomain = () => `gui/${process.getuid?.()}`;

function launchctl(...args: string[]): string {
  const r = Bun.spawnSync(['launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (!r.success) throw new Error(r.stderr.toString().trim() || `launchctl ${args[0]} failed`);
  return r.stdout.toString();
}

/** Restarts the launchd vault service, if it is installed, so it runs the current binary. */
function restartService(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    launchctl('kickstart', '-k', `${launchdDomain()}/${LAUNCHD_LABEL}`);
    return true;
  } catch {
    return false;
  }
}

function service(action: string | undefined): void {
  if (process.platform !== 'darwin') throw new VaultError(400, 'pst service uses launchd (macOS); elsewhere run `pst serve` under your init system');
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const domain = launchdDomain();
  if (action === 'install') {
    openVault(); // fail early if the vault or its key is missing
    fs.mkdirSync(path.join(os.homedir(), '.personalitystore', 'logs'), { recursive: true });
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    try {
      launchctl('bootout', `${domain}/${LAUNCHD_LABEL}`);
    } catch {}
    fs.writeFileSync(plist, launchdPlist());
    launchctl('bootstrap', domain, plist);
    console.log(`installed ${plist}; the vault service and curator start now and at every login`);
  } else if (action === 'uninstall') {
    try {
      launchctl('bootout', `${domain}/${LAUNCHD_LABEL}`);
    } catch {}
    fs.rmSync(plist, { force: true });
    console.log('vault service removed');
  } else if (action === 'status') {
    try {
      launchctl('print', `${domain}/${LAUNCHD_LABEL}`);
      console.log('launchd: loaded');
    } catch {
      console.log('launchd: not installed');
    }
  } else {
    throw new VaultError(400, 'usage: pst service <install|uninstall|status>');
  }
}

function connectCommand(agent: 'claude' | 'codex', token: string): string {
  const env = [`PST_TOKEN=${token}`, ...(process.env.PST_URL ? [`PST_URL=${process.env.PST_URL}`] : [])];
  const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const launch = [...selfCommand(), 'mcp'].map(q).join(' ');
  if (agent === 'claude') return `claude mcp add personalitystore --scope user ${env.map((e) => `-e ${q(e)}`).join(' ')} -- ${launch}`;
  return `codex mcp add personalitystore ${env.map((e) => `--env ${q(e)}`).join(' ')} -- ${launch}`;
}

// ---- commands ---------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      return console.log(HELP);

    case 'version':
    case '--version':
    case '-v':
      return console.log(`pst ${VERSION}`);

    case 'init': {
      const vault = initVault();
      console.log(`vault created at ${vault.home} (key: ${vault.meta.key_source === 'keychain' ? 'macOS Keychain' : 'PST_MASTER_KEY'})`);
      console.log('next: `pst service install` (or `pst serve`), then `pst connect claude` / `pst connect codex`');
      return;
    }

    case 'status': {
      const vault = openVault();
      const active = vault.listTokens().filter((t) => !t.revoked_at && !(t.expires_at && Date.parse(t.expires_at) <= Date.now()));
      const url = process.env.PST_URL || DEFAULT_URL;
      console.log(`vault       ${vault.home}`);
      console.log(`key         ${vault.meta.key_source === 'keychain' ? 'macOS Keychain' : 'environment'}`);
      console.log(`documents   ${vault.listDocs().length}`);
      console.log(`tokens      ${active.length} active`);
      console.log(`service     ${(await serverUp(url)) ? `running at ${url}` : `not running at ${url}`}`);
      printCuratorStatus(vault);
      return;
    }

    case 'ls': {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      for (const d of openVault().listDocs(positionals[0] ?? '')) console.log(`${when(d.modified)}  ${d.id}`);
      return;
    }

    case 'read': {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { version: { type: 'string' } } });
      const vault = openVault();
      const id = need(positionals[0], 'pst read <id> [--version v]');
      const doc = values.version ? vault.readVersion(id, values.version) : vault.readDoc(id);
      process.stdout.write(doc.content.endsWith('\n') ? doc.content : doc.content + '\n');
      return;
    }

    case 'history': {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const vault = openVault();
      const id = need(positionals[0], 'pst history <id>');
      const versions = vault.listVersions(id);
      if (!versions.length) return console.log(`no earlier versions of ${id}`);
      for (const v of versions) {
        const doc = vault.readVersion(id, v.version);
        console.log(`${v.version}  replaced ${when(v.archived_at)}  (written ${when(doc.updated_at)} by ${doc.updated_by})`);
      }
      return;
    }

    case 'write': {
      const { positionals, values } = parseArgs({ args: rest, allowPositionals: true, options: { file: { type: 'string' } } });
      const id = need(positionals[0], 'pst write <id> [--file f]');
      const content = values.file ? fs.readFileSync(values.file, 'utf8') : await Bun.stdin.text();
      const vault = openVault();
      const result = vault.writeDoc(id, content, 'owner');
      vault.audit({ actor: 'owner', op: 'docs.write', target: result.id, ok: true });
      return console.log(`wrote ${result.id}`);
    }

    case 'rm': {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true });
      const vault = openVault();
      const result = vault.deleteDoc(need(positionals[0], 'pst rm <id>'));
      vault.audit({ actor: 'owner', op: 'docs.delete', target: result.id, ok: true });
      return console.log(`deleted ${result.id} (earlier versions remain in \`pst history ${result.id}\`)`);
    }

    case 'log': {
      const [sub, ...more] = rest;
      const vault = openVault();
      if (sub === 'add') {
        const { values } = parseArgs({
          args: more,
          options: {
            action: { type: 'string' },
            item: { type: 'string' },
            tag: { type: 'string', multiple: true },
            details: { type: 'string' },
            ts: { type: 'string' },
          },
        });
        let details: unknown;
        if (values.details) {
          try {
            details = JSON.parse(values.details);
          } catch {
            throw new VaultError(400, '--details must be JSON');
          }
        }
        const entry = vault.appendLog({ action: values.action, item: values.item, tags: values.tag, details, ts: values.ts }, 'owner');
        vault.audit({ actor: 'owner', op: 'log.append', target: entry.id, ok: true });
        return printLog([entry]);
      }
      if (sub === 'show') {
        const { values } = parseArgs({
          args: more,
          options: {
            date: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            tag: { type: 'string' },
            query: { type: 'string' },
            limit: { type: 'string' },
            json: { type: 'boolean' },
          },
        });
        const { entries, unreadable } = vault.readLog({
          from: values.date ?? values.from,
          to: values.date ?? values.to,
          tag: values.tag,
          query: values.query,
          limit: values.limit ? Number(values.limit) : 200,
        });
        if (values.json) console.log(JSON.stringify(entries, null, 2));
        else printLog(entries);
        if (unreadable) console.error(`warning: ${unreadable} logbook line(s) could not be decrypted`);
        return;
      }
      throw new VaultError(400, 'usage: pst log <add|show> ...');
    }

    case 'curator': {
      const vault = openVault();
      if (rest[0] === 'status' || rest[0] === undefined) return printCuratorStatus(vault);
      if (rest[0] === 'run') {
        console.log(`curating with ${backendLabel(vault.readConfig().curator)}…`);
        const run = await new Curator(vault).run('manual');
        if (!run) return console.log('a curator run is already in progress');
        printRun(run);
        if (run.error) process.exitCode = 1;
        return;
      }
      throw new VaultError(400, 'usage: pst curator <status|run>');
    }

    case 'config':
      return configCommand(openVault(), rest);

    case 'token': {
      const [sub, ...more] = rest;
      const vault = openVault();
      if (sub === 'create') {
        const { positionals, values } = parseArgs({
          args: more,
          allowPositionals: true,
          options: { scope: { type: 'string', multiple: true }, ttl: { type: 'string' } },
        });
        const { token, record } = vault.createToken({
          name: need(positionals[0], 'pst token create <name> --scope <s>...'),
          scopes: values.scope,
          ttl: values.ttl,
        });
        vault.audit({ actor: 'owner', op: 'token.create', target: `${record.id} ${record.name}`, ok: true });
        printTokens([record]);
        console.log(`\n${token}\n\nThis is the only time the token is shown.`);
        return;
      }
      if (sub === 'list') return printTokens(vault.listTokens());
      if (sub === 'revoke') {
        const { positionals } = parseArgs({ args: more, allowPositionals: true });
        const record = vault.revokeToken(need(positionals[0], 'pst token revoke <id|name>'));
        vault.audit({ actor: 'owner', op: 'token.revoke', target: `${record.id} ${record.name}`, ok: true });
        return console.log(`revoked ${record.id} ${record.name}`);
      }
      throw new VaultError(400, 'usage: pst token <create|list|revoke> ...');
    }

    case 'connect': {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { name: { type: 'string' }, scope: { type: 'string', multiple: true }, ttl: { type: 'string' } },
      });
      const agent = positionals[0];
      if (agent !== 'claude' && agent !== 'codex') throw new VaultError(400, 'usage: pst connect <claude|codex> [--name n] [--scope s]...');
      const vault = openVault();
      const { token, record } = vault.createToken({
        name: values.name ?? (agent === 'claude' ? 'claude-code' : 'codex'),
        scopes: values.scope ?? OWN_AGENT_SCOPES,
        ttl: values.ttl ?? '365d',
      });
      vault.audit({ actor: 'owner', op: 'token.create', target: `${record.id} ${record.name}`, ok: true });
      printTokens([record]);
      console.log(`\nRun this once to give ${agent === 'claude' ? 'Claude Code' : 'Codex'} access (it contains the token; it is not shown again):\n`);
      console.log(connectCommand(agent, token));
      return;
    }

    case 'audit': {
      const { values } = parseArgs({ args: rest, options: { limit: { type: 'string' } } });
      for (const e of openVault().readAudit({ limit: values.limit ? Number(values.limit) : 50 })) {
        const result = e.ok ? 'ok    ' : 'DENIED';
        console.log(`${e.ts.slice(0, 19).replace('T', ' ')}  ${e.actor.padEnd(14)}  ${result}  ${e.op.padEnd(12)}  ${e.target ?? ''}${e.error ? `  (${e.error})` : ''}`);
      }
      return;
    }

    case 'serve': {
      const { values } = parseArgs({ args: rest, options: { host: { type: 'string' }, port: { type: 'string' } } });
      const host = values.host ?? '127.0.0.1';
      const port = Number(values.port ?? 7457);
      const vault = openVault();
      const curator = new Curator(vault, { log: (m) => console.log(`${localIso()} ${m}`) });
      const server = startServer(vault, { hostname: host, port, curator });
      console.log(`${localIso()} pst ${VERSION}: vault ${vault.home} serving on http://${host}:${server.port}`);
      if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
        console.warn('warning: the vault is reachable from other machines; put it behind TLS before using it over a network');
      }
      curator.start();
      for (const sig of ['SIGINT', 'SIGTERM'] as const) {
        process.on(sig, () => {
          curator.stop();
          void server.stop().then(() => process.exit(0));
        });
      }
      return;
    }

    case 'service':
      return service(rest[0]);

    case 'mcp':
      return runMcp();

    case 'upgrade': {
      const { values } = parseArgs({ args: rest, options: { check: { type: 'boolean' }, version: { type: 'string' }, force: { type: 'boolean' } } });
      const release = await fetchRelease({
        repo: process.env.PST_REPO || DEFAULT_REPO,
        ...(process.env.PST_GITHUB_API && { api: process.env.PST_GITHUB_API }),
        tag: values.version,
      });
      const latest = release.tag.replace(/^v/, '');
      const diff = compareVersions(latest, VERSION);
      if (values.check) {
        return console.log(diff > 0 ? `pst ${latest} is available (you have ${VERSION}); run \`pst upgrade\`` : `pst ${VERSION} is up to date`);
      }
      if ((values.version ? diff === 0 : diff <= 0) && !values.force) return console.log(`pst ${VERSION} is already the ${values.version ? 'requested' : 'latest'} version`);
      if (!COMPILED) throw new VaultError(400, 'this pst runs from source; update it with `git pull` instead');
      const target = fs.realpathSync(process.execPath);
      console.log(`downloading pst ${latest} (${assetName()})…`);
      const reported = await installRelease(release, target);
      console.log(`upgraded pst ${VERSION} -> ${reported.replace(/^pst /, '')} at ${target}`);
      if (restartService()) console.log('restarted the vault service');
      console.log('Agents switch to the new MCP server in their next session.');
      return;
    }

    default:
      throw new VaultError(400, `unknown command "${cmd}"; run \`pst help\``);
  }
}
