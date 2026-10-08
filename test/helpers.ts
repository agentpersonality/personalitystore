import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { initVault } from '../src/vault.ts';
import type { Vault } from '../src/vault.ts';
import type { Ask } from '../src/curator/llm.ts';

export interface TempVault {
  home: string;
  vault: Vault;
  cleanup: () => void;
}

/** Each test vault gets its own folder and an env key, so tests never touch Keychain. */
export function tempVault(): TempVault {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-test-'));
  process.env.PST_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const vault = initVault(home);
  return { home, vault, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/** Every file under the vault as one string, to check that plaintext never reaches disk. */
export function allBytes(home: string): string {
  let out = '';
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out += fs.readFileSync(p, 'latin1');
    }
  };
  walk(home);
  return out;
}

/** A model stand-in: answers from `respond` and records every prompt. */
export function fakeModel(respond: (prompt: string, call: number) => unknown): { ask: Ask; prompts: string[] } {
  const prompts: string[] = [];
  const ask: Ask = async (prompt) => {
    prompts.push(prompt);
    return respond(prompt, prompts.length);
  };
  return { ask, prompts };
}

export const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();
