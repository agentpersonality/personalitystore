import { test, describe, spyOn } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tempVault, allBytes } from './helpers.ts';
import { openVault } from '../src/vault.ts';
import { seal, open, dataKey, generateKey } from '../src/crypto.ts';
import { allows, parseScope, normalizeDocId } from '../src/scopes.ts';
import { AgentSession } from '../src/access.ts';

describe('crypto', () => {
  const key = dataKey(generateKey());

  test('round-trips and rejects tampering, another location or another key', () => {
    const sealed = seal(key, Buffer.from('likes spicy food'), 'doc:taste/food');
    assert.equal(open(key, sealed, 'doc:taste/food').toString(), 'likes spicy food');
    assert.throws(() => open(key, sealed, 'doc:taste/drink'));
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1]! ^= 1;
    assert.throws(() => open(key, flipped, 'doc:taste/food'));
    assert.throws(() => open(dataKey(generateKey()), sealed, 'doc:taste/food'));
  });
});

describe('documents', () => {
  test('write, read, list and delete, with nothing readable on disk', () => {
    const { home, vault, cleanup } = tempVault();
    try {
      vault.writeDoc('taste/food', 'Loves Hyderabadi biryani', 'owner');
      vault.writeDoc('taste/fashion/shoes.md', 'Running shoes, size 10', 'owner');
      vault.writeDoc('personality/communication', 'Short answers', 'owner');
      assert.equal(vault.readDoc('taste/food').content, 'Loves Hyderabadi biryani');
      assert.equal(vault.readDoc('taste/food').updated_by, 'owner');
      assert.deepEqual(vault.listDocs('taste').map((d) => d.id), ['taste/fashion/shoes', 'taste/food']);
      assert.equal(vault.listDocs().length, 3);
      assert.ok(!allBytes(home).includes('biryani'));
      vault.deleteDoc('taste/food');
      assert.throws(() => vault.readDoc('taste/food'), /no document/);
    } finally {
      cleanup();
    }
  });

  test('keeps earlier versions, readable but sealed', () => {
    const { home, vault, cleanup } = tempVault();
    try {
      vault.writeDoc('taste/food', 'v1 spicy', 'owner');
      vault.writeDoc('taste/food', 'v2 spicy and sour', 'curator');
      vault.deleteDoc('taste/food');
      const versions = vault.listVersions('taste/food');
      assert.equal(versions.length, 2);
      assert.equal(vault.readVersion('taste/food', versions[0]!.version).content, 'v2 spicy and sour');
      assert.equal(vault.readVersion('taste/food', versions[1]!.version).content, 'v1 spicy');
      assert.ok(!allBytes(home).includes('spicy'));
      assert.throws(() => vault.readVersion('taste/food', '../../x'), /bad version/);
    } finally {
      cleanup();
    }
  });

  test('rejects ids outside the three folders', () => {
    for (const bad of ['../etc/passwd', 'taste/../../x', 'secrets/x', 'taste', '/etc/hosts', 'taste/.hidden', 'taste/a b']) {
      assert.throws(() => normalizeDocId(bad), /bad document id/, bad);
    }
    assert.equal(normalizeDocId('/Taste/Food.md'), 'taste/food');
  });

  test('a file copied to another name does not decrypt', () => {
    const { home, vault, cleanup } = tempVault();
    try {
      vault.writeDoc('taste/food', 'x', 'owner');
      fs.copyFileSync(path.join(home, 'taste', 'food.md.enc'), path.join(home, 'taste', 'drink.md.enc'));
      assert.throws(() => vault.readDoc('taste/drink'), /corrupted or was modified/);
    } finally {
      cleanup();
    }
  });

  test('opening with the wrong key fails', () => {
    const { home, cleanup } = tempVault();
    try {
      process.env.PST_MASTER_KEY = crypto.randomBytes(32).toString('hex');
      assert.throws(() => openVault(home), /does not match/);
    } finally {
      cleanup();
    }
  });
});

describe('logbook', () => {
  test('stores entries per local day and searches newest first', () => {
    const { home, vault, cleanup } = tempVault();
    try {
      vault.appendLog({ action: 'purchased', item: 'Nike Pegasus 41', tags: ['fashion/shoes'], details: { size: '10' }, ts: '2026-10-06T10:00:00+04:00' }, 'shopper');
      vault.appendLog({ action: 'liked', item: 'Thai green curry', tags: ['food'], ts: '2026-10-07T20:00:00+04:00' }, 'claude-code');
      vault.appendLog({ action: 'rejected', item: 'Leather jacket', tags: ['fashion'], ts: '2026-10-07T21:00:00+04:00' }, 'shopper');

      assert.ok(fs.existsSync(path.join(home, 'logbook', '2026', '10', '2026-10-07.jsonl.enc')));
      assert.ok(!allBytes(home).includes('Pegasus'));

      const all = vault.readLog({ from: '2026-10-01', to: '2026-10-08' }).entries;
      assert.deepEqual(all.map((e) => e.item), ['Leather jacket', 'Thai green curry', 'Nike Pegasus 41']);
      assert.equal(all[2]!.agent, 'shopper');
      assert.deepEqual(all[2]!.details, { size: '10' });

      assert.deepEqual(vault.readLog({ from: '2026-10-01', to: '2026-10-08', tag: 'fashion' }).entries.map((e) => e.item), ['Leather jacket', 'Nike Pegasus 41']);
      assert.deepEqual(vault.readLog({ from: '2026-10-07', to: '2026-10-07', query: 'curry' }).entries.map((e) => e.item), ['Thai green curry']);
      assert.equal(vault.readLog({ from: '2026-10-01', to: '2026-10-08', limit: 1 }).entries.length, 1);
    } finally {
      cleanup();
    }
  });

  test('validates entries', () => {
    const { vault, cleanup } = tempVault();
    try {
      assert.throws(() => vault.appendLog({ item: 'x' }, 'a'), /"action" is required/);
      assert.throws(() => vault.appendLog({ action: 'x', item: 'y', ts: '2026-10-07 10:00' }, 'a'), /ts must be ISO/);
      assert.throws(() => vault.appendLog({ action: 'x', item: 'y', tags: ['Bad Tag'] }, 'a'), /bad tag/);
      assert.throws(() => vault.readLog({ from: '2026-10-09', to: '2026-10-01' }), /after/);
      const entry = vault.appendLog({ action: 'noted', item: 'today' }, 'a');
      assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
      assert.match(entry.logged_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
      assert.equal(vault.readLog().entries[0]!.id, entry.id);
    } finally {
      cleanup();
    }
  });
});

describe('tokens', () => {
  test('authenticate, reject wrong secrets, revoke and expire', () => {
    const { home, vault, cleanup } = tempVault();
    try {
      const { token, record } = vault.createToken({ name: 'claude-code', scopes: ['read:taste', 'append:logbook'] });
      assert.equal(vault.authenticate(token).name, 'claude-code');
      assert.ok(!('hash' in record));
      assert.ok(!allBytes(home).includes('claude-code'), 'token registry is sealed');

      const forged = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      assert.throws(() => vault.authenticate(forged), /invalid token/);
      assert.throws(() => vault.authenticate('nope'), /invalid token/);
      assert.throws(() => vault.createToken({ name: 'claude-code', scopes: ['read:taste'] }), /already exists/);

      vault.revokeToken('claude-code');
      assert.throws(() => vault.authenticate(token), /revoked/);

      const short = vault.createToken({ name: 'short', scopes: ['read:taste'], ttl: '1h' });
      const now = Date.now();
      const clock = spyOn(Date, 'now').mockImplementation(() => now + 2 * 3_600_000);
      try {
        assert.throws(() => vault.authenticate(short.token), /expired/);
      } finally {
        clock.mockRestore();
      }
    } finally {
      cleanup();
    }
  });

  test('scope syntax', () => {
    assert.equal(parseScope('READ:Taste/Fashion'), 'read:taste/fashion');
    assert.throws(() => parseScope('write:logbook'), /append-only/);
    assert.throws(() => parseScope('append:taste'), /only applies to the logbook/);
    assert.throws(() => parseScope('read:secrets'), /must start with/);
    assert.ok(allows(['read:taste'], 'read', 'taste/fashion/shoes'));
    assert.ok(allows(['read:*'], 'read', 'details/sizes'));
    assert.ok(!allows(['read:taste/fashion'], 'read', 'taste/food'));
    assert.ok(!allows(['read:taste/fashion'], 'read', 'taste/fashionable'));
    assert.ok(!allows(['read:taste'], 'write', 'taste/food'));
  });
});

describe('agent sessions', () => {
  test('enforce scopes on documents and the logbook, and audit every call', () => {
    const { vault, cleanup } = tempVault();
    try {
      vault.writeDoc('taste/fashion', 'Minimal, dark colours', 'owner');
      vault.writeDoc('details/sizes', 'Shoe 10', 'owner');
      vault.appendLog({ action: 'purchased', item: 'Shoes', tags: ['fashion'], ts: '2026-10-07T10:00:00Z' }, 'owner');
      vault.appendLog({ action: 'booked', item: 'Flight', tags: ['travel'], ts: '2026-10-07T11:00:00Z' }, 'owner');

      const { token } = vault.createToken({ name: 'shopper', scopes: ['read:taste/fashion', 'read:logbook/fashion', 'append:logbook/fashion'] });
      const agent = new AgentSession(vault, vault.authenticate(token));

      assert.equal(agent.readDoc('taste/fashion').content, 'Minimal, dark colours');
      assert.throws(() => agent.readDoc('details/sizes'), /no read access/);
      assert.throws(() => agent.writeDoc('taste/fashion', 'x'), /no write access/);
      assert.deepEqual(agent.listDocs().map((d) => d.id), ['taste/fashion']);

      const seen = agent.readLog({ from: '2026-10-07', to: '2026-10-07' }).entries;
      assert.deepEqual(seen.map((e) => e.item), ['Shoes']);

      assert.equal(agent.appendLog({ action: 'liked', item: 'Black tee', tags: ['fashion'] }).agent, 'shopper');
      assert.throws(() => agent.appendLog({ action: 'booked', item: 'Hotel', tags: ['travel'] }), /may not append/);
      assert.throws(() => agent.appendLog({ action: 'noted', item: 'x' }), /untagged/);

      const audit = vault.readAudit({ limit: 100 });
      assert.ok(audit.some((e) => e.actor === 'shopper' && e.op === 'docs.read' && e.target === 'details/sizes' && !e.ok));
      assert.ok(audit.some((e) => e.actor === 'shopper' && e.op === 'docs.read' && e.target === 'taste/fashion' && e.ok));
    } finally {
      cleanup();
    }
  });
});
