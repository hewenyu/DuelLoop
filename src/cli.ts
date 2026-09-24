#!/usr/bin/env node
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { DuelLoopError, invariant } from './errors.js';
import { loadConfiguration, readJsonFile, type DuelLoopConfiguration } from './config.js';
import { SqliteStore } from './storage.js';
import { DuelLoop } from './runtime.js';
import { JevDecisionModel, FixtureDecisionModel, PiResearchProvider, jevBehaviorIdentity } from './adapters.js';
import { AuctionDomain, KuhnPokerDomain, AuctionEvaluationAdapter, KuhnEvaluationAdapter, createAuctionStrategy, createKuhnStrategy } from './domains.js';
import { validateStrategy, compileStrategy, diffStrategies } from './strategy.js';
import { validateProtocol, evaluateCandidate } from './evaluation.js';
import { ResearchOrchestrator } from './research.js';
import { digest, jsonValue } from './utils.js';
import type { DecisionModel, DecisionRecord, DomainDefinition, EvaluationAdapter, EvaluationProtocol, Features, ReleaseBinding, ResearchProvider, StrategyPackage } from './types.js';

const COMMANDS: Record<string, string[]> = {
  init: ['dir','domain','application','scope'], doctor: ['config'], run: ['config','steps'], step: ['config','stream'],
  status: ['config'], explain: ['config','decision'], 'strategy-validate': ['config','file'], 'strategy-diff': ['before','after'],
  'research-create': ['config','id'], 'research-run': ['config','id'], 'research-worker': ['config'], 'research-cancel': ['config','id'],
  'research-status': ['config','id'], 'research-recover': ['config','id'], evaluate: ['config','candidate'],
  activate: ['config','release'], pause: ['config'], resume: ['config'], rollback: ['config','release'],
  backup: ['config','output'], restore: ['input','output'], integrity: ['config'], export: ['config','output'], reconcile: ['config'],
  'validation-invalidate': ['config','digest','reason'], cleanup: ['config','apply'], help: [], version: [],
};
function parse(argv: string[]) {
  const command = argv[0] === '--help' ? 'help' : argv[0] === '--version' ? 'version' : argv[0] ?? 'help'; invariant(Object.hasOwn(COMMANDS, command), 'CONFIG_INVALID', 'Unknown command', { command });
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const token = argv[i]!; const name = token.slice(2);
    if (name === 'apply' && command === 'cleanup' && !Object.hasOwn(flags, name)) { flags.apply = 'true'; i--; continue; }
    invariant(token.startsWith('--') && COMMANDS[command]!.includes(name) && !Object.hasOwn(flags, name) && argv[i + 1] && !argv[i + 1]!.startsWith('--'), 'CONFIG_INVALID', 'Invalid, duplicate or missing command option', { option: token });
    flags[name] = argv[i + 1]!;
  }
  return { command, flags };
}
function required(flags: Record<string, string>, key: string): string {
  const value = flags[key]; invariant(value?.length, 'CONFIG_INVALID', `--${key} is required`); return value;
}
async function writableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  try { await writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch { throw new DuelLoopError('CONFLICT', 'Cannot create output file; an existing file is never overwritten', { path }); }
}
function starterProtocol(domainId: string, stage: 'development' | 'final'): EvaluationProtocol {
  return { version: '3.0', id: `${domainId}-${stage}-v2`, domainId, seeds: stage === 'development' ? [1,2,3,4] : [101,102,103,104],
    opponentIds: domainId === 'kuhn-poker' ? ['calling','tight'] : ['fixed','random'], trajectoriesPerSeed: 12,
    knowledgeStateMode: 'frozen', initialKnowledge: {}, metric: { name: 'reward', direction: 'maximize', unit: domainId === 'kuhn-poker' ? 'chips/hand' : 'credits/checkpoint' },
    minSamples: 4, minimumImprovement: 0.01, maxGroupRegression: 0.1, confidenceLevel: 0.95,
    maxP95DecisionComputeMs: 5000, maxDevelopmentEvalRuns: 6, maxFinalEvaluationsPerRun: 1, holdoutId: `${domainId}-${stage}-${randomUUID()}`, maxHoldoutUses: 1 };
}
async function initialize(flags: Record<string, string>) {
  const path = resolve(required(flags, 'dir')), kind = required(flags, 'domain');
  invariant(kind === 'kuhn' || kind === 'auction', 'CONFIG_INVALID', '--domain must be kuhn or auction');
  const applicationId = required(flags, 'application'), scopeId = required(flags, 'scope');
  const strategy = kind === 'kuhn' ? createKuhnStrategy() : createAuctionStrategy();
  const config: DuelLoopConfiguration = { schemaVersion: '1.0', applicationId, scopeId, database: './data/duelloop.sqlite', strategy: './strategy.json',
    domain: { kind, seed: 1, opponentId: kind === 'kuhn' ? 'calling' : 'fixed', knowledgeStateMode: 'online_update', initialKnowledge: {} },
    decisionModel: { kind: 'fixture', id: 'duelloop-illustrative-fixture-v1' },
    runtime: { mode: 'offline', executionOwner: 'framework', streamIds: ['main'], maxSteps: 20, intervalMs: 0, maxDecisionMs: 5000, executionReserveMs: 25 },
    activationMode: 'explicit', evaluation: { developmentProtocol: './development.json', finalProtocol: './final.json', timeoutMs: 60000, maxModelCalls: 1000 }, research: { mode: 'off' } };
  const files: Record<string, unknown> = { 'duelloop.json': config, 'strategy.json': strategy,
    'development.json': starterProtocol(strategy.scope.domain, 'development'), 'final.json': starterProtocol(strategy.scope.domain, 'final') };
  for (const name of Object.keys(files)) {
    let exists = true; try { await access(resolve(path, name)); } catch { exists = false; }
    invariant(!exists, 'CONFLICT', 'Initialization would overwrite a file', { path: resolve(path, name) });
  }
  for (const [name, content] of Object.entries(files)) await writableJson(resolve(path, name), content);
  return { directory: path, files: Object.keys(files), modelKind: 'fixture', modelCalls: 0, note: 'Starter experiment parameters are illustrative, not calibrated quality or latency guarantees.' };
}
async function domainFor(config: DuelLoopConfiguration): Promise<{ domain: DomainDefinition; evaluator?: EvaluationAdapter }> {
  if (config.domain.kind === 'module') {
    let module: Record<string, unknown>;
    try { module = await import(pathToFileURL(config.domain.path).href); }
    catch { throw new DuelLoopError('CONFIG_INVALID', 'Could not import trusted domain module', { path: config.domain.path }); }
    const factory = module[config.domain.exportName]; invariant(typeof factory === 'function', 'CONFIG_INVALID', 'Domain factory export is not a function');
    const result = await factory({ applicationId: config.applicationId, scopeId: config.scopeId, options: config.domain.options });
    invariant(result?.domain && typeof result.domain.observe === 'function' && typeof result.domain.candidates === 'function', 'CONFIG_INVALID', 'Domain factory must return {domain,evaluator?}');
    return result;
  }
  const options = { applicationId: config.applicationId, scopeId: config.scopeId, seed: config.domain.seed, opponentId: config.domain.opponentId,
    knowledge: config.domain.initialKnowledge, knowledgeStateMode: config.domain.knowledgeStateMode, decisionTimeoutMs: config.runtime.maxDecisionMs };
  const timing = { maxDecisionMs: config.runtime.maxDecisionMs, executionReserveMs: config.runtime.executionReserveMs };
  return config.domain.kind === 'kuhn' ? { domain: new KuhnPokerDomain(options), evaluator: new KuhnEvaluationAdapter(timing) }
    : { domain: new AuctionDomain(options), evaluator: new AuctionEvaluationAdapter(timing) };
}
function modelFor(config: DuelLoopConfiguration, callable: boolean): DecisionModel {
  const settings = config.decisionModel;
  if (settings.kind === 'jev') {
    if (!callable) return { id: settings.model, kind: 'real', behaviorIdentity: jevBehaviorIdentity(settings), score: async () => { throw new DuelLoopError('ACCESS_DENIED', 'Model calls disabled for this command'); } };
    return new JevDecisionModel(settings);
  }
  return new FixtureDecisionModel(settings.id, (question, state) => {
    const features = state.features as Features;
    const active = ['bet','call'].includes(question.actionId) || question.actionId.startsWith('bid-');
    let normalized: number;
    if (question.dimensionId === 'exposure') normalized = active ? 0.75 : 0;
    else if (features?.['self.card'] !== undefined) normalized = active ? features['self.card'] === 'K' ? 1 : 0.25 : 0.5;
    else {
      const bid = question.actionId.startsWith('bid-') ? Number(question.actionId.slice(4)) : 0;
      normalized = bid > 0 ? Math.max(0, Math.min(1, (Number(features?.['self.value'] ?? 0) - bid) / 4)) : 0.25;
    }
    const score = Math.round(normalized * (question.criteria.length - 1));
    return { score, confidence: 1, probabilities: Object.fromEntries(question.criteria.map((_, i) => [i, i === score ? 1 : 0])) };
  });
}
async function protocols(config: DuelLoopConfiguration) {
  const development = validateProtocol(await readJsonFile(config.evaluation.developmentProtocol));
  const final = validateProtocol(await readJsonFile(config.evaluation.finalProtocol));
  invariant(development.domainId === final.domainId && development.holdoutId !== final.holdoutId && !development.seeds.some(seed => final.seeds.includes(seed)), 'CONFIG_INVALID', 'Development and final evaluation must have separate seeds and holdout identities');
  return { development, final };
}
async function doctor(config: DuelLoopConfiguration) {
  const strategy = validateStrategy(await readJsonFile(config.strategy)); const p = await protocols(config);
  invariant(strategy.scope.domain === p.final.domainId, 'CONFIG_INVALID', 'Strategy/protocol domain mismatch');
  if (config.domain.kind !== 'module') {
    const { domain } = await domainFor(config); validateStrategy(strategy, domain);
  }
  const credentials: { purpose: string; variable: string; present: boolean }[] = [];
  if (config.decisionModel.kind === 'jev') credentials.push({ purpose: 'decision', variable: config.decisionModel.apiKeyEnv, present: !!process.env[config.decisionModel.apiKeyEnv]?.trim() });
  if (config.research.mode !== 'off') for (const [name, role] of Object.entries(config.research.roles)) credentials.push({ purpose: name, variable: role.apiKeyEnv, present: !!process.env[role.apiKeyEnv]?.trim() });
  let moduleExists: boolean | undefined;
  if (config.domain.kind === 'module') { try { await access(config.domain.path); moduleExists = true; } catch { moduleExists = false; } }
  return { valid: moduleExists !== false, configurationDigest: digest(config), credentials, modelCalls: 0, externalModuleExecuted: false,
    ...(moduleExists !== undefined ? { externalModuleExists: moduleExists } : {}),
    checksNotPerformed: ['remote authentication', 'model quality/latency', 'external domain execution/conformance'],
    warnings: config.runtime.mode === 'offline' && config.research.mode !== 'off' ? ['Real research is disabled by offline execution mode'] : [] };
}
function scopeRun(store: SqliteStore, id: string, scopeId: string) {
  const run = store.getRun(id); invariant(run.scopeId === scopeId, 'ACCESS_DENIED', 'Research task belongs to another scope'); return run;
}

/** Executes one CLI command and returns data; importing this module never starts a process or calls a model. */
export async function executeCli(argv: string[], options: { signal?: AbortSignal } = {}): Promise<unknown> {
  const { command, flags } = parse(argv);
  if (command === 'help') return { commands: COMMANDS, documentation: 'docs/cli.md', output: 'One JSON result on stdout; structured errors on stderr' };
  if (command === 'version') { const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')); return { name: metadata.name, version: metadata.version }; }
  if (command === 'init') return initialize(flags);
  if (command === 'restore') {
    const output = resolve(required(flags, 'output')); const store = SqliteStore.restore(resolve(required(flags, 'input')), output);
    try { return { path: output, ...store.integrity() }; } finally { store.close(); }
  }
  if (command === 'strategy-diff') return diffStrategies(validateStrategy(await readJsonFile(resolve(required(flags, 'before')))), validateStrategy(await readJsonFile(resolve(required(flags, 'after')))));
  const config = await loadConfiguration(resolve(required(flags, 'config')));
  if (command === 'doctor') return doctor(config);
  if (command === 'strategy-validate') {
    const { domain } = await domainFor(config); return compileStrategy(await readJsonFile(flags.file ? resolve(flags.file) : config.strategy), domain);
  }
  const store = new SqliteStore(config.database,config.storage);
  let runtime: DuelLoop | undefined;
  const providers: PiResearchProvider[] = [];
  let cleanup: (() => void) | undefined;
  try {
    store.bindScope(config.scopeId, config.applicationId);
    if (command === 'status') {
      const workerState = store.latestEvent(config.scopeId, 'research.worker_state', { allowPrivate: true });
      return { applicationId: config.applicationId, mode: config.runtime.mode, ...store.scopeStatus(config.scopeId),
        lastReportedWorkerState: workerState ? { timestamp: workerState.timestamp, state: workerState.data } : null,
        runs: store.listRuns(config.scopeId), unresolvedExecutions: store.unresolvedIntents(config.scopeId).map(i => ({ decisionId: i.decisionId, status: i.receipt?.status ?? 'unknown' })) };
    }
    if (command === 'integrity') return store.integrity();
    if (command === 'cleanup') return store.pruneUnreferencedArtifacts({ dryRun: flags.apply !== 'true' });
    if (command === 'backup') { const path = resolve(required(flags, 'output')); await store.backup(path); return { path }; }
    if (command === 'pause' || command === 'resume') { store.pauseActivation(config.scopeId, command === 'pause'); return { scopeId: config.scopeId, activationPaused: command === 'pause', decisionsPaused: false }; }
    if (command === 'research-status') return flags.id ? scopeRun(store, flags.id, config.scopeId) : store.listRuns(config.scopeId);
    if (command === 'research-cancel') { const id = required(flags, 'id'); scopeRun(store, id, config.scopeId); return store.cancelRun(id); }
    if (command === 'validation-invalidate') {
      const value = required(flags, 'digest');
      invariant(store.listArtifacts('release').some(a => { const r = a.value as unknown as ReleaseBinding; return r.scopeId === config.scopeId && r.validationDigest === value; }), 'NOT_FOUND', 'Validation is not associated with a release in this scope');
      store.invalidateValidation(value, required(flags, 'reason')); return { validationDigest: value, invalidated: true, consequence: 'Dependent active releases stop accepting new decisions until explicitly recovered.' };
    }
    if (command === 'explain') {
      const id = required(flags, 'decision'); const artifact = store.listArtifacts('decision').find(a => { const d = a.value as unknown as DecisionRecord; return d.observation.strategyScopeId === config.scopeId && (d.decisionId === id || a.digest === id); });
      invariant(artifact, 'NOT_FOUND', 'No decision found in this scope'); return artifact;
    }
    if (command === 'export') {
      const data = { schemaVersion: '1.0', scopeId: config.scopeId, activeReleaseDigest: store.activeRelease(config.scopeId),
        events: store.events({ scopeId: config.scopeId }), decisions: store.listArtifacts('decision').filter(a => (a.value as unknown as DecisionRecord).observation.strategyScopeId === config.scopeId),
        note: 'Private holdout protocols and validation report details are excluded.' };
      if (flags.output) { const path = resolve(flags.output); await writableJson(path, data); return { path, events: data.events.length, decisions: data.decisions.length }; }
      return data;
    }
    const callable = ['run','step','evaluate','research-run','research-worker'].includes(command);
    if (['research-run','research-worker'].includes(command)) invariant(config.runtime.mode !== 'offline', 'ACCESS_DENIED', 'Offline mode cannot call real research models');
    const { domain, evaluator } = await domainFor(config); const model = modelFor(config, callable);
    runtime = new DuelLoop({ applicationId: config.applicationId, domain, model, store, mode: config.runtime.mode,
      executionOwner: config.runtime.executionOwner, maxDecisionMs: config.runtime.maxDecisionMs, executionReserveMs: config.runtime.executionReserveMs });
    if (['run','step'].includes(command) && !store.activeRelease(config.scopeId)) runtime.bootstrap(validateStrategy(await readJsonFile(config.strategy), domain), config.scopeId);
    if (['run','step'].includes(command)) store.setActivationMode(config.scopeId, config.activationMode);
    if (command === 'run' || command === 'step') {
      const count = command === 'step' ? 1 : flags.steps === undefined ? config.runtime.maxSteps : Number(flags.steps);
      invariant(Number.isSafeInteger(count) && count > 0 && count <= config.runtime.maxSteps, 'CONFIG_INVALID', '--steps must fit the configured maxSteps limit');
      const streams = command === 'step' ? [flags.stream ?? config.runtime.streamIds[0]!] : config.runtime.streamIds;
      invariant(streams.every(s => config.runtime.streamIds.includes(s)), 'CONFIG_INVALID', '--stream must be configured');
      let completed = 0; let last: unknown = null;
      for (let i = 0; i < count && !options.signal?.aborted; i++) {
        for (const stream of streams) { if (options.signal?.aborted) break; last = await runtime.step(stream); completed++; }
        if (config.runtime.intervalMs && i + 1 < count && !options.signal?.aborted) await new Promise<void>(resolve => {
          const timer = setTimeout(done, config.runtime.intervalMs); function done() { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(); } options.signal?.addEventListener('abort', done, { once: true });
        });
      }
      await runtime.submitFeedback(); return { completedSteps: completed, interrupted: options.signal?.aborted ?? false, modelKind: model.kind, activeReleaseDigest: store.activeRelease(config.scopeId), last };
    }
    if (command === 'reconcile') return runtime.reconcile(config.scopeId);
    if (command === 'activate' || command === 'rollback') {
      const release = required(flags, 'release'); invariant(store.release(release).scopeId === config.scopeId, 'ACCESS_DENIED', 'Release belongs to another scope');
      if (command === 'activate') { store.setActivationMode(config.scopeId, config.activationMode); await runtime.activate(release, true); }
      else await runtime.rollback(config.scopeId, release);
      return { activeReleaseDigest: store.activeRelease(config.scopeId) };
    }
    invariant(evaluator && domain.capabilities.evaluation, 'CAPABILITY_UNSUPPORTED', 'Domain factory must supply an evaluation adapter for this command');
    if (command === 'evaluate') {
      const active = store.activeRelease(config.scopeId); invariant(active, 'NOT_FOUND', 'Run the application once to bootstrap a baseline');
      const baseline = store.getArtifact<StrategyPackage>(store.release(active).strategyDigest);
      const candidate = validateStrategy(await readJsonFile(resolve(required(flags, 'candidate'))), domain);
      const protocol = validateProtocol(await readJsonFile(config.evaluation.developmentProtocol)); let calls = 0; let exhausted = false;
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.evaluation.timeoutMs);
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      const bounded: DecisionModel = { id: model.id, kind: model.kind, behaviorIdentity: model.behaviorIdentity, score: async request => { if (++calls > config.evaluation.maxModelCalls) { exhausted = true; controller.abort(); throw new DuelLoopError('BUDGET_EXHAUSTED', 'Development model-call budget exhausted'); } return model.score(request); } };
      try {
        const report = await evaluateCandidate({ candidate, baseline, protocol, adapter: evaluator, model: bounded, dependencies: runtime.dependencies, baseReleaseDigest: active, stage: 'development', signal });
        const reportDigest = store.putArtifact('development_report', report); store.appendEvent('evaluation.development', config.scopeId, { reportDigest, modelCalls: calls });
        return { reportDigest, report, modelCalls: calls, publishable: false };
      } catch (error) {
        if (exhausted) throw new DuelLoopError('BUDGET_EXHAUSTED', 'Development model-call budget exhausted');
        if (options.signal?.aborted) throw new DuelLoopError('CANCELLED', 'Development evaluation cancelled');
        if (controller.signal.aborted) throw new DuelLoopError('MODEL_TIMEOUT', 'Development evaluation deadline exceeded');
        throw error;
      }
      finally { clearTimeout(timer); }
    }
    invariant(config.research.mode !== 'off', 'CAPABILITY_UNSUPPORTED', 'Research is disabled in configuration');
    const roleProviders: { researcher: ResearchProvider; adversary?: ResearchProvider; integrator?: ResearchProvider } = {} as { researcher: ResearchProvider };
    for (const [name, settings] of Object.entries(config.research.roles)) { const provider = new PiResearchProvider(settings); providers.push(provider); roleProviders[name as keyof typeof roleProviders] = provider; }
    const orchestrator = new ResearchOrchestrator({ store, domain, model, evaluator, dependencies: runtime.dependencies,
      providers: roleProviders, mode: config.research.mode, budget: config.research.budget, maxRounds: config.research.maxRounds });
    if (command === 'research-create') { const p = await protocols(config); return orchestrator.create({ scopeId: config.scopeId, ...(flags.id ? { id: flags.id } : {}), protocol: p.final, developmentProtocol: p.development, snapshotOptions: config.research.trigger?.snapshotOptions }); }
    if (command === 'research-worker') {
      invariant(config.research.trigger, 'CONFIG_INVALID', 'research-worker requires an explicit trigger configuration');
      const p = await protocols(config); const { ResearchWorker } = await import('./worker.js');
      const worker = new ResearchWorker({ orchestrator, store, scopeId: config.scopeId, protocol: p.final, developmentProtocol: p.development,
        settledTrajectories: config.research.trigger.settledTrajectories, cooldownMs: config.research.trigger.cooldownMs, snapshotOptions: config.research.trigger.snapshotOptions });
      await worker.run({ signal: options.signal, pollIntervalMs: config.research.trigger.pollIntervalMs });
      return { stopped: true, scopeId: config.scopeId };
    }
    const id = required(flags, 'id'); scopeRun(store, id, config.scopeId);
    if (command === 'research-recover') return orchestrator.recover(id);
    if (command === 'research-run') {
      const cancel = () => { orchestrator.cancel(id); }; options.signal?.addEventListener('abort', cancel, { once: true }); cleanup = () => options.signal?.removeEventListener('abort', cancel);
      if (options.signal?.aborted) { cancel(); return store.getRun(id); }
      const result = await orchestrator.run(id);
      // Operator sees the conclusion; private holdout report details stay in the store.
      return { run: result.run, submissionDigest: result.submissionDigest ?? null, validationDigest: result.validationDigest ?? null, releaseDigest: result.releaseDigest ?? null };
    }
    throw new DuelLoopError('CONFIG_INVALID', 'Unsupported command');
  } finally { cleanup?.(); await Promise.all(providers.map(p => p.dispose())); await runtime?.close(); store.close(); }
}

export function cliExitCode(error: unknown): number {
  if (!(error instanceof DuelLoopError)) return 1;
  if (error.code === 'CANCELLED') return 130;
  if (['CONFIG_INVALID','STRATEGY_INVALID','VERSION_INCOMPATIBLE','CAPABILITY_UNSUPPORTED'].includes(error.code)) return 2;
  if (['CONFLICT','STATE_STALE','EXECUTION_UNKNOWN','ACCESS_DENIED','NOT_FOUND','ACTIVATION_DEFERRED','HOLDOUT_UNAVAILABLE'].includes(error.code)) return 3;
  if (error.code === 'VALIDATION_REJECTED') return 4;
  if (['MODEL_INVALID','MODEL_TIMEOUT','BUDGET_EXHAUSTED'].includes(error.code)) return 5;
  return 1;
}
async function main(): Promise<void> {
  const controller = new AbortController(); const abort = () => controller.abort(); process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const result = await executeCli(process.argv.slice(2), { signal: controller.signal });
    process.stdout.write(JSON.stringify({ ok: true, command: process.argv[2] ?? 'help', data: jsonValue(result) }) + '\n');
    const outcome = result as { valid?: boolean; ok?: boolean; status?: string; run?: { status: string }; report?: { status: string } };
    const status = outcome.run?.status ?? (process.argv[2] === 'research-recover' ? outcome.status : undefined);
    if (outcome.valid === false) process.exitCode = 2;
    else if (outcome.ok === false) process.exitCode = 1;
    else if (status === 'cancelled') process.exitCode = 130;
    else if (status === 'budget_exhausted') process.exitCode = 5;
    else if (['waiting_protocol','validated_pending_release'].includes(status ?? '')) process.exitCode = 3;
    else if (status === 'error') process.exitCode = 1;
    else if (['completed_failed','completed_inconclusive'].includes(status ?? '') || ['failed','inconclusive'].includes(outcome.report?.status ?? '')) process.exitCode = 4;
    if (controller.signal.aborted) process.exitCode = 130;
  } catch (error) {
    const failure = controller.signal.aborted ? new DuelLoopError('CANCELLED', 'Command cancelled') : error;
    const structured = failure instanceof DuelLoopError ? failure.toJSON() : { name: 'DuelLoopError', code: 'INTERNAL_ERROR', message: 'Command failed; inspect application code and permissions' };
    process.stderr.write(JSON.stringify({ ok: false, error: structured }) + '\n'); process.exitCode = cliExitCode(failure);
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) await main();
