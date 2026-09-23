import type { ActionCommand, DomainDefinition, Observation } from './types.js';
import { digest, getFeature } from './utils.js';

export interface ConformanceCheck { name: string; status: 'passed' | 'failed' | 'skipped'; detail: string }
export interface ConformanceReport { passed: boolean; domainId: string; checks: ConformanceCheck[] }
export interface ConformanceOptions {
  streamId?: string;
  /** Known simulator secrets which must not appear in observations; specify for each custom domain. */
  forbiddenFeaturePaths?: string[];
  /** Factories must return isolated sandbox instances; this suite executes real adapter methods. */
  noActionFixture?: () => Promise<{ domain: DomainDefinition; observation: Observation }>;
  singleCandidateFixture?: () => Promise<{ domain: DomainDefinition; observation: Observation }>;
  maxSteps?: number;
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function command(observation: Observation, action: ActionCommand['action'], key: string): ActionCommand {
  return { observation, action, decisionId: key, idempotencyKey: key, expectedStateRevision: observation.revision, deadline: observation.deadline };
}
/** The selected first candidate is only a sandbox contract-test input, never a runtime action policy.
 * Installable domain-contract checks. Run only on sandbox/resettable factories, never a production execution adapter. */
export async function runDomainConformance(factory: () => DomainDefinition | Promise<DomainDefinition>, options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const initial = await factory(); const stream = options.streamId ?? 'conformance';
  const checks: ConformanceCheck[] = [];
  const run = async (name: string, fn: () => Promise<void>, skipped?: string) => {
    if (skipped) { checks.push({ name, status: 'skipped', detail: skipped }); return; }
    try { await fn(); checks.push({ name, status: 'passed', detail: 'Contract satisfied' }); }
    catch (error) { checks.push({ name, status: 'failed', detail: error instanceof Error ? error.message : String(error) }); }
  };
  await run('capability-methods', async () => {
    for (const [flag, method] of [['execution', 'execute'], ['statusQuery', 'executionStatus']] as const) {
      check(!initial.capabilities[flag] || typeof initial[method] === 'function', `${flag} requires ${method}`);
    }
    check(!initial.capabilities.idempotency || initial.capabilities.execution, 'idempotency requires execution');
    check(!(initial.capabilities.delayedFeedback || initial.capabilities.revisedFeedback) || typeof initial.feedback === 'function', 'Feedback capability requires feedback()');
    check(initial.capabilities.activationBoundary !== 'scope' || typeof initial.canActivate === 'function', 'Scope activation requires canActivate()');
  });
  await run('observation-schema-and-actions', async () => {
    const domain = await factory(); const observation = await domain.observe(stream);
    check(observation.domainId === domain.id && observation.streamId === stream, 'Observation identity mismatch');
    check(observation.applicationId && observation.strategyScopeId && observation.actorId && observation.trajectoryId && observation.revision, 'Missing observation identity');
    check(Number.isFinite(observation.observedAt) && observation.deadline >= observation.observedAt, 'Invalid observation time');
    for (const [path, spec] of Object.entries(domain.features)) {
      const value = getFeature(observation.features, path);
      check(!spec.required || value !== undefined, `Missing required feature ${path}`);
      if (value !== undefined) check(typeof value === spec.type && (typeof value !== 'number' || Number.isFinite(value)), `Invalid feature type ${path}`);
    }
    const actions = await domain.candidates(observation);
    check(new Set(actions.map(a => a.id)).size === actions.length, 'Duplicate action ID');
    check(actions.every(a => a.revision === observation.revision), 'Action revision mismatch');
  });
  await run('actor-visibility', async () => {
    const domain = await factory(); const observation = await domain.observe(stream);
    for (const path of options.forbiddenFeaturePaths!) check(getFeature(observation.features, path) === undefined, `Hidden feature leaked: ${path}`);
  }, options.forbiddenFeaturePaths?.length ? undefined : 'No hidden-state fixture provided; private visibility is not certified');
  await run('scenario-reset', async () => {
    const first = await factory(); const second = await factory();
    const a = await first.observe(stream); const b = await second.observe(stream);
    check(digest(a.features) === digest(b.features), 'Factory does not reproduce identical initial visible state; provide a fixed seed');
    check(digest(await first.candidates(a)) === digest(await second.candidates(b)), 'Reset legal candidates differ');
  });
  await run('legal-execution-idempotency-status', async () => {
    const domain = await factory(); const observation = await domain.observe(stream); const action = (await domain.candidates(observation))[0];
    check(action, 'Fixture must supply an actionable state');
    const cmd = command(observation, action, 'conformance-execute'); const receipt = await domain.execute!(cmd);
    check(['accepted', 'completed', 'unknown'].includes(receipt.status), 'Legal action rejected');
    check(receipt.decisionId === cmd.decisionId && receipt.idempotencyKey === cmd.idempotencyKey, 'Receipt identity mismatch');
    if (domain.capabilities.idempotency) {
      check(digest(receipt) === digest(await domain.execute!(cmd)), 'Duplicate submission changed its receipt');
      let rejected = false;
      try { const changed = await domain.execute!({ ...cmd, decisionId: 'different' }); rejected = changed.status === 'rejected'; } catch { rejected = true; }
      check(rejected, 'Reusing idempotency key for another command was accepted');
    }
    if (domain.capabilities.statusQuery) check(digest(receipt) === digest(await domain.executionStatus!(cmd.idempotencyKey)), 'Status query disagrees with execution receipt');
  }, initial.capabilities.execution ? undefined : 'Host-owned execution: adapter execution/recovery checks disabled');
  if (!initial.capabilities.idempotency) checks.push({ name: 'idempotent-retry', status: 'skipped', detail: 'Idempotency not declared; automatic replay is disabled' });
  if (!initial.capabilities.statusQuery) checks.push({ name: 'unknown-receipt-reconciliation', status: 'skipped', detail: 'Status lookup not declared; unknown execution requires host reconciliation' });
  await run('stale-state-rejected', async () => {
    const domain = await factory(); const observation = await domain.observe(stream); const action = (await domain.candidates(observation))[0];
    check(action, 'Fixture must supply an actionable state');
    let rejected = false;
    try { const receipt = await domain.execute!({ ...command(observation, action, 'stale'), expectedStateRevision: 'non-current-revision' }); rejected = receipt.status === 'rejected'; }
    catch { rejected = true; }
    check(rejected, 'Stale command was accepted');
  }, initial.capabilities.execution ? undefined : 'Execution belongs to host');
  await run('illegal-action-rejected', async () => {
    const domain = await factory(); const observation = await domain.observe(stream);
    let rejected = false;
    try { const receipt = await domain.execute!(command(observation, { id: '__invalid__', kind: '__invalid__', parameters: {}, revision: observation.revision }, 'illegal')); rejected = receipt.status === 'rejected'; }
    catch { rejected = true; }
    check(rejected, 'Unknown action was accepted');
  }, initial.capabilities.execution ? undefined : 'Execution belongs to host');
  await run('unknown-receipt', async () => { const domain = await factory(); check((await domain.executionStatus!('never-issued')).status === 'unknown', 'Unknown key must not claim completion'); }, initial.capabilities.statusQuery ? undefined : 'Status query not declared');
  await run('feedback-and-revisions', async () => {
    const domain = await factory(); const seen = new Map<string, number>(); let settled = false; let revised = false; let provisional = false;
    for (let step = 0; step < (options.maxSteps ?? 8) && (!settled || (domain.capabilities.revisedFeedback && !revised)); step++) {
      const observation = await domain.observe(stream); const action = (await domain.candidates(observation))[0];
      if (action) await domain.execute!(command(observation, action, `feedback:${step}`));
      for (let poll = 0; poll < 4; poll++) for (const event of await domain.feedback!()) {
        check(event.applicationId === observation.applicationId && event.strategyScopeId === observation.strategyScopeId, 'Feedback application/scope mismatch');
        check(event.receivedAt >= event.eventTime && event.revision >= 1 && Number.isInteger(event.revision), 'Invalid feedback time/revision');
        check(Object.values(event.metrics).every(Number.isFinite), 'Non-finite feedback metric');
        if (seen.has(event.feedbackId)) { check(event.revision > seen.get(event.feedbackId)!, 'Feedback revision failed to advance'); revised = true; }
        seen.set(event.feedbackId, event.revision); settled ||= event.settled; provisional ||= !event.settled;
      }
    }
    check(settled, 'Fixture did not produce settled feedback within bounded steps');
    if (domain.capabilities.revisedFeedback) check(revised, 'Declared revised feedback was not demonstrated');
    if (domain.capabilities.delayedFeedback) check(provisional, 'Declared delayed feedback was not demonstrated by a provisional event');
  }, initial.capabilities.execution && initial.feedback ? undefined : 'No sandbox execution/feedback capability');
  await run('instance-knowledge-isolation', async () => {
    const a = await factory(); const b = await factory(); const before = await b.observe(stream); const obs = await a.observe(stream);
    const action = (await a.candidates(obs))[0]; if (action) await a.execute!(command(obs, action, 'isolation'));
    const after = await b.observe(stream); check(digest(before.features) === digest(after.features) && before.revision === after.revision, 'Executing one instance changed another instance');
  }, initial.capabilities.execution ? undefined : 'No execution capability');
  await run('scope-checkpoint', async () => {
    const domain = await factory(); const observation = await domain.observe(stream);
    check(!(await domain.canActivate!(observation.strategyScopeId)), 'Scope activated while action was outstanding');
    const action = (await domain.candidates(observation))[0]; check(action, 'Checkpoint fixture needs an action');
    await domain.execute!(command(observation, action, 'boundary'));
    check(await domain.canActivate!(observation.strategyScopeId), 'Confirmed checkpoint did not permit scope activation');
  }, initial.capabilities.activationBoundary === 'scope' && initial.capabilities.execution ? undefined : 'Trajectory binding or host-managed boundary; scope synchronization not exercised');
  for (const [name, fixture, length] of [['no-action', options.noActionFixture, 0], ['single-candidate', options.singleCandidateFixture, 1]] as const) {
    await run(name, async () => { const { domain, observation } = await fixture!(); check((await domain.candidates(observation)).length === length, `Expected ${length} candidates`); }, fixture ? undefined : 'Scenario fixture not supplied; this edge case remains unverified');
  }
  return { passed: checks.every(item => item.status !== 'failed'), domainId: initial.id, checks };
}
