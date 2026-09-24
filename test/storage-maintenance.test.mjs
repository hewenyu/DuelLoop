import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../dist/storage.js';
import { executeCli } from '../dist/cli.js';

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'duelloop-maintenance-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function rejectsUnchanged(source, destination, code) {
  const before = { hash: sha(source), mode: statSync(source).mode, size: statSync(source).size };
  assert.throws(() => SqliteStore.restore(source, destination), { code });
  assert.deepEqual({ hash: sha(source), mode: statSync(source).mode, size: statSync(source).size }, before);
  assert.equal(existsSync(destination), false, 'Rejected backup must not create a restored database');
}
test('restore rejects empty, non-SQLite, foreign and unknown-schema backups without changing their bytes', t => {
  const dir = directory(t);
  const empty = join(dir, 'empty.sqlite'); writeFileSync(empty, '');
  rejectsUnchanged(empty, join(dir, 'empty-restored.sqlite'), 'STORAGE_FAILURE');
  const text = join(dir, 'text.sqlite'); writeFileSync(text, 'not a SQLite file'.repeat(20));
  rejectsUnchanged(text, join(dir, 'text-restored.sqlite'), 'STORAGE_FAILURE');
  for (const version of [0, 1, 2, 3]) {
    const source = join(dir, `foreign-${version}.sqlite`); const db = new DatabaseSync(source);
    db.exec(`CREATE TABLE unrelated (id INTEGER); PRAGMA user_version=${version};`); db.close();
    rejectsUnchanged(source, join(dir, `foreign-${version}-restored.sqlite`), [1, 2].includes(version) ? 'STORAGE_FAILURE' : 'VERSION_INCOMPATIBLE');
  }
});
test('restore validates required schema and artifact digests without repairing malformed sources', async t => {
  const dir = directory(t); const live = new SqliteStore(join(dir, 'live.sqlite'));
  live.putArtifact('snapshot', { scopeId: 'test', stable: true });
  const missingTable = join(dir, 'missing-table.sqlite'); const corruptArtifact = join(dir, 'corrupt-artifact.sqlite');
  await live.backup(missingTable); await live.backup(corruptArtifact); live.close();
  let db = new DatabaseSync(missingTable); db.exec('DROP TABLE intents'); db.close();
  rejectsUnchanged(missingTable, join(dir, 'missing-restored.sqlite'), 'STORAGE_FAILURE');
  db = new DatabaseSync(corruptArtifact); db.exec("UPDATE artifacts SET data='{}'"); db.close();
  rejectsUnchanged(corruptArtifact, join(dir, 'corrupt-restored.sqlite'), 'STORAGE_FAILURE');
});
test('valid backup restores content while keeping the original backup hash and permissions unchanged', async t => {
  const dir = directory(t); const source = join(dir, 'backup.sqlite');
  const store = new SqliteStore(join(dir, 'application.sqlite')); const artifact = store.putArtifact('snapshot', { scopeId: 'scope', data: [1, 2, 3] });
  store.appendEvent('test.evidence', 'scope', { artifact }); await store.backup(source); store.close();
  const before = { hash: sha(source), mode: statSync(source).mode };
  const restored = SqliteStore.restore(source, join(dir, 'restored.sqlite'));
  try {
    assert.deepEqual(restored.getArtifact(artifact), { scopeId: 'scope', data: [1, 2, 3] });
    assert.equal(restored.integrity().ok, true); assert.equal(restored.events({ scopeId: 'scope' }).length, 1);
  } finally { restored.close(); }
  assert.deepEqual({ hash: sha(source), mode: statSync(source).mode }, before);
});
test('restore rejects a live WAL database instead of copying only its base file', t => {
  const dir = directory(t); const source = join(dir, 'live.sqlite'); const store = new SqliteStore(source);
  try {
    store.putArtifact('snapshot', { scopeId: 'scope', uncheckpointed: true });
    assert(statSync(`${source}-wal`).size > 0);
    const walHash = sha(`${source}-wal`);
    rejectsUnchanged(source, join(dir, 'restored.sqlite'), 'STORAGE_FAILURE');
    assert.equal(sha(`${source}-wal`), walHash);
  } finally { store.close(); }
});
test('validation invalidation is exported under its affected scope, with reason and release references', async t => {
  const dir = directory(t); const configPath = join(dir, 'duelloop.json');
  await executeCli(['init', '--dir', dir, '--domain', 'kuhn', '--application', 'app-a', '--scope', 'scope-a']);
  await executeCli(['step', '--config', configPath]);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const store = new SqliteStore(join(dir, config.database));
  let validationDigest, release;
  try {
    store.bindScope('scope-b', 'app-b'); store.setActivationMode('scope-b', 'automatic_after_validation');
    const base = store.activeRelease('scope-a'); const old = store.release(base);
    const strategy = store.getArtifact(old.strategyDigest); strategy.version = 'v2'; strategy.parentVersion = 'v1';
    const strategyDigest = store.putArtifact('strategy', strategy);
    const run = store.createRun({ id: 'maintenance-fixture', scopeId: 'scope-a', baseReleaseDigest: base, researchSnapshotId: store.snapshot('scope-a', Date.now()), evaluationProtocolDigest: store.putArtifact('protocol', { id: 'maintenance-fixture' }, 'private'), status: 'created', data: {} });
    store.transitionRun(run.id, ['created'], 'researching'); store.transitionRun(run.id, ['researching'], 'candidate_locked'); store.transitionRun(run.id, ['candidate_locked'], 'final_evaluating'); store.transitionRun(run.id, ['final_evaluating'], 'completed_passed');
    validationDigest = store.putArtifact('validation_report', { candidateDigest: strategyDigest, baseReleaseDigest: base, dependencies: old.dependencies, status: 'passed', stage: 'final', modelKind: 'fixture', privateSeed: 'must-not-export' }, 'private');
    release = store.registerRelease({ strategyDigest, dependencies: old.dependencies, scopeId: 'scope-a', expectedActiveDigest: base, validationDigest, source: 'research', researchRunId: run.id });
    store.invalidateValidation(validationDigest, 'Corrected feedback invalidated this experiment');
    const events = store.events({ scopeId: 'scope-a' }).filter(event => event.type === 'validation.invalidated');
    assert.equal(events.length, 1); assert.equal(events[0].data.reason, 'Corrected feedback invalidated this experiment');
    assert.deepEqual(events[0].data.releaseDigests, [release]); assert.equal(events[0].data.validationDigest, validationDigest);
    assert.equal(store.events({ scopeId: 'scope-b' }).filter(event => event.type === 'validation.invalidated').length, 0);
    assert.equal(store.events({ scopeId: 'system' }).filter(event => event.type === 'validation.invalidated').length, 0);
  } finally { store.close(); }
  const exported = await executeCli(['export', '--config', configPath]);
  assert(exported.events.some(event => event.type === 'validation.invalidated' && event.data.validationDigest === validationDigest && event.data.reason.includes('Corrected feedback')));
  assert(!JSON.stringify(exported).includes('must-not-export'));
});
