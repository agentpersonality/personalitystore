// Runs a prompt through one of the user's own agent CLIs (headless) or a custom command and
// returns the parsed JSON answer. The child gets no tools, no MCP servers and no hooks.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CuratorConfig } from '../types.ts';

const TIMEOUT_MS = 10 * 60_000;

export type Ask = (prompt: string, schema: object, config: CuratorConfig) => Promise<unknown>;

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function nvmBins(name: string): string[] {
  const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    return fs.readdirSync(root).sort().reverse().map((v) => path.join(root, v, 'bin', name));
  } catch {
    return [];
  }
}

/** Services started by launchd have a minimal PATH, so fall back to common install locations. */
export function resolveBinary(name: 'claude' | 'codex', configured: string | null): string | null {
  if (configured) return isExecutable(configured) ? configured : null;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && isExecutable(path.join(dir, name))) return path.join(dir, name);
  }
  const home = os.homedir();
  const fallbacks = {
    claude: [path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', ...nvmBins('claude')],
    codex: [
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      ...nvmBins('codex'),
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    ],
  }[name];
  return fallbacks.find(isExecutable) ?? null;
}

/**
 * Drops a parent agent session's variables (session ids, IPC sockets, proxy settings) so the CLI
 * runs as a fresh headless session with its own login.
 */
function childEnv(bin: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, PST_CURATOR: '1' };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || (key.startsWith('CLAUDE_CODE_') && !/^CLAUDE_CODE_(USE_|OAUTH_TOKEN$)/.test(key))) delete env[key];
  }
  // npm-installed CLIs are `#!/usr/bin/env node` scripts; with nvm, node sits next to them.
  env.PATH = [path.dirname(bin), env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function run(bin: string, args: string[], input: string, cwd: string): Promise<RunResult> {
  const proc = Bun.spawn([bin, ...args], { cwd, env: childEnv(bin), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
  }, TIMEOUT_MS);
  try {
    proc.stdin.write(input);
    await proc.stdin.end();
  } catch {} // the program may exit without reading its input
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) throw new Error(`${path.basename(bin)} timed out after ${TIMEOUT_MS / 60_000} minutes`);
  return { code, stdout, stderr };
}

function failure(bin: string, r: RunResult): Error {
  return new Error(`${path.basename(bin)} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-400)}`);
}

export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('model output is not JSON');
}

async function askClaude(prompt: string, schema: object, config: CuratorConfig): Promise<unknown> {
  const bin = resolveBinary('claude', config.claudePath);
  if (!bin) throw new Error('claude CLI not found; set curator.claudePath');
  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--no-session-persistence',
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools', '',
    ...(config.claudeModel ? ['--model', config.claudeModel] : []),
  ];
  // claude prints a JSON result (with the error message) even when it exits non-zero.
  const r = await run(bin, args, prompt, os.tmpdir());
  let out: { is_error?: boolean; result?: string; subtype?: string; structured_output?: unknown };
  try {
    out = JSON.parse(r.stdout) as typeof out;
  } catch {
    throw failure(bin, r);
  }
  if (out.is_error) throw new Error(`claude: ${out.result ?? out.subtype}`);
  return out.structured_output ?? parseJsonLoose(out.result ?? '');
}

async function askCodex(prompt: string, schema: object, config: CuratorConfig): Promise<unknown> {
  const bin = resolveBinary('codex', config.codexPath);
  if (!bin) throw new Error('codex CLI not found; set curator.codexPath');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-curator-'));
  try {
    const schemaFile = path.join(dir, 'schema.json');
    const outFile = path.join(dir, 'answer.json');
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    const args = [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--disable', 'hooks',
      '--cd', dir,
      '--output-schema', schemaFile,
      '--output-last-message', outFile,
      ...(config.codexModel ? ['--model', config.codexModel] : []),
      '-',
    ];
    const r = await run(bin, args, prompt, dir);
    if (r.code !== 0) throw failure(bin, r);
    return parseJsonLoose(fs.readFileSync(outFile, 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Any program that reads the prompt on stdin and prints the JSON answer, e.g. a local model. */
async function askCommand(prompt: string, _schema: object, config: CuratorConfig): Promise<unknown> {
  const [bin, ...args] = config.command ?? [];
  if (!bin) throw new Error('backend "command" needs curator.command, e.g. ["/path/to/program", "arg"]');
  const r = await run(bin, args, prompt, os.tmpdir());
  if (r.code !== 0) throw failure(bin, r);
  return parseJsonLoose(r.stdout);
}

export const askModel: Ask = (prompt, schema, config) => {
  switch (config.backend) {
    case 'claude':
      return askClaude(prompt, schema, config);
    case 'codex':
      return askCodex(prompt, schema, config);
    case 'command':
      return askCommand(prompt, schema, config);
    default:
      return Promise.reject(new Error(`unknown curator backend "${String(config.backend)}"`));
  }
};
