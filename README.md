# personalitystore

An encrypted personal vault of your **personality**, **details** and **taste**, plus a dated
**logbook** of what you did. Your own agents (Claude Code, Codex, anything that speaks MCP) read it
with a scoped token, and a background **curator** keeps the profile up to date from the logbook.

```
~/.personalitystore/vault/
  personality/   communication.md, work-style.md, values.md …   how you think and work
  details/       sizes.md, devices.md, locations.md …           facts about you
  taste/         food.md, fashion/shoes.md, travel.md …         preferences per domain
  logbook/2026/10/2026-10-08.jsonl                              one timestamped entry per action
```

A logbook entry:

```json
{"id":"log_17031f363d6d","ts":"2026-10-08T21:39:20+04:00","logged_at":"2026-10-08T21:39:20.412+04:00",
 "agent":"claude-code","action":"purchased","item":"Nike Pegasus 41","details":{"size":"10"},"tags":["fashion/shoes"]}
```

## Install

macOS or Linux, Apple silicon / Intel / ARM. It's a single binary, so you need neither Bun nor Node:

```bash
curl -fsSL https://raw.githubusercontent.com/agentpersonality/personalitystore/main/install.sh | sh
```

This downloads the latest release for your platform, checks its SHA-256 checksum, and installs `pst` to
`~/.local/bin`. Set `PST_VERSION=v0.1.0` to pin a release, or `PST_INSTALL_DIR=…` to install elsewhere.
You can also download a binary directly from the
[releases page](https://github.com/agentpersonality/personalitystore/releases).

To update later:

```bash
pst upgrade --check           # is there a newer release?
pst upgrade                   # install it; restarts the vault service if it's running
pst upgrade --version v0.1.0  # install a specific release (also to roll back)
```

`pst upgrade` verifies the download against the release's checksums and test-runs it before swapping it
in, so a failed upgrade leaves your current `pst` untouched. Your vault isn't touched at all. Agents pick
up the new MCP server in their next session.

## Quick start

```bash
pst init                      # creates the vault; the key goes into macOS Keychain
pst service install           # runs the vault service and curator now and at every login
pst connect claude            # creates a token and prints the `claude mcp add …` command to run
pst connect codex             # same for Codex
```

Then fill it in, or let your agents do it:

```bash
pst write personality/communication <<< "- Short, direct answers"
pst log add --action purchased --item "Nike Pegasus 41" --tag fashion/shoes --details '{"size":"10"}'
pst ls
pst read taste/food
pst log show --from 2026-10-01
```

## How agents use it

```
agent ──MCP──▶ pst mcp (holds only PST_TOKEN) ──HTTP──▶ pst serve (holds the key) ──▶ encrypted files
                                                             └── curator ──▶ claude -p / codex exec
```

The MCP server gives agents six tools: `vault_whoami`, `vault_list`, `vault_read`, `vault_write`,
`logbook_append`, `logbook_search`. Every call is checked against the token's scopes and written to the
audit log (`pst audit`). The agent name on a logbook entry comes from the token, so an agent can't pretend
to be another one.

## The curator

The curator reads the logbook entries written since its last run and rewrites `personality/`, `details/`
and `taste/` documents to match. For example, two purchases of minimal black sneakers plus one rejected
chunky pair becomes "prefers minimal, dark sneakers" in `taste/fashion/shoes`.

- **When it runs:** at most every 6 hours by default. The vault service checks on start-up, every 15
  minutes, and whenever an agent comes alive: Claude Code and Codex start the MCP server with each session,
  and the server tells the vault. Nothing runs in your agent's session; the work happens in the vault
  service, in the background.
- **Where it left off:** a cursor over the logbook (by write time) records exactly what it has processed.
  After a sleep, a reboot or a week without agents, it picks up from there, works through any backlog in
  batches, and also finds entries that were backdated.
- **Safety:** it acts like any agent. It runs as `curator`, can write only `personality/`, `details/` and
  `taste/`, and every write is audited. Every overwritten document keeps its last 20 versions
  (`pst history <id>`, `pst read <id> --version <v>`). The model gets no tools and no MCP servers. If a run
  fails, the cursor stays put and it retries within the hour.

```bash
pst curator status            # what it processed, what's waiting, last run, next check
pst curator run               # run now
pst config set curator.intervalHours 12
pst config set curator.enabled false
```

### Which model it uses

It runs your own agent CLIs headless, so no API key is needed:

| Setting | Default | |
| --- | --- | --- |
| `curator.backend` | `claude` | `claude`, `codex`, or `command` |
| `curator.claudeModel` | `sonnet` | passed to `claude -p --model` |
| `curator.codexModel` | `null` (CLI default) | passed to `codex exec --model`, e.g. `gpt-5.6-luna` |
| `curator.command` | `null` | for `command`: any program that reads the prompt on stdin and prints `{"updates":[…]}`, e.g. a local model |
| `curator.maxEntriesPerRun` | `200` | entries per model call |

```bash
pst config set curator.backend codex
pst config set curator.codexModel gpt-5.6-luna
pst config set curator.command '["/usr/local/bin/my-local-llm", "--json"]'
```

### Scopes

| Scope | Allows |
| --- | --- |
| `read:taste` | every document under `taste/` |
| `read:taste/fashion` | `taste/fashion` and anything below it only |
| `write:personality` | create, replace or delete documents under `personality/` |
| `read:logbook` | all logbook entries |
| `read:logbook/fashion` | only entries tagged `fashion` or `fashion/…` |
| `append:logbook` | add entries (`append:logbook/food` limits it to entries tagged `food`) |
| `read:*` | everything |

`pst connect` gives your agents `read:personality read:details read:taste read:logbook append:logbook` by
default. The curator updates the documents, so agents don't need write access. Manage tokens with
`pst token create | list | revoke`. Tokens expire (default 90 days, 365 for `connect`) and are stored only
as hashes.

## Security model

- Every file is encrypted with AES-256-GCM using a key derived from a 32-byte master key. Each ciphertext is
  bound to its path, so a file can't be swapped or renamed into another document.
- The master key lives in macOS Keychain. On Linux or in the cloud, set `PST_MASTER_KEY` (64 hex chars, e.g.
  from `openssl rand -hex 32`) or `PST_MASTER_KEY_FILE` from your secret manager.
- The token registry and the curator's state are encrypted too, so nobody can add a token without the key.
- The service listens on `127.0.0.1:7457` only. For remote use, run `pst serve --host 0.0.0.0` behind TLS.
- The curator sends new logbook entries and current documents to the model behind the configured CLI
  (Anthropic for `claude`, OpenAI for `codex`). Use `command` to keep everything on your machine.
- Limits: file and folder names (like `taste/food`) are visible on disk, and on one machine any program
  running as you could ask Keychain for the key. Locally, tokens control what your agents may read, and the
  audit log records what they did. For a hard boundary, run the service on another host or under another user.

## Development

Written in TypeScript for [Bun](https://bun.sh) 1.2 or later.

```bash
bun install
bun run pst help        # run the CLI from source
bun test
bun run typecheck
bun run build           # standalone binary for this machine -> dist/pst
bun run build:all       # every release target -> dist/pst-<os>-<arch>
```

Sources are in `src/` (`vault.ts`, `access.ts`, `server.ts`, `mcp.ts`, `curator/`, `cli.ts`), and tests
are in `test/`.

## Releasing

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v0.1.0 && git push origin v0.1.0`

The release workflow (`.github/workflows/release.yml`) tests, builds and ad-hoc signs the binaries,
writes `checksums.txt`, and publishes a GitHub release. `install.sh` always fetches the latest release.
