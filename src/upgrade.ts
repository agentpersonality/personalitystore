// `pst upgrade`: replaces the installed binary with the latest (or a chosen) GitHub release.
// The download is checked against the release's checksums.txt and test-run before it replaces
// anything, and the swap is a rename, so a failed upgrade leaves the current binary untouched.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VERSION } from './version.ts';
import { VaultError, errorMessage } from './errors.ts';

export const DEFAULT_REPO = 'agentpersonality/personalitystore';
const GITHUB_API = 'https://api.github.com';

export interface Release {
  tag: string;
  /** asset name -> download URL */
  assets: Map<string, string>;
}

/** Compares "v1.2.3" / "1.2.3" style versions; negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export function assetName(platform: string = process.platform, arch: string = process.arch): string {
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new VaultError(400, `there is no prebuilt pst for ${platform}-${arch}`);
  }
  return `pst-${platform}-${arch}`;
}

const headers = { 'user-agent': `pst/${VERSION}` };

export async function fetchRelease({ repo = DEFAULT_REPO, api = GITHUB_API, tag }: { repo?: string; api?: string; tag?: string | undefined } = {}): Promise<Release> {
  const url = `${api}/repos/${repo}/releases/${tag ? `tags/${encodeURIComponent(tag.startsWith('v') ? tag : `v${tag}`)}` : 'latest'}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { ...headers, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new VaultError(502, `could not reach GitHub: ${errorMessage(err)}`);
  }
  // GitHub answers 404 both for "no such release" and for a private repository.
  if (res.status === 404) {
    throw new VaultError(404, `${tag ? `no release ${tag}` : 'no published release'} found in ${repo} (or the repository is private)`);
  }
  if (!res.ok) throw new VaultError(502, `GitHub answered ${res.status} for ${url}`);
  const body = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
  if (!body.tag_name) throw new VaultError(502, 'unexpected answer from GitHub');
  return { tag: body.tag_name, assets: new Map((body.assets ?? []).map((a) => [a.name, a.browser_download_url])) };
}

async function download(url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10 * 60_000) });
  } catch (err) {
    throw new VaultError(502, `download failed: ${errorMessage(err)}`);
  }
  if (!res.ok) throw new VaultError(502, `download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Downloads `asset` from `release`, verifies it, and atomically replaces `target`.
 * Returns what the new binary reports for `--version`, e.g. "pst 0.2.0".
 */
export async function installRelease(release: Release, target: string, asset: string = assetName()): Promise<string> {
  const binaryUrl = release.assets.get(asset);
  const sumsUrl = release.assets.get('checksums.txt');
  if (!binaryUrl) throw new VaultError(502, `release ${release.tag} has no ${asset}`);
  if (!sumsUrl) throw new VaultError(502, `release ${release.tag} has no checksums.txt`);

  const [binary, sums] = await Promise.all([download(binaryUrl), download(sumsUrl)]);
  const expected = sums
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  if (!expected) throw new VaultError(502, `checksums.txt has no entry for ${asset}`);
  if (crypto.createHash('sha256').update(binary).digest('hex') !== expected) {
    throw new VaultError(502, `checksum mismatch for ${asset}; nothing was changed`);
  }

  // Stage next to the target so the final rename stays on one filesystem. A rename gives the new
  // binary a fresh inode, which also keeps macOS from reusing the old binary's code signature.
  const staged = path.join(path.dirname(target), `.pst-upgrade-${process.pid}`);
  try {
    fs.writeFileSync(staged, binary);
    fs.chmodSync(staged, 0o755);
  } catch (err) {
    fs.rmSync(staged, { force: true });
    throw new VaultError(403, `cannot write to ${path.dirname(target)} (${errorMessage(err)}); reinstall with install.sh instead`);
  }
  try {
    const check = Bun.spawnSync([staged, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const reported = check.stdout.toString().trim();
    if (!check.success || !reported.startsWith('pst ')) {
      throw new VaultError(502, `the downloaded binary did not run: ${(check.stderr.toString() || reported).trim().slice(0, 200)}`);
    }
    fs.renameSync(staged, target);
    return reported;
  } finally {
    fs.rmSync(staged, { force: true });
  }
}
