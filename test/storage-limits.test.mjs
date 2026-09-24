import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../dist/storage.js';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'duelloop-storage-limits-'));
  t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}
test('artifact limit counts canonical JSON UTF-8 bytes and never removes existing evidence', () => {
  const store = new SqliteStore(':memory:', { maxArtifactBytes: 10 });
  try {
    const preserved = store.putArtifact('evidence', '汉字'); // Two 3-byte characters plus JSON quotes: 8 bytes.
    assert.equal(store.getArtifact(preserved), '汉字');
    assert.throws(() => store.putArtifact('evidence', '汉字汉'), error => error.code === 'STORAGE_FAILURE' && error.context.artifactBytes === 11);
    assert.throws(() => store.putArtifact('evidence', '123456789'), { code: 'STORAGE_FAILURE' });
    assert.equal(store.putArtifact('evidence', '12345678').length, 64); // Exactly 10 bytes is allowed.
    assert.equal(store.listArtifacts().length, 2); assert.equal(store.getArtifact(preserved), '汉字');
    assert.equal(store.integrity().ok, true);
  } finally { store.close(); }
});
test('omitting storage options preserves uncapped artifact writes and invalid options are diagnosed', () => {
  const store = new SqliteStore();
  try { const text = 'x'.repeat(1024 * 1024); assert.equal(store.getArtifact(store.putArtifact('large', text)), text); }
  finally { store.close(); }
  for (const options of [{ maxDatabaseBytes: 0 }, { maxArtifactBytes: -1 }, { maxArtifactBytes: 0.5 }, { maxDatabaseBytes: Infinity }, { unknownQuota: 1 }]) {
    assert.throws(() => new SqliteStore(':memory:', options), { code: 'CONFIG_INVALID' });
  }
  assert.throws(() => new SqliteStore(':memory:', { maxDatabaseBytes: 1 }), { code: 'STORAGE_FAILURE' });
  assert.throws(() => new SqliteStore(':memory:', { maxDatabaseBytes: 4096 }), { code: 'STORAGE_FAILURE' });
});
test('database page limit rejects growth without pruning and survives reopen and backup recovery', async t => {
  const dir = directory(t); const path = join(dir, 'limited.sqlite'); const maxDatabaseBytes = 256 * 1024;
  const store = new SqliteStore(path, { maxDatabaseBytes }); const kept = []; let failure;
  try {
    for (let index = 0; index < 32; index++) {
      const value = { index, payload: 'x'.repeat(32 * 1024) };
      try { kept.push([store.putArtifact('evidence', value), value]); } catch (error) { failure = error; break; }
    }
    assert.equal(failure?.code, 'STORAGE_FAILURE', 'SQLite FULL must be translated to the public storage error');
    assert(kept.length > 0); assert.equal(store.listArtifacts().length, kept.length);
    for (const [hash, value] of kept) assert.deepEqual(store.getArtifact(hash), value);
    assert.equal(store.integrity().ok, true);
    const reader = new DatabaseSync(path, { readOnly: true });
    const pageCount = Number(reader.prepare('PRAGMA page_count').get().page_count);
    const pageSize = Number(reader.prepare('PRAGMA page_size').get().page_size); reader.close();
    assert(pageCount * pageSize <= maxDatabaseBytes);
    await store.backup(join(dir, 'backup.sqlite'));
  } finally { store.close(); }
  const reopened = new SqliteStore(path, { maxDatabaseBytes });
  assert.equal(reopened.listArtifacts().length, kept.length); assert.equal(reopened.integrity().ok, true); reopened.close();
  const restored = SqliteStore.restore(join(dir, 'backup.sqlite'), join(dir, 'restored.sqlite'));
  try { for (const [hash, value] of kept) assert.deepEqual(restored.getArtifact(hash), value); assert.equal(restored.integrity().ok, true); }
  finally { restored.close(); }
});
test('quota failures in event and feedback writes retain prior events and rollback partial feedback', t => {
  const dir = directory(t); const path = join(dir, 'events.sqlite'); const store = new SqliteStore(path, { maxDatabaseBytes: 256 * 1024 });
  try {
    store.appendEvent('existing', 'scope', { keep: true });
    assert.throws(() => store.appendEvent('too-large', 'scope', { payload: 'x'.repeat(1024 * 1024) }), { code: 'STORAGE_FAILURE' });
    const now = Date.now();
    assert.throws(() => store.recordFeedback({ feedbackId: 'x'.repeat(1024 * 1024), revision: 1, eventTime: now, receivedAt: now, applicationId: 'app', strategyScopeId: 'scope', trajectoryId: 'trajectory', metrics: { reward: 1 }, settled: true }), { code: 'STORAGE_FAILURE' });
    assert.deepEqual(store.events({ scopeId: 'scope' }).map(event => event.type), ['existing']);
    const reader = new DatabaseSync(path, { readOnly: true }); assert.equal(reader.prepare('SELECT count(*) AS n FROM feedback').get().n, 0); reader.close();
    assert.equal(store.integrity().ok, true);
  } finally { store.close(); }
});
test('a limit smaller than an existing database rejects opening without pruning or changing its contents', t => {
  const dir = directory(t); const path = join(dir, 'existing.sqlite');
  const original = new SqliteStore(path); const preserved = original.putArtifact('evidence', { payload: 'x'.repeat(128 * 1024) }); original.close();
  const before = readFileSync(path);
  assert.throws(() => new SqliteStore(path, { maxDatabaseBytes: 4096 }), { code: 'STORAGE_FAILURE' });
  assert.deepEqual(readFileSync(path), before);
  const reopened = new SqliteStore(path); assert.equal(reopened.getArtifact(preserved).payload.length, 128 * 1024); assert.equal(reopened.integrity().ok, true); reopened.close();
});
