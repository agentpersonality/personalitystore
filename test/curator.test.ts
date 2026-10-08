import { test, describe } from 'bun:test';
import assert from 'node:assert/strict';
import { tempVault, fakeModel, hoursAgo } from './helpers.ts';
import { Curator, validateUpdates } from '../src/curator/curator.ts';
import { askModel } from '../src/curator/llm.ts';
import { advanceCursor, isAfterCursor } from '../src/logbook.ts';
import { DEFAULT_CONFIG } from '../src/vault.ts';
import type { LogEntry } from '../src/types.ts';

const shoes = { updates: [{ id: 'taste/fashion', content: '- Prefers minimal, dark sneakers', reason: 'two black sneaker purchases' }] };

describe('curator', () => {
  test('turns new logbook entries into document updates, as "curator"', async () => {
    const { vault, cleanup } = tempVault();
    try {
      vault.appendLog({ action: 'purchased', item: 'Black minimal sneakers', tags: ['fashion'] }, 'claude-code');
      vault.appendLog({ action: 'purchased', item: 'Black minimal sneakers, second pair', tags: ['fashion'] }, 'codex');
      const model = fakeModel(() => shoes);
      const curator = new Curator(vault, { ask: model.ask });

      const run = await curator.maybeRun('test');
      assert.equal(run?.processed, 2);
      assert.deepEqual(run?.changes, [{ id: 'taste/fashion', reason: 'two black sneaker purchases' }]);
      assert.equal(vault.readDoc('taste/fashion').updated_by, 'curator');
      assert.match(vault.readDoc('taste/fashion').content, /minimal, dark sneakers/);
      assert.match(model.prompts[0]!, /\[claude-code\] purchased: Black minimal sneakers/);
      assert.ok(vault.readAudit({ limit: 20 }).some((e) => e.actor === 'curator' && e.op === 'docs.write'));

      const status = curator.status();
      assert.equal(status.pending, 0);
      assert.equal(status.last_run?.processed, 2);
    } finally {
      cleanup();
    }
  });

  test('waits for the interval, then processes only what is new since last time', async () => {
    const { vault, cleanup } = tempVault();
    try {
      vault.appendLog({ action: 'liked', item: 'Thai green curry', tags: ['food'] }, 'claude-code');
      const model = fakeModel(() => ({ updates: [] }));
      const curator = new Curator(vault, { ask: model.ask });

      assert.ok(await curator.maybeRun('first'));
      vault.appendLog({ action: 'disliked', item: 'Overly sweet desserts', tags: ['food'] }, 'claude-code');

      assert.equal(curator.isDue(), false);
      assert.equal(await curator.maybeRun('too soon'), null);
      assert.equal(model.prompts.length, 1);
      assert.equal(curator.status().pending, 1);

      vault.writeCuratorState({ ...vault.readCuratorState(), last_attempt_at: hoursAgo(6.1) });
      const run = await curator.maybeRun('agent:codex');
      assert.equal(run?.processed, 1);
      assert.match(model.prompts[1]!, /Overly sweet desserts/);
      assert.doesNotMatch(model.prompts[1]!, /Thai green curry/);
    } finally {
      cleanup();
    }
  });

  test('the interval is configurable', async () => {
    const { vault, cleanup } = tempVault();
    try {
      const curator = new Curator(vault, { ask: fakeModel(() => ({ updates: [] })).ask });
      await curator.run('first');
      vault.writeCuratorState({ ...vault.readCuratorState(), last_attempt_at: hoursAgo(2) });
      assert.equal(curator.isDue(), false);
      vault.writeConfig({ curator: { ...DEFAULT_CONFIG.curator, intervalHours: 1 } });
      assert.equal(curator.isDue(), true);
      vault.writeConfig({ curator: { ...DEFAULT_CONFIG.curator, enabled: false } });
      assert.equal(curator.isDue(), false);
    } finally {
      cleanup();
    }
  });

  test('works through a backlog in batches and finds backdated entries', async () => {
    const { vault, cleanup } = tempVault();
    try {
      vault.writeConfig({ curator: { ...DEFAULT_CONFIG.curator, maxEntriesPerRun: 2 } });
      for (let i = 1; i <= 4; i++) vault.appendLog({ action: 'visited', item: `Cafe ${i}`, tags: ['food'] }, 'claude-code');
      vault.appendLog({ action: 'booked', item: 'Trip to Kyoto', tags: ['travel'], ts: '2025-03-01T09:00:00+04:00' }, 'codex');
      const model = fakeModel(() => ({ updates: [] }));

      const run = await new Curator(vault, { ask: model.ask }).run('backlog');
      assert.equal(run?.processed, 5);
      assert.equal(model.prompts.length, 3);
      assert.ok(model.prompts.some((p) => p.includes('Trip to Kyoto')));
      assert.equal(vault.readLogSince(vault.readCuratorState().cursor, 100).entries.length, 0);
    } finally {
      cleanup();
    }
  });

  test('a failed run keeps its place and retries within the hour', async () => {
    const { vault, cleanup } = tempVault();
    try {
      vault.appendLog({ action: 'purchased', item: 'Headphones', tags: ['tech'] }, 'codex');
      const failing = new Curator(vault, { ask: async () => { throw new Error('Credit balance is too low'); } });
      const run = await failing.run('test');
      assert.equal(run?.error, 'Credit balance is too low');
      assert.equal(vault.readCuratorState().cursor, null);
      assert.equal(failing.status().pending, 1);

      vault.writeCuratorState({ ...vault.readCuratorState(), last_attempt_at: hoursAgo(1.1) });
      assert.equal(failing.isDue(), true);
    } finally {
      cleanup();
    }
  });

  test('ignores updates outside personality/details/taste and unchanged documents', async () => {
    const { vault, cleanup } = tempVault();
    try {
      vault.writeDoc('taste/food', '- Spicy\n', 'owner');
      vault.appendLog({ action: 'ate', item: 'Vindaloo', tags: ['food'] }, 'claude-code');
      const model = fakeModel(() => ({
        updates: [
          { id: 'taste/food', content: '- Spicy', reason: 'same' },
          { id: '../../etc/passwd', content: 'x', reason: 'escape' },
          { id: 'logbook/food', content: 'x', reason: 'wrong folder' },
          { id: 'details/home', content: '- Lives in Dubai', reason: 'new fact' },
        ],
      }));
      const run = await new Curator(vault, { ask: model.ask }).run('test');
      assert.deepEqual(run?.changes.map((c) => c.id), ['details/home']);
      assert.equal(vault.readDoc('taste/food').updated_by, 'owner');
      assert.match(model.prompts[0]!, /<document id="taste\/food">/);
    } finally {
      cleanup();
    }
  });

  test('only one run at a time', async () => {
    const { vault, cleanup } = tempVault();
    try {
      vault.appendLog({ action: 'noted', item: 'x' }, 'a');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const curator = new Curator(vault, { ask: async () => { await gate; return { updates: [] }; } });
      const first = curator.run('one');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(curator.isDue(), false);
      assert.equal(await curator.run('two'), null);
      release();
      assert.equal((await first)?.processed, 1);
    } finally {
      cleanup();
    }
  });
});

describe('cursor', () => {
  const entry = (id: string, logged_at: string): LogEntry => ({ id, ts: logged_at, logged_at, agent: 'a', action: 'x', item: 'y', tags: [] });

  test('does not skip entries written in the same millisecond across batches', () => {
    const t = '2026-10-08T10:00:00.000+04:00';
    const a = entry('log_a', t);
    const b = entry('log_b', t);
    const c = entry('log_c', '2026-10-08T10:00:00.001+04:00');
    const afterA = advanceCursor(null, [a]);
    assert.deepEqual(afterA, { at: t, ids: ['log_a'] });
    assert.equal(isAfterCursor(a, afterA), false);
    assert.equal(isAfterCursor(b, afterA), true);
    const afterB = advanceCursor(afterA, [b]);
    assert.deepEqual(new Set(afterB?.ids), new Set(['log_a', 'log_b']));
    assert.equal(isAfterCursor(c, afterB), true);
  });
});

describe('model backends', () => {
  test('command backend pipes the prompt in and parses JSON out', async () => {
    const script = `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('noise\\n'+JSON.stringify({updates:[{id:'taste/tea',content:s.includes('matcha')?'- Likes matcha':'-',reason:'r'}]})))`;
    const out = await askModel('they ordered matcha', {}, { ...DEFAULT_CONFIG.curator, backend: 'command', command: [process.execPath, '-e', script] });
    assert.deepEqual(validateUpdates(out), [{ id: 'taste/tea', content: '- Likes matcha\n', reason: 'r' }]);
  });

  test('a failing command reports its error', async () => {
    const config = { ...DEFAULT_CONFIG.curator, backend: 'command' as const, command: [process.execPath, '-e', 'console.error("boom");process.exit(3)'] };
    await assert.rejects(askModel('x', {}, config), /exited 3: boom/);
  });
});
