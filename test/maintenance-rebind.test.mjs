import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SqliteStore, DuelLoop, FixtureDecisionModel, KuhnPokerDomain, createKuhnStrategy,
  ResearchOrchestrator, digest,
} from '../dist/index.js';

const scope = 'maintenance-scope';
function model(version) {
  return new FixtureDecisionModel('same-model', question => ({
    score: 1, confidence: 1,
    probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, index === 1 ? 1 : 0])),
  }), version);
}
function fixture(t, options = {}) {
  const store = new SqliteStore(options.path ?? ':memory:');
  const domain = new KuhnPokerDomain({ applicationId: 'maintenance-app', scopeId: scope });
  const oldModel = model('retry-before');
  const newModel = model('retry-after');
  const runtimeOptions = { applicationId: 'maintenance-app', domain, store, mode: 'offline', executionOwner: 'host' };
  const oldRuntime = new DuelLoop({ ...runtimeOptions, model: oldModel });
  const original = oldRuntime.bootstrap(createKuhnStrategy(), scope);
  const runtime = new DuelLoop({ ...runtimeOptions, model: newModel });
  const result = { store, domain, oldModel, newModel, oldRuntime, runtime, original, runtimeOptions, storeClosed: false };
  t.after(async () => { await oldRuntime.close(); await runtime.close(); if (!result.storeClosed) store.close(); });
  return result;
}
function evidence(x, change = value => value, kind = 'model_maintenance_evidence') {
  const old = x.store.release(x.original);
  const report = x.store.putArtifact('maintenance_check_report', { name: '403 retry regression', passed: true });
  return x.store.putArtifact(kind, change({
    schemaVersion: '1.0', kind: 'bootstrap_model_maintenance', scopeId: scope,
    previousReleaseDigest: x.original, strategyDigest: old.strategyDigest,
    previousDependencies: old.dependencies, newDependencies: x.runtime.dependencies,
    reason: 'Retry transient HTTP 403 responses without replacing the bootstrap strategy',
    checks: [{ name: '403 recovery and exhaustion', passed: true, artifactDigest: report }],
    createdAt: Date.now(),
  }), 'private');
}
function options(x, evidenceDigest = evidence(x)) {
  return { expectedReleaseDigest: x.original, evidenceDigest };
}
function unchanged(x, before) {
  assert.equal(x.store.activeRelease(scope), x.original);
  assert.deepEqual(x.store.release(x.original), before.release);
  assert.equal(x.store.listArtifacts('release', true).length, before.count);
  assert.equal(x.store.events({ scopeId: scope, allowPrivate: true }).length, before.events);
}
function snapshot(x) {
  return { release: x.store.release(x.original), count: x.store.listArtifacts('release', true).length,
    events: x.store.events({ scopeId: scope, allowPrivate: true }).length };
}
function run(x, id = 'maintenance-active-run') {
  return x.store.createRun({ id, scopeId: scope, baseReleaseDigest: x.original,
    researchSnapshotId: x.store.snapshot(scope, Date.now()),
    evaluationProtocolDigest: x.store.putArtifact('protocol', { id }, 'private'), status: 'created', data: {} });
}

test('maintenance rebind preserves immutable bootstrap and old hand pins, and binds new hands to new behavior', async t => {
  const x = fixture(t);
  const before = snapshot(x);
  const oldHand = { strategyScopeId: scope, streamId: 'table', actorId: 'self', trajectoryId: 'old-hand' };
  assert.equal(x.oldRuntime.pinTrajectory(oldHand), x.original);
  const opts = options(x);
  await x.oldRuntime.stop();
  await x.runtime.stop();
  const next = await x.runtime.rebindBootstrapModel(scope, opts);
  assert.notEqual(next, x.original);
  assert.equal(x.store.activeRelease(scope), next);
  assert.deepEqual(x.store.release(x.original), before.release);
  const binding = x.store.release(next);
  assert.equal(binding.source, 'maintenance');
  assert.equal(binding.strategyDigest, before.release.strategyDigest);
  assert.equal(binding.validationDigest, null);
  assert.equal(binding.previousReleaseDigest, x.original);
  assert.equal(binding.evidenceDigest, opts.evidenceDigest);
  assert.deepEqual(binding.dependencies, x.runtime.dependencies);
  assert.equal(x.store.lookupTrajectoryRelease(scope, 'table', 'self', 'old-hand'), x.original);
  assert.equal(x.store.trajectoryRelease(scope, 'table', 'self', 'new-hand'), next);
  assert.doesNotThrow(() => x.store.assertUsableRelease(next, { dependencies: x.runtime.dependencies, executionMode: 'offline' }));
  assert.throws(() => x.store.assertUsableRelease(x.original, { dependencies: x.runtime.dependencies, executionMode: 'offline' }));
  assert.equal(x.store.listArtifacts('validation_report', true).length, 0, 'maintenance is not a successful research validation');
  const audit = x.store.events({ scopeId: scope, allowPrivate: true }).filter(event => event.type.includes('maintenance'));
  assert(audit.length > 0, 'maintenance has a dedicated audit event');
  assert(audit.some(event => JSON.stringify(event.data).includes(opts.evidenceDigest)));
});

test('runtime rebind requires explicit stopped and drained runtime', async t => {
  const x = fixture(t);
  const opts = options(x);
  const before = snapshot(x);
  await assert.rejects(() => x.runtime.rebindBootstrapModel(scope, opts));
  unchanged(x, before);
  await x.runtime.stop();
  let resolveBoundary;
  let enteredBoundary;
  const boundaryEntered = new Promise(resolve => { enteredBoundary = resolve; });
  x.domain.capabilities.activationBoundary = 'scope';
  x.domain.canActivate = () => new Promise(resolve => { resolveBoundary = resolve; enteredBoundary(); });
  const pending = x.runtime.rebindBootstrapModel(scope, opts);
  const pendingOutcome = pending.then(value => ({ value }), error => ({ error }));
  await boundaryEntered;
  try {
    assert(x.runtime.status().pendingOperations > 0);
    await assert.rejects(() => x.runtime.rebindBootstrapModel(scope, opts));
    unchanged(x, before);
  } finally { resolveBoundary(true); }
  const outcome = await pendingOutcome;
  assert.equal(outcome.error, undefined);
  assert.equal(x.store.activeRelease(scope), outcome.value);
  await x.runtime.stop();
  assert.equal(x.runtime.status().pendingOperations, 0);
});

for (const key of ['model', 'modelKind', 'runtime', 'rules', 'featureBuilder', 'knowledgeUpdater', 'continuationPolicy', 'contextDigest']) {
  test(`maintenance rejects a change to non-model-behavior dependency ${key}`, t => {
    const x = fixture(t);
    const dependencies = { ...x.runtime.dependencies, [key]: `${x.runtime.dependencies[key]}-changed` };
    const opts = options(x, evidence(x, value => ({ ...value, newDependencies: dependencies })));
    const before = snapshot(x);
    assert.throws(() => x.store.rebindBootstrapModel(scope, dependencies, opts));
    unchanged(x, before);
  });
}

test('maintenance rejects unchanged model behavior and stale compare-and-swap baseline', t => {
  const x = fixture(t);
  const oldDeps = x.store.release(x.original).dependencies;
  const sameEvidence = evidence(x, value => ({ ...value, newDependencies: oldDeps }));
  const before = snapshot(x);
  assert.throws(() => x.store.rebindBootstrapModel(scope, oldDeps, options(x, sameEvidence)));
  assert.throws(() => x.store.rebindBootstrapModel(scope, x.runtime.dependencies, { ...options(x), expectedReleaseDigest: '0'.repeat(64) }));
  unchanged(x, before);
});

const invalidEvidence = [
  ['schema', value => ({ ...value, schemaVersion: 'other' })],
  ['kind', value => ({ ...value, kind: 'research_validation' })],
  ['scope', value => ({ ...value, scopeId: 'other' })],
  ['previous release', value => ({ ...value, previousReleaseDigest: '0'.repeat(64) })],
  ['strategy', value => ({ ...value, strategyDigest: '0'.repeat(64) })],
  ['previous dependencies', value => ({ ...value, previousDependencies: value.newDependencies })],
  ['new dependencies', value => ({ ...value, newDependencies: value.previousDependencies })],
  ['empty reason', value => ({ ...value, reason: '  ' })],
  ['no checks', value => ({ ...value, checks: [] })],
  ['unnamed check', value => ({ ...value, checks: [{ ...value.checks[0], name: '' }] })],
  ['failed check', value => ({ ...value, checks: [{ ...value.checks[0], passed: false }] })],
  ['missing report', value => ({ ...value, checks: [{ ...value.checks[0], artifactDigest: '0'.repeat(64) }] })],
  ['invalid timestamp', value => ({ ...value, createdAt: 'yesterday' })],
];
for (const [label, change] of invalidEvidence) {
  test(`maintenance rejects evidence with ${label}`, t => {
    const x = fixture(t);
    const opts = options(x, evidence(x, change));
    const before = snapshot(x);
    assert.throws(() => x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts));
    unchanged(x, before);
  });
}

test('maintenance rejects an evidence artifact stored under the wrong kind', t => {
  const x = fixture(t);
  const opts = options(x, evidence(x, value => value, 'unrelated'));
  const before = snapshot(x);
  assert.throws(() => x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts));
  unchanged(x, before);
});

test('maintenance rejects active research without changing its baseline', t => {
  const x = fixture(t);
  const active = run(x);
  const opts = options(x);
  const before = snapshot(x);
  assert.throws(() => x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts));
  unchanged(x, before);
  assert.deepEqual(x.store.getRun(active.id), active);
});

test('maintenance cannot replace a validated research release', t => {
  const x = fixture(t);
  const original = x.store.release(x.original);
  const completed = run(x, 'completed-research');
  for (const [from, to] of [['created', 'researching'], ['researching', 'candidate_locked'],
    ['candidate_locked', 'final_evaluating'], ['final_evaluating', 'completed_passed']]) {
    x.store.transitionRun(completed.id, [from], to);
  }
  const strategy = x.store.getArtifact(original.strategyDigest);
  strategy.version = 'v2'; strategy.parentVersion = 'v1';
  const strategyDigest = x.store.putArtifact('strategy', strategy);
  const validationDigest = x.store.putArtifact('validation_report', {
    candidateDigest: strategyDigest, baseReleaseDigest: x.original, dependencies: original.dependencies,
    status: 'passed', stage: 'final', modelKind: 'fixture',
  }, 'private');
  const researchRelease = x.store.registerRelease({ strategyDigest, scopeId: scope, dependencies: original.dependencies,
    expectedActiveDigest: x.original, validationDigest, source: 'research', researchRunId: completed.id });
  x.store.activate(researchRelease, original.dependencies, { explicit: true });
  const current = { ...x, original: researchRelease };
  const opts = options(current);
  const before = snapshot(current);
  assert.throws(() => x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts));
  unchanged(current, before);
});

test('maintenance cannot chain another unvalidated maintenance change', t => {
  const x = fixture(t);
  const next = x.store.rebindBootstrapModel(scope, x.runtime.dependencies, options(x));
  const current = { ...x, original: next,
    runtime: { dependencies: { ...x.runtime.dependencies, modelBehaviorDigest: digest({ revision: 'third' }) } } };
  const opts = options(current);
  const before = snapshot(current);
  assert.throws(() => x.store.rebindBootstrapModel(scope, current.runtime.dependencies, opts));
  unchanged(current, before);
});

test('maintenance rejects an unresolved execution intent and preserves its command', async t => {
  const x = fixture(t);
  const observation = await x.domain.observe('unresolved');
  const decision = await x.oldRuntime.decide(observation);
  const command = await x.oldRuntime.prepareHostExecution(decision);
  const opts = options(x);
  const before = snapshot(x);
  assert.throws(() => x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts));
  unchanged(x, before);
  assert.deepEqual(x.store.unresolvedIntents(scope)[0].command, command);
});

test('ordinary release registration cannot forge a maintenance release', t => {
  const x = fixture(t);
  const original = x.store.release(x.original);
  const opts = options(x);
  const before = snapshot(x);
  assert.throws(() => x.store.registerRelease({ ...original, source: 'maintenance', dependencies: x.runtime.dependencies,
    expectedActiveDigest: x.original, previousReleaseDigest: x.original, evidenceDigest: opts.evidenceDigest }));
  unchanged(x, before);
});

test('failed maintenance audit rolls back the new release and active pointer atomically', t => {
  const x = fixture(t);
  const opts = options(x);
  const before = snapshot(x);
  const originalAppend = x.store.appendEvent.bind(x.store);
  x.store.appendEvent = (...args) => { originalAppend(...args); throw new Error('injected audit write failure'); };
  assert.throws(() => x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts), /injected audit write failure/);
  x.store.appendEvent = originalAppend;
  unchanged(x, before);
  const next = x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts);
  assert.equal(x.store.activeRelease(scope), next, 'rollback leaves the store usable for a valid retry');
});

test('reopened store accepts new decisions and research creation with maintenance dependencies', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'duelloop-rebind-'));
  const path = join(directory, 'state.sqlite');
  const x = fixture(t, { path });
  const opts = options(x);
  await x.oldRuntime.stop();
  await x.runtime.stop();
  const next = await x.runtime.rebindBootstrapModel(scope, opts);
  await x.oldRuntime.close();
  await x.runtime.close();
  x.store.close();
  x.storeClosed = true;
  const reopened = new SqliteStore(path);
  const runtime = new DuelLoop({ ...x.runtimeOptions, store: reopened, model: x.newModel });
  try {
    const { decision } = await runtime.step('new-table');
    assert.equal(decision.releaseDigest, next);
    assert.equal(decision.decisionSource, 'strategy');
    const evaluator = { id: 'synthetic-maintenance', decisionPolicy: { maxDecisionMs: 5000, executionReserveMs: 25 },
      domainDependencies: { rules: x.domain.rulesVersion, featureBuilder: x.domain.featureBuilderVersion,
        knowledgeUpdater: x.domain.knowledgeUpdaterVersion, continuationPolicy: x.domain.continuationVersion,
        contextDigest: digest(x.domain.context) }, episode: async () => { throw new Error('no evaluation expected'); } };
    const orchestrator = new ResearchOrchestrator({ store: reopened, domain: x.domain, model: x.newModel,
      dependencies: runtime.dependencies, evaluator,
      providers: { researcher: { id: 'no-provider-call', kind: 'fixture', run: async () => { throw new Error('no provider call expected'); } } } });
    const protocol = { version: '3.0', id: 'maintenance-final', domainId: 'kuhn-poker', seeds: [701, 702, 703],
      opponentIds: ['calling'], trajectoriesPerSeed: 10, knowledgeStateMode: 'frozen', initialKnowledge: {},
      metric: { name: 'reward', direction: 'maximize', unit: 'chips' }, minSamples: 3, minimumImprovement: 0,
      maxGroupRegression: 0, confidenceLevel: 0.95, maxP95DecisionComputeMs: 100,
      maxDevelopmentEvalRuns: 2, maxFinalEvaluationsPerRun: 1, holdoutId: 'maintenance-independent', maxHoldoutUses: 1 };
    const created = orchestrator.create({ scopeId: scope, protocol });
    assert.equal(created.baseReleaseDigest, next);
    assert.equal(created.status, 'created');
    assert.deepEqual(reopened.release(created.baseReleaseDigest).dependencies, runtime.dependencies);
    assert.equal(reopened.listArtifacts('validation_report', true).length, 0);
  } finally {
    await runtime.close(); reopened.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('maintenance backup restores eligibility and pruning retains evidence and referenced check reports', async t => {
  const x = fixture(t);
  const opts = options(x);
  const next = x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts);
  const report = x.store.getArtifact(opts.evidenceDigest, { allowPrivate: true }).checks[0].artifactDigest;
  const directory = mkdtempSync(join(tmpdir(), 'duelloop-maintenance-backup-'));
  let restored;
  try {
    const backup = join(directory, 'backup.sqlite');
    await x.store.backup(backup);
    restored = SqliteStore.restore(backup, join(directory, 'restored.sqlite'));
    assert.equal(restored.activeRelease(scope), next);
    assert.doesNotThrow(() => restored.assertUsableRelease(next, { dependencies: x.runtime.dependencies, executionMode: 'offline' }));
    const orphan = restored.putArtifact('maintenance_check_report', { name: 'unreferenced', passed: true });
    const pruned = restored.pruneUnreferencedArtifacts({ dryRun: false, kinds: ['model_maintenance_evidence', 'maintenance_check_report'] });
    assert(pruned.digests.includes(orphan), 'pruning actually removes an unrelated report');
    assert(!pruned.digests.includes(opts.evidenceDigest));
    assert(!pruned.digests.includes(report));
    assert.doesNotThrow(() => restored.getArtifact(opts.evidenceDigest, { allowPrivate: true }));
    assert.doesNotThrow(() => restored.getArtifact(report, { allowPrivate: true }));
    assert.equal(restored.integrity().ok, true);
  } finally { restored?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('missing maintenance check report rejects release eligibility, integrity and backup restore', async t => {
  const x = fixture(t);
  const opts = options(x);
  const next = x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts);
  const report = x.store.getArtifact(opts.evidenceDigest, { allowPrivate: true }).checks[0].artifactDigest;
  const directory = mkdtempSync(join(tmpdir(), 'duelloop-maintenance-missing-'));
  let corrupted;
  try {
    const backup = join(directory, 'backup.sqlite');
    await x.store.backup(backup);
    const raw = new DatabaseSync(backup);
    try { raw.prepare('DELETE FROM artifacts WHERE digest=?').run(report); } finally { raw.close(); }
    assert.throws(() => SqliteStore.restore(backup, join(directory, 'restored.sqlite')));
    corrupted = new SqliteStore(backup);
    assert.throws(() => corrupted.assertUsableRelease(next, { dependencies: x.runtime.dependencies, executionMode: 'offline' }));
    const result = corrupted.integrity();
    assert.equal(result.ok, false);
    assert(result.issues.includes(`release:${next}`));
  } finally { corrupted?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a live execution owner blocks maintenance until its ownership is released', t => {
  const x = fixture(t);
  const opts = options(x);
  const owner = x.store.acquireOwner(scope, 'owned-table', 'live-maintenance-fixture');
  const before = snapshot(x);
  assert.throws(() => x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts));
  unchanged(x, before);
  x.store.assertOwner(scope, 'owned-table', owner);
  x.store.releaseOwner(scope, 'owned-table', owner);
  const next = x.store.rebindBootstrapModel(scope, x.runtime.dependencies, opts);
  assert.equal(x.store.activeRelease(scope), next);
});
