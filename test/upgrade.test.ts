import { test, describe, beforeAll, afterAll } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { assetName, compareVersions, fetchRelease, installRelease } from '../src/upgrade.ts';

const ASSET = 'pst-test-arm64';
const NEW_BINARY = '#!/bin/sh\necho "pst 9.9.9"\n';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// A stand-in for GitHub: the releases API plus the asset downloads it points to.
let server: ReturnType<typeof Bun.serve>;
let api: string;
const files: Record<string, string> = {};

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const release = (tag: string, dir: string) =>
        Response.json({
          tag_name: tag,
          assets: [ASSET, 'checksums.txt'].map((name) => ({ name, browser_download_url: `${api}/download/${dir}/${name}` })),
        });
      if (pathname === '/repos/me/pst/releases/latest') return release('v9.9.9', 'good');
      if (pathname === '/repos/me/pst/releases/tags/v8.0.0') return release('v8.0.0', 'tampered');
      if (pathname === '/repos/me/pst/releases/tags/v7.0.0') return Response.json({ tag_name: 'v7.0.0', assets: [] });
      const file = files[pathname];
      return file === undefined ? new Response('not found', { status: 404 }) : new Response(file);
    },
  });
  api = `http://127.0.0.1:${server.port}`;
  files['/download/good/' + ASSET] = NEW_BINARY;
  files['/download/good/checksums.txt'] = `${sha(NEW_BINARY)}  ${ASSET}\n${sha('other')}  pst-other\n`;
  files['/download/tampered/' + ASSET] = NEW_BINARY + 'echo extra\n';
  files['/download/tampered/checksums.txt'] = `${sha(NEW_BINARY)}  ${ASSET}\n`;
});

afterAll(() => {
  void server.stop(true);
});

function installedBinary(): { dir: string; target: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-upgrade-'));
  const target = path.join(dir, 'pst');
  fs.writeFileSync(target, '#!/bin/sh\necho "pst 0.1.0"\n', { mode: 0o755 });
  return { dir, target };
}

describe('upgrade', () => {
  test('compares versions', () => {
    assert.ok(compareVersions('v0.2.0', '0.1.9') > 0);
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
    assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
  });

  test('picks the release asset for this platform', () => {
    assert.equal(assetName('darwin', 'arm64'), 'pst-darwin-arm64');
    assert.equal(assetName('linux', 'x64'), 'pst-linux-x64');
    assert.throws(() => assetName('win32', 'x64'), /no prebuilt pst/);
  });

  test('installs the latest release after checking its checksum and running it', async () => {
    const { dir, target } = installedBinary();
    try {
      const release = await fetchRelease({ repo: 'me/pst', api });
      assert.equal(release.tag, 'v9.9.9');
      assert.equal(await installRelease(release, target, ASSET), 'pst 9.9.9');
      assert.equal(fs.readFileSync(target, 'utf8'), NEW_BINARY);
      assert.equal(fs.statSync(target).mode & 0o777, 0o755);
      assert.deepEqual(fs.readdirSync(dir), ['pst'], 'no staging file left behind');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves the current binary alone when the download does not match its checksum', async () => {
    const { dir, target } = installedBinary();
    try {
      const release = await fetchRelease({ repo: 'me/pst', api, tag: '8.0.0' });
      await assert.rejects(installRelease(release, target, ASSET), /checksum mismatch/);
      assert.match(fs.readFileSync(target, 'utf8'), /pst 0\.1\.0/);
      assert.deepEqual(fs.readdirSync(dir), ['pst']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explains missing releases and assets', async () => {
    await assert.rejects(fetchRelease({ repo: 'me/nothing', api }), /no published release found in me\/nothing/);
    await assert.rejects(fetchRelease({ repo: 'me/pst', api, tag: 'v1.2.3' }), /no release v1\.2\.3 found/);
    const empty = await fetchRelease({ repo: 'me/pst', api, tag: 'v7.0.0' });
    await assert.rejects(installRelease(empty, '/nonexistent/pst', ASSET), /has no pst-test-arm64/);
  });

  test('the CLI reports updates, and refuses to replace itself when run from source', async () => {
    // Async spawn: this process also serves the fake GitHub, so it must not block while the child runs.
    const pst = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, '..', 'src', 'bin', 'pst.ts'), ...args], {
        env: { ...process.env, PST_REPO: 'me/pst', PST_GITHUB_API: api },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return (out + err).trim();
    };
    assert.match(await pst('upgrade', '--check'), /pst 9\.9\.9 is available \(you have 0\.1\.0\)/);
    assert.match(await pst('upgrade'), /runs from source; update it with `git pull`/);
  });
});
