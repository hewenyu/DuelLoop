import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidate, validateProtocol } from '../dist/evaluation.js';
import { createAuctionStrategy } from '../dist/domains.js';
import { decisionPolicyRuntimeVersion, modelBehaviorDigest } from '../dist/runtime.js';
const decisionPolicy = { maxDecisionMs: 5000, executionReserveMs: 25 };
const baseline = createAuctionStrategy(); baseline.scope.domain = 'test'; baseline.version = '1';
const candidate = structuredClone(baseline); candidate.version = '2';
const identity = {adapterVersion:'evaluation-test-1',deploymentVersion:'fixture-1',protocolVersion:'score-1',configurationDigest:'fixture'};
const model = {behaviorIdentity:identity,id:'fixture',kind:'fixture',score:async()=>{throw Error('unused');}};
const dependencies = {model:'fixture',modelKind:model.kind,modelBehaviorDigest:modelBehaviorDigest(model),runtime:decisionPolicyRuntimeVersion(decisionPolicy),rules:'1',featureBuilder:'1',knowledgeUpdater:'1',continuationPolicy:'1',contextDigest:'test'};
const { model: _model, modelKind: _kind, modelBehaviorDigest: _behavior, runtime: _runtime, ...domainDependencies } = dependencies;
const protocol = {version:'3.0',id:'test',domainId:'test',seeds:[1,2,3],opponentIds:['a','b'],trajectoriesPerSeed:10,knowledgeStateMode:'online_update',initialKnowledge:{nested:{count:0}},metric:{name:'reward',direction:'maximize',unit:'points'},minSamples:3,minimumImprovement:0,maxGroupRegression:4,confidenceLevel:.95,maxP95DecisionComputeMs:100,maxDevelopmentEvalRuns:2,maxFinalEvaluationsPerRun:1,holdoutId:'test-holdout',maxHoldoutUses:1};
const episode = reward => ({reward,decisions:10,decisionComputeLatenciesMs:Array(10).fill(2),modelCalls:0});
const evaluate = (adapter,p={})=>evaluateCandidate({candidate,baseline,protocol:{...protocol,...p},adapter:{decisionPolicy,domainDependencies,...adapter},model,dependencies,baseReleaseDigest:'base',stage:'final'});
test('paired statistics use independent seeds, not actions or opponents; Student t small-sample interval',async()=>{
 const report=await evaluate({id:'fixture',episode:async({strategy,seed})=>episode(strategy.version==='1'?0:seed)});
 assert.equal(report.sampleCount,3); assert.equal(report.meanDifference,2);
 assert.ok(Math.abs(report.lowerBound-(-.4841377117))<1e-7);
 assert.equal(report.status,'inconclusive'); assert.equal(report.modelKind,'fixture');
});
test('both sides and each opponent start with isolated knowledge, even after run order changes',async()=>{
 const seen=[];
 const report=await evaluate({id:'fixture',episode:async({strategy,knowledge,seed,opponentId})=>{
  assert.equal(knowledge.nested.count,0); knowledge.nested.count=99; seen.push([seed,opponentId,strategy.version]);
  return episode(strategy.version==='2'?1:0);
 }});
 assert.equal(report.status,'passed'); assert.deepEqual(protocol.initialKnowledge,{nested:{count:0}});
 assert.equal(seen[0][2],'1'); assert.equal(seen[4][2],'2');
});
test('frozen knowledge is recursively immutable',async()=>{
 await assert.rejects(evaluate({id:'mutation',episode:async({knowledge})=>{knowledge.nested.count=1;return episode(0);}},{knowledgeStateMode:'frozen'}),TypeError);
});
test('group regression and excessive latency reject even profitable overall strategy',async()=>{
 const report=await evaluate({id:'fixture',episode:async({strategy,opponentId})=>({...episode(strategy.version==='1'?0:opponentId==='a'?20:-5),decisionComputeLatenciesMs:Array(10).fill(200)})});
 assert.equal(report.status,'failed');
 assert.ok(report.reasons.includes('opponent_group_regression')); assert.ok(report.reasons.includes('latency_limit_exceeded'));
});
test('minimize metric reverses paired improvement; incomplete latency rejects',async()=>{
 assert.equal((await evaluate({id:'fixture',episode:async({strategy})=>episode(strategy.version==='1'?5:1)},{metric:{name:'cost',direction:'minimize',unit:'dollars'}})).status,'passed');
 await assert.rejects(evaluate({id:'bad',episode:async()=>({...episode(1),decisionComputeLatenciesMs:[]})}),e=>e.code==='VALIDATION_REJECTED');
});
test('immutable protocol rejects duplicate seeds and multiple final attempts',()=>{
 assert.throws(()=>validateProtocol({...protocol,seeds:[1,1]}));
 assert.throws(()=>validateProtocol({...protocol,maxFinalEvaluationsPerRun:2}));
});
test('evaluation refuses missing or mismatched runtime policy before issuing model calls', async () => {
 let calls = 0;
 const adapter = { id: 'policy-fixture', decisionPolicy, domainDependencies, episode: async () => { calls++; return episode(1); } };
 const options = { candidate, baseline, protocol, adapter, model, dependencies, baseReleaseDigest: 'base', stage: 'final' };
 for (const badPolicy of [undefined, {}, { maxDecisionMs: 20, executionReserveMs: 5 }, { ...decisionPolicy, executionReserveMs: 50 }, { ...decisionPolicy, randomSeed: 'different' }]) {
  await assert.rejects(evaluateCandidate({ ...options, adapter: { ...adapter, decisionPolicy: badPolicy } }), { code: 'VERSION_INCOMPATIBLE' });
 }
 assert.equal(calls, 0, 'No experiment starts under an unbound policy');
 const policy = { maxDecisionMs: 20, executionReserveMs: 5, randomSeed: 'pinned-sampling' };
 const report = await evaluateCandidate({ ...options, adapter: { ...adapter, decisionPolicy: policy }, dependencies: { ...dependencies, runtime: decisionPolicyRuntimeVersion(policy) } });
 assert.equal(report.dependencies.runtime, decisionPolicyRuntimeVersion(policy)); assert(calls > 0);
});
test('evaluation requires an exact domain behavior declaration, not just a matching runtime/model', async () => {
 let calls = 0;
 const adapter = { id: 'domain-binding-fixture', decisionPolicy, domainDependencies, episode: async () => { calls++; return episode(1); } };
 const options = { candidate, baseline, protocol, adapter, model, dependencies, baseReleaseDigest: 'base', stage: 'final' };
 for (const badDomain of [undefined, {}, ...Object.keys(domainDependencies).map(key => ({ ...domainDependencies, [key]: 'changed' }))]) {
  await assert.rejects(evaluateCandidate({ ...options, adapter: { ...adapter, domainDependencies: badDomain } }), { code: 'VERSION_INCOMPATIBLE' });
 }
 assert.equal(calls, 0);
});
test('built-in evaluator rejects an SDK domain whose feature builder or context changed before any model calls', async () => {
 const { AuctionDomain, AuctionEvaluationAdapter, createAuctionStrategy, DuelLoop, SqliteStore, FixtureDecisionModel } = await import('../dist/index.js');
 let calls = 0;
 const decisionModel = new FixtureDecisionModel('binding-fixture', question => {
  calls++; return { score: 0, confidence: 1, probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), i === 0 ? 1 : 0])) };
 });
 const domain = new AuctionDomain({ applicationId: 'binding-check' });
 const store = new SqliteStore(); const app = new DuelLoop({ applicationId: 'binding-check', domain, store, model: decisionModel });
 const strategy = createAuctionStrategy(); const adapter = new AuctionEvaluationAdapter();
 const options = { candidate: strategy, baseline: strategy, protocol: { ...protocol, domainId: domain.id, opponentIds: ['fixed'], trajectoriesPerSeed: 1 }, adapter, model: decisionModel, baseReleaseDigest: 'baseline', stage: 'final' };
 try {
  const report = await evaluateCandidate({ ...options, dependencies: app.dependencies });
  assert.equal(report.status, 'inconclusive'); assert(calls > 0); calls = 0;
  domain.featureBuilderVersion = 'unmeasured-features-v2';
  await assert.rejects(evaluateCandidate({ ...options, dependencies: app.dependencies }), { code: 'VERSION_INCOMPATIBLE' });
  domain.featureBuilderVersion = '1'; domain.context.rules += ' Changed application rule.';
  await assert.rejects(evaluateCandidate({ ...options, dependencies: app.dependencies }), { code: 'VERSION_INCOMPATIBLE' });
  assert.equal(calls, 0, 'Neither mismatched domain may start an experiment');
  assert(Object.isFrozen(adapter.domainDependencies));
 } finally { await app.close(); store.close(); }
});

test('an interrupted experiment never reports success from its earlier successful pairs', async () => {
 let calls = 0, reports = 0;
 await assert.rejects(evaluateCandidate({candidate, baseline, protocol, adapter: {id:'interrupted', decisionPolicy, domainDependencies, async episode({strategy}) {
  calls++; if (calls === 5) throw new Error('model unavailable midway');
  return episode(strategy.version === '2' ? 10 : 0);
 }}, model, dependencies, baseReleaseDigest:'base', stage:'final', onEvidence() { reports++; }}), /model unavailable midway/);
 assert.equal(calls, 5); assert.equal(reports, 0);
});
test('model failures cannot be hidden by an evaluator that returns a profitable summary', async () => {
 for (const [broken, expected] of [
  [{ ...model, async score() { throw new Error('model offline'); } }, /model offline/],
  [{ ...model, async score() { return { model: model.id, answers: {} }; } }, {code:'MODEL_INVALID'}],
 ]) {
  await assert.rejects(evaluateCandidate({candidate, baseline, protocol, adapter: {id:'swallows-failure', decisionPolicy, domainDependencies, async episode({model: measured}) {
   try { await measured.score({state:{}, questions:[{id:'q', actionId:'a', dimensionId:'d', instructions:'test', criteria:['loss','gain']}], signal:new AbortController().signal}); } catch {}
   return episode(100);
  }}, model:broken, dependencies, baseReleaseDigest:'base', stage:'final'}), expected);
 }
});
test('real evaluation rejects unmodeled decisions and legacy fallback protocol/results', async () => {
 await assert.rejects(evaluateCandidate({candidate,baseline,protocol,adapter:{id:'program-actions',decisionPolicy,domainDependencies,episode:async()=>episode(100)},model:{...model,kind:'real'},dependencies:{...dependencies,modelKind:'real',modelBehaviorDigest:modelBehaviorDigest({...model,kind:'real'})},baseReleaseDigest:'base',stage:'final'}), {code:'VALIDATION_REJECTED'});
 assert.throws(() => validateProtocol({...protocol, maxFallbackRate: 0}), {code:'CONFIG_INVALID'});
 await assert.rejects(evaluate({id:'legacy-result',episode:async()=>({...episode(100),fallbacks:0})}), {code:'VALIDATION_REJECTED'});
});

test('an evaluator cannot return while its model decision remains pending', async () => {
 let finish;
 const pendingModel = { ...model, async score() { return new Promise(resolve => { finish = resolve; }); } };
 await assert.rejects(evaluateCandidate({candidate,baseline,protocol,adapter:{id:'unfinished',decisionPolicy,domainDependencies,async episode({model: measured}) {
  void measured.score({state:{},questions:[{id:'q',actionId:'a',dimensionId:'d',instructions:'test',criteria:['loss','gain']}],signal:new AbortController().signal});
  return episode(100);
 }},model:pendingModel,dependencies,baseReleaseDigest:'base',stage:'final'}), {code:'VALIDATION_REJECTED'});
 finish({model:model.id,answers:{q:{score:1,confidence:0,probabilities:{'0':0,'1':1}}}});
});

test('public evaluation rejects legacy strategies before handing them to a custom adapter', async () => {
 let calls = 0;
 const adapter = {id:'custom',decisionPolicy,domainDependencies,async episode(){calls++;return episode(1);}};
 for (const field of ['candidate', 'baseline']) {
  await assert.rejects(evaluateCandidate({candidate,baseline,protocol,adapter,model,dependencies,baseReleaseDigest:'base',stage:'final',[field]:{...(field === 'candidate' ? candidate : baseline),schemaVersion:'1.0'}}), {code:'VERSION_INCOMPATIBLE'});
 }
 assert.equal(calls,0);
});

test('evaluation latency names describe decision computation and reject the old ambiguous gate', async () => {
 const report = await evaluate({id:'compute-only',episode:async({strategy})=>episode(strategy.version==='2'?1:0)});
 assert.equal(report.p95DecisionComputeMs,2);
 assert.equal(Object.hasOwn(report,'p95LatencyMs'),false);
 assert.throws(()=>validateProtocol({...protocol,version:'2.0'}),{code:'CONFIG_INVALID'});
 assert.throws(()=>validateProtocol({...protocol,maxP95LatencyMs:100}),{code:'CONFIG_INVALID'});
});
test('matching model names do not authorize a different adapter behavior or model kind in evaluation', async () => {
 let called=false;
 const adapter={id:'identity',decisionPolicy,domainDependencies,async episode(){called=true;return episode(1);}};
 for(const changed of [{...model,kind:'real'},{...model,behaviorIdentity:{...model.behaviorIdentity,adapterVersion:'changed'}}]) {
  await assert.rejects(evaluateCandidate({candidate,baseline,protocol,adapter,model:changed,dependencies,baseReleaseDigest:'base',stage:'final'}),{code:'VERSION_INCOMPATIBLE'});
 }
 assert.equal(called,false);
});
