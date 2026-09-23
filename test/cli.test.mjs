import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executeCli } from '../dist/cli.js';
import { validateConfiguration, loadConfiguration } from '../dist/config.js';
import { SqliteStore, createKuhnStrategy } from '../dist/index.js';

async function fixture(fn, domain = 'kuhn') {
  const directory = await mkdtemp(join(tmpdir(), 'duelloop-cli-'));
  try {
    await executeCli(['init','--dir',directory,'--domain',domain,'--application','test-app','--scope','test-scope']);
    const path = join(directory, 'duelloop.json');
    const command = (name, ...args) => executeCli([name,'--config',path,...args]);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    await fn({ directory, path, command, raw, save: value => writeFile(path, JSON.stringify(value)) });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('CLI init is offline, refuses overwrite, and doctor does not create a database', async () => {
  await fixture(async ({ directory, path, command }) => {
    const result = await command('doctor');
    assert.equal(result.modelCalls, 0); assert.equal(result.externalModuleExecuted, false);
    await assert.rejects(access(join(directory, 'data', 'duelloop.sqlite')));
    await assert.rejects(executeCli(['init','--dir',directory,'--domain','kuhn','--application','other','--scope','other']), { code: 'CONFLICT' });
    const config = await loadConfiguration(path); assert.equal(config.strategy, join(directory, 'strategy.json'));
    const strategy=JSON.parse(await readFile(config.strategy,'utf8'));assert.equal(strategy.schemaVersion,'2.0');
    assert.equal(Object.hasOwn(strategy,'fallback'),false);assert.equal(Object.hasOwn(strategy.decision,'minRequiredConfidence'),false);
    const protocol=JSON.parse(await readFile(config.evaluation.finalProtocol,'utf8'));assert.equal(protocol.version,'2.0');assert.equal(Object.hasOwn(protocol,'maxFallbackRate'),false);
  });
});

test('CLI basic cycle runs, explains, exports, pauses, backs up, restores, and verifies integrity', async () => {
  await fixture(async ({ directory, path, command }) => {
    const first = await command('run','--steps','4');
    assert.equal(first.completedSteps, 4); assert.equal(first.modelKind, 'fixture');
    assert.equal(first.last.receipt.status, 'completed');
    const status = await command('status'); assert.equal(status.activeReleaseDigest, first.activeReleaseDigest);
    const explanation = await command('explain','--decision',first.last.decision.decisionId);
    assert.equal(explanation.value.modelKind, 'fixture'); assert.equal(explanation.value.action.id, first.last.decision.action.id);
    await command('pause'); await command('step'); // Pausing release activation does not stop current decisions.
    await command('resume');
    assert.equal((await command('integrity')).ok, true);
    const cleanup = await command('cleanup'); assert.equal(cleanup.dryRun, true);
    const applied = await command('cleanup','--apply'); assert.equal(applied.dryRun, false);
    const exported = await command('export'); assert.ok(exported.decisions.length >= 5);
    assert.equal(JSON.stringify(exported).includes('"kind":"evaluation_protocol"'), false);
    const backup = join(directory,'backup.sqlite'); await command('backup','--output',backup);
    const restored = join(directory,'restored.sqlite');
    assert.equal((await executeCli(['restore','--input',backup,'--output',restored])).ok, true);
    await assert.rejects(executeCli(['restore','--input',backup,'--output',restored]), { code: 'CONFLICT' });
    await assert.rejects(command('run','--steps','1000000'), { code: 'CONFIG_INVALID' });
    const other = JSON.parse(await readFile(path,'utf8')); other.applicationId = 'wrong-app'; await writeFile(path, JSON.stringify(other));
    await assert.rejects(command('status'), { code: 'ACCESS_DENIED' });
  });
});

test('CLI strategy checks and standalone evaluation cannot publish a release', async () => {
  await fixture(async ({ directory, command }) => {
    await command('step'); const before = await command('status');
    await command('strategy-validate');
    const changes = await executeCli(['strategy-diff','--before',join(directory,'strategy.json'),'--after',join(directory,'strategy.json')]);
    assert.equal(changes.beforeDigest, changes.afterDigest);
    const result = await command('evaluate','--candidate',join(directory,'strategy.json'));
    assert.equal(result.report.stage, 'development'); assert.equal(result.report.modelKind, 'fixture'); assert.equal(result.publishable, false);
    assert.equal((await command('status')).releases.length, before.releases.length);
  }, 'auction');
});

test('standalone development evaluation stops at the configured call budget', async () => {
  await fixture(async ({ directory, command, raw, save }) => {
    await command('step'); raw.evaluation.maxModelCalls = 1; await save(raw);
    await assert.rejects(command('evaluate','--candidate',join(directory,'strategy.json')), { code:'BUDGET_EXHAUSTED' });
  });
});

test('configuration schema rejects typos, embedded credentials, missing IDs/budgets, and unsafe modes', async () => {
  await fixture(async ({ raw }) => {
    for (const mutate of [
      c => { c.scopeId = ''; }, c => { c.extra = true; }, c => { c.runtime.maxDecisionMs = -1; },
      c => { c.decisionModel = { kind:'jev', model:'jev-pinned', apiKey:'SECRET', apiKeyEnv:'KEY', timeoutMs:1000 }; },
      c => { c.decisionModel = { kind:'jev', model:'jev-latest', apiKeyEnv:'KEY', timeoutMs:1000 }; },
      c => { c.runtime.mode = 'live'; }, c => { c.evaluation.finalProtocol = c.evaluation.developmentProtocol; },
      c => { c.decisionModel.minRequiredConfidence = 0; }, c => { c.runtime.fallback = 'domain_baseline'; },
      c => { c.evaluation.maxFallbackRate = 1; },
    ]) {
      const copy = structuredClone(raw); mutate(copy); assert.throws(() => validateConfiguration(copy), { code: 'CONFIG_INVALID' });
    }
  });
});

test('doctor reports only credential presence and never imports an external module', async () => {
  await fixture(async ({ directory, raw, save, command }) => {
    const marker = join(directory,'executed'); const modulePath = join(directory,'environment.mjs');
    await writeFile(modulePath, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'loaded');throw new Error('PRIVATE_ENV_SECRET');`);
    raw.domain = { kind:'module', path:'./environment.mjs', exportName:'createDomain', options:{} };
    raw.runtime.mode = 'simulation'; raw.decisionModel = { kind:'jev', model:'jev-pinned', apiKeyEnv:'DUELLOOP_TEST_SECRET', timeoutMs:1000 };
    process.env.DUELLOOP_TEST_SECRET = 'PRIVATE_ENV_SECRET';
    try {
      await save(raw); const diagnostic = await command('doctor');
      assert.equal(diagnostic.credentials[0].present, true); assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_ENV_SECRET/);
      await assert.rejects(access(marker));
      await assert.rejects(command('step'), error => error.code === 'CONFIG_INVALID' && !JSON.stringify(error).includes('PRIVATE_ENV_SECRET'));
      await access(marker);
    } finally { delete process.env.DUELLOOP_TEST_SECRET; }
  });
});

test('trusted external domain factory integrates through CLI without modifying core', async () => {
  await fixture(async ({ directory, raw, save, command }) => {
    const entry = pathToFileURL(resolve('dist/index.js')).href;
    await writeFile(join(directory,'environment.mjs'), `import {AuctionDomain,AuctionEvaluationAdapter} from ${JSON.stringify(entry)};
export function createDomain({applicationId,scopeId,options}) {return {domain:new AuctionDomain({applicationId,scopeId,...options}),evaluator:new AuctionEvaluationAdapter()};}`);
    raw.domain = { kind:'module', path:'./environment.mjs', exportName:'createDomain', options:{seed:2,opponentId:'fixed'} };
    await save(raw); const result = await command('run','--steps','3'); assert.equal(result.completedSteps, 3);
    assert.equal(result.last.decision.observation.domainId, 'resource-auction');
  }, 'auction');
});

test('CLI activate and rollback reject foreign scopes, invalid report bindings, and fixture evidence in live mode', async () => {
  await fixture(async ({ directory, command, raw, save }) => {
    raw.decisionModel.id = 'pinned-test-model'; await save(raw); await command('step');
    const store = new SqliteStore(join(directory,'data','duelloop.sqlite'));
    const base = store.activeRelease('test-scope'); const dependencies = store.release(base).dependencies;
    const register = (id, stage) => {
      const strategy = createKuhnStrategy(); strategy.version = id; strategy.parentVersion = 'v1';
      const strategyDigest = store.putArtifact('strategy', strategy);
      const run = store.createRun({ id, scopeId:'test-scope', baseReleaseDigest:base,
        researchSnapshotId:store.snapshot('test-scope',Date.now()), evaluationProtocolDigest:store.putArtifact('protocol',{id},'private'),status:'created',data:{} });
      for (const [from,to] of [['created','researching'],['researching','candidate_locked'],['candidate_locked','final_evaluating'],['final_evaluating','completed_passed']]) store.transitionRun(run.id,[from],to);
      const validationDigest = store.putArtifact('validation_report',{candidateDigest:strategyDigest,baseReleaseDigest:base,protocolDigest:'test-protocol',dependencies,status:'passed',reasons:[],
        modelKind:'fixture',stage,sampleCount:10,meanDifference:1,lowerBound:0.5,groups:{},p95LatencyMs:1,createdAt:Date.now()},'private');
      return store.registerRelease({strategyDigest,dependencies,scopeId:'test-scope',expectedActiveDigest:base,validationDigest,source:'research',researchRunId:run.id});
    };
    const invalid = register('invalid-stage','development'); const fixtureRelease = register('fixture-evidence','final');
    store.bindScope('foreign-scope','foreign-app');
    const foreignRelease = store.registerRelease({strategyDigest:store.release(base).strategyDigest,dependencies,scopeId:'foreign-scope',expectedActiveDigest:null,validationDigest:null,source:'bootstrap'});
    store.close();
    for (const name of ['activate','rollback']) await assert.rejects(command(name,'--release',foreignRelease), {code:'ACCESS_DENIED'});
    await assert.rejects(command('rollback','--release',invalid), {code:'VALIDATION_REJECTED'});
    const entry = pathToFileURL(resolve('dist/index.js')).href;
    await writeFile(join(directory,'live-domain.mjs'), `import {KuhnPokerDomain} from ${JSON.stringify(entry)};export function createDomain({applicationId,scopeId}){return {domain:new KuhnPokerDomain({applicationId,scopeId})};}`);
    raw.domain = {kind:'module',path:'./live-domain.mjs',exportName:'createDomain',options:{}};
    raw.runtime.mode = 'live'; raw.decisionModel = {kind:'jev',model:'pinned-test-model',apiKeyEnv:'UNSET_MODEL_KEY',timeoutMs:1000}; await save(raw);
    for (const name of ['activate','rollback']) await assert.rejects(command(name,'--release',fixtureRelease), {code:'VALIDATION_REJECTED'});
    assert.equal((await command('status')).activeReleaseDigest, base);
  });
});

test('CLI rollback consults the external domain activation checkpoint', async () => {
  await fixture(async ({ directory, command, raw, save }) => {
    const initial = await command('step');
    const entry = pathToFileURL(resolve('dist/index.js')).href;
    await writeFile(join(directory,'blocked-domain.mjs'), `import {AuctionDomain} from ${JSON.stringify(entry)};export function createDomain({applicationId,scopeId}){const domain=new AuctionDomain({applicationId,scopeId});domain.canActivate=async()=>false;return {domain};}`);
    raw.domain = {kind:'module',path:'./blocked-domain.mjs',exportName:'createDomain',options:{}}; await save(raw);
    await assert.rejects(command('rollback','--release',initial.activeReleaseDigest), {code:'CONFLICT'});
  }, 'auction');
});

test('research creation/cancellation/recovery is persistent and offline mode blocks paid research', async () => {
  await fixture(async ({ raw, save, command }) => {
    await command('run','--steps','3');
    raw.research = { mode:'single', maxRounds:1, budget:{maxWallTimeSeconds:60,maxTokensTotal:4096,maxModelCalls:3,maxDecisionModelCalls:100,maxRepairAttempts:0},
      roles:{researcher:{provider:'openai',model:'gpt-4o',apiKeyEnv:'UNSET_RESEARCH_TEST_KEY',maxTurns:4}} };
    await save(raw);
    const run = await command('research-create','--id','persistent-run'); assert.equal(run.status, 'created');
    await assert.rejects(command('research-run','--id',run.id), { code:'ACCESS_DENIED' });
    assert.equal((await command('research-cancel','--id',run.id)).status, 'cancel_requested');
    assert.equal((await command('research-recover','--id',run.id)).status, 'cancelled');
    assert.equal((await command('research-status','--id',run.id)).status, 'cancelled');
  });
});

test('real executable exposes JSON help/version and structured nonzero errors', () => {
  for (const flag of ['--help','--version']) {
    const result = spawnSync(process.execPath,['dist/cli.js',flag],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).ok,true);
  }
  const result = spawnSync(process.execPath,['dist/cli.js','unknown-command'],{encoding:'utf8'});
  assert.equal(result.status,2); assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).error.code,'CONFIG_INVALID');
});

test('installed-style symlink entry starts CLI while importing it has no execution side effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duelloop-bin-'));
  try {
    const link = join(directory,'duelloop'); await symlink(resolve('dist/cli.js'), link);
    const result = spawnSync(process.execPath,[link,'--version'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr); assert.equal(JSON.parse(result.stdout).data.name,'duelloop');
    const imported = spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(resolve('dist/cli.js')).href)});`],{encoding:'utf8'});
    assert.equal(imported.status,0,imported.stderr); assert.equal(imported.stdout,'');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('CLI status exposes persisted pause/mode and candidate blockers across command restarts',async()=>{
  await fixture(async({command,raw,save,directory})=>{
    raw.activationMode='automatic_after_validation';await save(raw);await command('step');
    let status=await command('status');assert.equal(status.activationPaused,false);assert.equal(status.activationMode,'automatic_after_validation');
    await command('pause');status=await command('status');assert.equal(status.activationPaused,true);
    assert.equal(status.releases.find(r=>r.active).state,'active','Activation pause does not pause existing decisions');
    await command('resume');raw.activationMode='explicit';await save(raw);await command('step');
    status=await command('status');assert.equal(status.activationPaused,false);assert.equal(status.activationMode,'explicit');
    const store=new SqliteStore(join(directory,raw.database));
    const base=store.activeRelease(raw.scopeId);const old=store.release(base);const strategy=store.getArtifact(old.strategyDigest);strategy.version='v2';
    const strategyDigest=store.putArtifact('strategy',strategy);const run=store.createRun({id:'status-candidate',scopeId:raw.scopeId,baseReleaseDigest:base,researchSnapshotId:store.snapshot(raw.scopeId,Date.now()),evaluationProtocolDigest:store.putArtifact('evaluation_protocol',{id:'test'},'private'),status:'created',data:{}});
    store.transitionRun(run.id,['created'],'researching');store.transitionRun(run.id,['researching'],'candidate_locked');store.transitionRun(run.id,['candidate_locked'],'final_evaluating');store.transitionRun(run.id,['final_evaluating'],'completed_passed');
    const validationDigest=store.putArtifact('validation_report',{status:'passed',stage:'final',candidateDigest:strategyDigest,baseReleaseDigest:base,dependencies:old.dependencies,modelKind:'fixture'},'private');
    const release=store.registerRelease({...old,strategyDigest,expectedActiveDigest:base,validationDigest,source:'research',researchRunId:run.id});
    store.appendEvent('release.deferred',raw.scopeId,{releaseDigest:release,reason:'scope_boundary'});store.close();
    status=await command('status');const pending=status.releases.find(r=>r.digest===release);
    assert.equal(pending.state,'blocked');assert.ok(pending.blockers.includes('explicit_activation_required'));
    assert.equal(pending.lastDeferral.reason,'scope_boundary');assert.equal(pending.boundaryStatus,'not_checked');assert.equal(status.dependenciesChecked,false);
    await command('validation-invalidate','--digest',validationDigest,'--reason','feedback corrected');
    status=await command('status');assert.ok(status.releases.find(r=>r.digest===release).blockers.includes('VALIDATION_REJECTED'));
  });
});

test('CLI storage budgets are validated and stop a decision before its intent is submitted',async()=>{
  await fixture(async({command,raw,save,directory})=>{
    await command('step');
    for(const storage of [{maxArtifactBytes:0},{maxDatabaseBytes:-1},{maxArtifactBytes:1024,unknown:true}]){
      assert.throws(()=>validateConfiguration({...raw,storage}),{code:'CONFIG_INVALID'});
    }
    const before=new SqliteStore(join(directory,raw.database));const oldIntents=before.intents().length;const active=before.activeRelease(raw.scopeId);before.close();
    raw.storage={maxArtifactBytes:128};await save(raw);
    await assert.rejects(()=>command('step'),{code:'STORAGE_FAILURE'});
    const after=new SqliteStore(join(directory,raw.database));
    assert.equal(after.intents().length,oldIntents);assert.equal(after.activeRelease(raw.scopeId),active);assert.equal(after.integrity().ok,true);after.close();
  });
});
