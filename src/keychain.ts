// macOS Keychain access through the `security` tool.

const SERVICE = 'personalitystore';
const SAFE = /^[0-9a-z-]+$/;

export const keychainAvailable = (): boolean => process.platform === 'darwin';

export function keychainGet(account: string): string | null {
  try {
    const r = Bun.spawnSync(['security', 'find-generic-password', '-s', SERVICE, '-a', account, '-w'], { stdout: 'pipe', stderr: 'ignore' });
    return r.success ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** `security -i` reads the command from stdin, so the secret never shows up in the process list. */
export function keychainSet(account: string, secretHex: string): void {
  if (!SAFE.test(account) || !SAFE.test(secretHex)) throw new Error('keychain account and secret must be [0-9a-z-]');
  const r = Bun.spawnSync(['security', '-i'], {
    stdin: new TextEncoder().encode(`add-generic-password -U -s ${SERVICE} -a ${account} -l ${SERVICE} -w ${secretHex}\n`),
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (!r.success || keychainGet(account) !== secretHex) {
    throw new Error(`could not store the vault key in Keychain ${r.stderr.toString().trim()}`);
  }
}

export function keychainDelete(account: string): void {
  if (!SAFE.test(account)) return;
  Bun.spawnSync(['security', 'delete-generic-password', '-s', SERVICE, '-a', account], { stdout: 'ignore', stderr: 'ignore' });
}
