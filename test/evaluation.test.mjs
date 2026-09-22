import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidate, validateProtocol } from '../dist/evaluation.js';
import { decisionPolicyRuntimeVersion } from '../dist/runtime.js';
const decisionPolicy = { maxDecisionMs: 5000, executionReserveMs: 25 };
const baseline = {scope:{domain:'test'},version:'1'};
const candidate = {scope:{domain:'test'},version:'2'};
const model = {id:'fixture',kind:'fixture',score:async()=>{throw Error('unused');}};
const dependencies = {model:'fixture',runtime:decisionPolicyRuntimeVersion(decisionPolicy),rules:'1',featureBuilder:'1',knowledgeUpdater:'1',fallbackBaseline:'1',continuationPolicy:'1',contextDigest:'test'};
const { model: _model, runtime: _runtime, ...domainDependencies } = dependencies;
const protocol = {version:'1.0',id:'test',domainId:'test',seeds:[1,2,3],opponentIds:['a','b'],trajectoriesPerSeed:10,knowledgeStateMode:'online_update',initialKnowledge:{nested:{count:0}},metric:{name:'reward',direction:'maximize',unit:'points'},minSamples:3,minimumImprovement:0,maxGroupRegression:4,confidenceLevel:.95,maxFallbackRate:.1,maxP95LatencyMs:100,maxDevelopmentEvalRuns:2,maxFinalEvaluationsPerRun:1,holdoutId:'test-holdout',maxHoldoutUses:1};
const episode = reward => ({reward,decisions:10,fallbacks:0,latenciesMs:Array(10).fill(2),modelCalls:0});
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
test('group regression and excessive fallback/latency reject even profitable overall strategy',async()=>{
 const report=await evaluate({id:'fixture',episode:async({strategy,opponentId})=>({...episode(strategy.version==='1'?0:opponentId==='a'?20:-5),fallbacks:2,latenciesMs:Array(10).fill(200)})});
 assert.equal(report.status,'failed');
 assert.ok(report.reasons.includes('opponent_group_regression')); assert.ok(report.reasons.includes('fallback_rate_exceeded')); assert.ok(report.reasons.includes('latency_limit_exceeded'));
});
test('minimize metric reverses paired improvement; incomplete latency rejects',async()=>{
 assert.equal((await evaluate({id:'fixture',episode:async({strategy})=>episode(strategy.version==='1'?5:1)},{metric:{name:'cost',direction:'minimize',unit:'dollars'}})).status,'passed');
 await assert.rejects(evaluate({id:'bad',episode:async()=>({...episode(1),latenciesMs:[]})}),e=>e.code==='VALIDATION_REJECTED');
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
test('built-in evaluator rejects an SDK domain whose baseline or context changed before any model calls', async () => {
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
  domain.baselineVersion = 'unmeasured-baseline-v2';
  await assert.rejects(evaluateCandidate({ ...options, dependencies: app.dependencies }), { code: 'VERSION_INCOMPATIBLE' });
  domain.baselineVersion = '1'; domain.context.rules += ' Changed application rule.';
  await assert.rejects(evaluateCandidate({ ...options, dependencies: app.dependencies }), { code: 'VERSION_INCOMPATIBLE' });
  assert.equal(calls, 0, 'Neither mismatched domain may start an experiment');
  assert(Object.isFrozen(adapter.domainDependencies));
 } finally { await app.close(); store.close(); }
});
