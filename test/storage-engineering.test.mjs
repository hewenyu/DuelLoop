import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { SqliteStore } from '../dist/storage.js';

function location(t) {
  const dir = mkdtempSync(join(tmpdir(), 'duelloop-engineering-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'application.sqlite');
}
function bootstrap(store, scopeId = 'scope') {
  const release = store.registerRelease({ strategyDigest: store.putArtifact('strategy', { version: '1' }), dependencies: {}, scopeId, expectedActiveDigest: null, validationDigest: null, source: 'bootstrap' });
  store.activate(release, {}); return release;
}
function feedback(id, revision, receivedAt, reward = revision) {
  return { feedbackId: id, revision, receivedAt, eventTime: receivedAt - 1, applicationId: 'app', strategyScopeId: 'scope', trajectoryId: 'trajectory', metrics: { reward }, settled: true };
}
function intent(decisionId, streamId = 'stream', receipt = null) {
  return { decisionId, scopeId: 'scope', streamId, ownerToken: 'owner', command: { idempotencyKey: decisionId }, receipt };
}
function insertIntent(db, value) {
  db.prepare('INSERT INTO intents(decision_id,scope_id,stream_id,idem,data,status) VALUES(?,?,?,?,?,?)').run(value.decisionId, value.scopeId, value.streamId, value.command.idempotencyKey, JSON.stringify(value), value.receipt?.status ?? 'pending');
}

function downgradeToSchemaOne(db) {
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) db.exec(`DROP INDEX "${row.name}"`);
  for (const table of ['feedback_latest', 'holdout_resources', 'holdout_caps', 'holdout_seeds', 'receipt_events', 'first_settlements']) db.exec(`DROP TABLE ${table}`);
  for (const column of ['activated', 'invalid_reason', 'expected_active', 'validation_digest', 'last_deferral_id']) db.exec(`ALTER TABLE releases DROP COLUMN ${column}`);
  db.exec('ALTER TABLE intents DROP COLUMN status; PRAGMA user_version=1;');
}

test('scope and kind queries exclude malformed unrelated history before JSON parsing; indexed unresolved and primary-key intent lookups remain exact', t => {
  const path = location(t); const store = new SqliteStore(path); t.after(() => store.close());
  store.appendEvent('wanted', 'scope', { good: true });
  store.putArtifact('wanted', { good: true });
  const db = new DatabaseSync(path); t.after(() => db.close());
  db.prepare('INSERT INTO events(type,scope_id,timestamp,visibility,data) VALUES(?,?,?,?,?)').run('other', 'elsewhere', 1, 'public', 'bad JSON');
  db.prepare('INSERT INTO artifacts VALUES(?,?,?,?)').run('unrelated', 'other', 'public', 'bad JSON');
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run('unrelated', 'elsewhere', 'created', 0, 'bad JSON');
  db.prepare('INSERT INTO intents(decision_id,scope_id,stream_id,idem,data,status) VALUES(?,?,?,?,?,?)').run('other', 'elsewhere', 'stream', 'other', 'bad JSON', 'completed');
  insertIntent(db, intent('pending')); insertIntent(db, intent('accepted', 'other-stream', { status: 'accepted' })); insertIntent(db, intent('completed', 'stream', { status: 'completed' }));
  assert.equal(store.events({ scopeId: 'scope', types: ['wanted'], limit: 1 }).length, 1);
  assert.equal(store.listArtifacts('wanted').length, 1);
  assert.deepEqual(store.listRuns('scope'), []);
  assert.deepEqual(store.intents('scope').map(x => x.decisionId), ['pending', 'accepted', 'completed']);
  assert.equal(store.intent('completed').receipt.status, 'completed');
  assert.equal(store.intent('missing'), undefined);
  assert.deepEqual(store.unresolvedIntents('scope', 'stream').map(x => x.decisionId), ['pending']);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT data FROM intents WHERE status IN ('pending','accepted','unknown') AND scope_id=? AND stream_id=?").all('scope', 'stream');
  assert(plan.some(row => /USING INDEX intents_/.test(row.detail)), JSON.stringify(plan));
  assert(!plan.some(row => /SCAN intents/.test(row.detail)), JSON.stringify(plan));
});

test('feedback cursors consume higher revisions once and bounded snapshots preserve exact historical revisions without growing with history', t => {
  const path = location(t); const store = new SqliteStore(path); t.after(() => store.close());
  for (let i = 0; i < 20; i++) {
    store.appendEvent('decision', 'scope', { decisionId: `decision-${i}` });
    store.recordFeedback(feedback(`feedback-${i}`, 1, 100 + i));
  }
  const first = store.latestFeedback('scope'); const cursor = first.at(-1).eventId;
  assert.deepEqual(store.feedbackProgress('scope', 0), { eventId: cursor, receivedAt: 119, settledTrajectories: 1 });
  assert.deepEqual(store.feedbackProgress('scope', cursor), { eventId: cursor, receivedAt: 0, settledTrajectories: 0 });
  store.recordFeedback(feedback('feedback-19', 3, 201));
  store.recordFeedback(feedback('feedback-19', 2, 202)); // Older revisions arriving later never replace the current revision.
  const next = store.latestFeedback('scope', { afterEventId: cursor });
  assert.equal(next.length, 1); assert.equal(next[0].feedback.revision, 3);
  const frozen = store.snapshot('scope', Date.now(), { maxDecisions: 3, maxFeedback: 2 });
  const value = store.getArtifact(frozen);
  assert.equal(value.decisions.length, 3); assert.equal(value.feedback.length, 2);
  assert.deepEqual(value.decisions.map(x => x.decisionId), ['decision-17', 'decision-18', 'decision-19']);
  assert.equal(value.feedback.find(x => x.feedbackId === 'feedback-19').revision, 3);
  const historical = store.getArtifact(store.snapshot('scope', 200, { maxDecisions: 3, maxFeedback: 2 }));
  assert.equal(historical.feedback.find(x => x.feedbackId === 'feedback-19').revision, 1);
  store.recordFeedback(feedback('feedback-19', 4, 203));
  assert.equal(store.getArtifact(frozen).feedback.find(x => x.feedbackId === 'feedback-19').revision, 3);
  assert.deepEqual(value.window.mode, 'latest_bounded');
  assert.throws(() => store.snapshot('scope', Date.now(), { maxDecisions: 0 }), { code: 'CONFIG_INVALID' });
});

test('release scheduling projections distinguish pending, deferred, invalid and already activated candidates without scanning events', t => {
  const path = location(t); const store = new SqliteStore(path); t.after(() => store.close());
  const base = bootstrap(store);
  // Scheduling queries do not confer eligibility; a real research release still needs independent validation.
  const pending = store.registerRelease({ strategyDigest: store.putArtifact('strategy', { version: '2' }), dependencies: {}, scopeId: 'scope', expectedActiveDigest: base, validationDigest: null, source: 'bootstrap' });
  assert.equal(store.pendingReleases('scope')[0].digest, pending);
  store.appendEvent('release.deferred', 'scope', { releaseDigest: pending, reason: 'boundary_not_ready' });
  assert.equal(store.pendingReleases('scope').length, 1);
  assert.equal(store.scopeStatus('scope').releases.find(x => x.digest === pending).lastDeferral.reason, 'boundary_not_ready');
  store.appendEvent('release.invalid', 'scope', { releaseDigest: pending, reason: 'VERSION_INCOMPATIBLE' });
  assert.deepEqual(store.pendingReleases('scope'), []);
  assert(store.scopeStatus('scope').releases.find(x => x.digest === pending).blockers.includes('VERSION_INCOMPATIBLE'));
  assert(store.scopeStatus('scope').releases.find(x => x.digest === base).active);
});

test('holdout identity, protocol and allowance cannot be silently changed, and atomic final claims retain their limit', t => {
  const store = new SqliteStore(location(t)); t.after(() => store.close()); const base = bootstrap(store);
  const protocol = { holdoutId: 'holdout', domainId: 'kuhn', seeds: [10, 20], maxHoldoutUses: 1 };
  store.registerHoldout(protocol); store.registerHoldout(protocol);
  assert.deepEqual(store.holdoutAvailability('holdout', 1), { used: 0, remaining: 1 });
  assert.throws(() => store.registerHoldout({ ...protocol, maxHoldoutUses: 2 }), { code: 'HOLDOUT_UNAVAILABLE' });
  assert.throws(() => store.registerHoldout({ ...protocol, seeds: [30] }), { code: 'HOLDOUT_UNAVAILABLE' });
  assert.throws(() => store.registerHoldout({ ...protocol, holdoutId: 'renamed' }), { code: 'HOLDOUT_UNAVAILABLE' });
  store.registerHoldout({ ...protocol, holdoutId: 'fresh', seeds: [30, 40] });
  for (const id of ['first', 'second']) {
    store.createRun({ id, scopeId: 'scope', baseReleaseDigest: base, researchSnapshotId: 'snapshot', evaluationProtocolDigest: 'protocol', status: 'created', data: {} });
    store.transitionRun(id, ['created'], 'researching'); store.transitionRun(id, ['researching'], 'candidate_locked'); store.transitionRun(id, ['candidate_locked'], 'final_evaluating');
    if (id === 'first') { store.claimHoldout('holdout', id, 1); store.claimHoldout('holdout', id, 1); store.transitionRun(id, ['final_evaluating'], 'completed_failed'); }
    else { assert.throws(() => store.claimHoldout('holdout', id, 1), { code: 'HOLDOUT_UNAVAILABLE' }); store.transitionRun(id, ['final_evaluating'], 'waiting_protocol'); }
  }
  assert.equal(store.activeRun('scope'), undefined);
  assert.deepEqual(store.holdoutAvailability('holdout', 1), { used: 1, remaining: 0 });
  assert.throws(() => store.holdoutAvailability('holdout', 2), { code: 'HOLDOUT_UNAVAILABLE' });
});

test('schema 1 migrates in place, preserving journal, executions, revisions, release activation and already consumed holdout resources', t => {
  const path = location(t); let store = new SqliteStore(path); const base = bootstrap(store);
  store.recordFeedback(feedback('feedback', 1, 100)); store.recordFeedback(feedback('feedback', 2, 200));
  const protocol = { holdoutId: 'historical', domainId: 'kuhn', seeds: [1, 2], maxHoldoutUses: 1 };
  store.putArtifact('evaluation_protocol', protocol, 'private');
  const before = store.events({ scopeId: 'scope' }); store.close();
  const db = new DatabaseSync(path);
  insertIntent(db, intent('unfinished')); insertIntent(db, intent('finished', 'stream', { status: 'completed' }));
  db.prepare('INSERT INTO holdout_uses VALUES(?,?)').run('historical', 'old-run');
  downgradeToSchemaOne(db); db.close();
  store = new SqliteStore(path); t.after(() => store.close());
  assert.deepEqual(store.events({ scopeId: 'scope' }), before);
  assert.equal(store.activeRelease('scope'), base); assert.equal(store.pendingReleases('scope').length, 0);
  assert.deepEqual(store.unresolvedIntents('scope').map(x => x.decisionId), ['unfinished']);
  assert.equal(store.latestFeedback('scope')[0].feedback.revision, 2);
  assert.deepEqual(store.holdoutAvailability('historical', 1), { used: 1, remaining: 0 });
  assert.throws(() => store.registerHoldout({ ...protocol, holdoutId: 'renamed' }), { code: 'HOLDOUT_UNAVAILABLE' });
  assert.equal(store.integrity().ok, true);
  const check = new DatabaseSync(path, { readOnly: true }); assert.equal(check.prepare('PRAGMA user_version').get().user_version, 3); check.close();
});


test('concurrent schema 1 openers recheck the schema under the migration write lock', { timeout: 20000 }, async t => {
  const path = location(t); const initial = new SqliteStore(path); initial.appendEvent('preserved', 'scope', { stable: true }); initial.close();
  const db = new DatabaseSync(path); downgradeToSchemaOne(db); db.close();
  const barrier = new SharedArrayBuffer(4); const moduleUrl = new URL('../dist/storage.js', import.meta.url).href;
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const gate = new Int32Array(workerData.barrier); const prepare = DatabaseSync.prototype.prepare; let first = true;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (sql === 'PRAGMA user_version' && first) {
        first = false; const get = statement.get;
        statement.get = function(...args) {
          const result = get.apply(this, args);
          if (Atomics.add(gate, 0, 1) + 1 === 2) Atomics.notify(gate, 0);
          else while (Atomics.load(gate, 0) < 2) { if (Atomics.wait(gate, 0, 1, 5000) === 'timed-out') throw new Error('Migration barrier timed out'); }
          return result;
        };
      }
      return statement;
    };
    import(workerData.moduleUrl).then(({ SqliteStore }) => { const store = new SqliteStore(workerData.path); parentPort.postMessage(store.events({ scopeId: 'scope' }).length); store.close(); }).catch(error => { throw error; });
  `;
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { path, barrier, moduleUrl } });
    t.after(() => worker.terminate()); worker.once('message', resolve); worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`Worker exited ${code}`)); });
  });
  assert.deepEqual(await Promise.all([run(), run()]), [1, 1]);
});

test('snapshot releases its read transaction before decoding evidence and allows concurrent writer progress', t => {
  const path = location(t); const store = new SqliteStore(path); t.after(() => store.close());
  store.appendEvent('decision', 'scope', { decisionId: 'parse-lock-probe', payload: 'evidence' });
  store.recordFeedback(feedback('feedback', 1, 1));
  const writer = new DatabaseSync(path); writer.exec('PRAGMA busy_timeout=1'); t.after(() => writer.close());
  const parse = JSON.parse; let wrote = false;
  JSON.parse = function(input, ...args) {
    if (!wrote && typeof input === 'string' && input.includes('parse-lock-probe')) {
      writer.prepare('INSERT INTO events(type,scope_id,timestamp,visibility,data) VALUES(?,?,?,?,?)').run('concurrent.marker', 'scope', Date.now(), 'public', '{}'); wrote = true;
    }
    return parse.call(this, input, ...args);
  };
  let snapshot;
  try { snapshot = store.snapshot('scope', Date.now()); } finally { JSON.parse = parse; }
  assert(wrote, 'Second writer must progress while frozen evidence is decoded');
  assert.equal(store.getArtifact(snapshot).window.feedbackReadMode, 'latest_projection');
  assert.equal(store.getArtifact(snapshot).decisions.length, 1);
});

test('private state lookups remain explicit and first provider budget atomically consumes its feedback trigger only once', t => {
  const store = new SqliteStore(location(t)); t.after(() => store.close()); const base = bootstrap(store);
  store.appendEvent('research.worker_state', 'scope', { state: 'waiting_protocol' }, 'private');
  assert.equal(store.latestEvent('scope', 'research.worker_state'), undefined);
  assert.equal(store.latestEvent('scope', 'research.worker_state', { allowPrivate: true }).data.state, 'waiting_protocol');
  store.createRun({ id: 'trigger-run', scopeId: 'scope', baseReleaseDigest: base, researchSnapshotId: 'snapshot', evaluationProtocolDigest: 'protocol', status: 'created', data: { trigger: { feedbackEventId: 42, cutoff: 100, settledTrajectories: 2 } } });
  store.transitionRun('trigger-run', ['created'], 'researching');
  store.consumeBudget('trigger-run', 'modelCalls', 2);
  store.consumeBudget('trigger-run', 'modelCalls', 2, 0);
  store.consumeBudget('trigger-run', 'modelCalls', 2);
  assert.equal(store.events({ scopeId: 'scope', types: ['research.triggered'] }).length, 1);
  assert.equal(store.latestEvent('scope', 'research.triggered').data.feedbackEventId, 42);
});


test('current rolling evidence follows committed feedback cursors despite old host timestamps and explicitly reports truncated windows', t => {
  const store = new SqliteStore(location(t)); t.after(() => store.close());
  for (let i = 0; i < 1001; i++) store.recordFeedback(feedback(`feedback-${i}`, 1, 10000 + i));
  store.recordFeedback(feedback('feedback-0', 2, 1)); // A newly committed correction carries an older host timestamp.
  for (let i = 0; i < 3; i++) store.appendEvent('decision', 'scope', { decisionId: `decision-${i}` });
  const snapshot = store.getArtifact(store.snapshot('scope', Date.now(), { maxDecisions: 2 }));
  assert.equal(snapshot.feedback.length, 1000);
  assert.equal(snapshot.feedback.at(-1).feedbackId, 'feedback-0');
  assert.equal(snapshot.feedback.at(-1).revision, 2);
  assert(snapshot.evidenceRefs.includes('feedback-0@2'));
  assert.equal(snapshot.window.feedbackReadMode, 'latest_projection');
  assert.equal(snapshot.window.feedbackTruncated, true);
  assert.equal(snapshot.window.decisionsTruncated, true);
  const complete = store.getArtifact(store.snapshot('scope', Date.now(), { maxDecisions: 3, maxFeedback: 1001 }));
  assert.equal(complete.window.feedbackTruncated, false);
  assert.equal(complete.window.decisionsTruncated, false);
});
