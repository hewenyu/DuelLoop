import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore, ResearchWorker, ResearchOrchestrator, DuelLoop, FixtureDecisionModel, KuhnPokerDomain, KuhnEvaluationAdapter, createKuhnStrategy } from '../dist/index.js';

const protocol=(id,seeds)=>({version:'3.0',id,domainId:'kuhn-poker',seeds,opponentIds:['calling'],trajectoriesPerSeed:2,knowledgeStateMode:'frozen',initialKnowledge:{},metric:{name:'reward',direction:'maximize',unit:'chips'},minSamples:2,minimumImprovement:.01,maxGroupRegression:1,confidenceLevel:.95,maxP95DecisionComputeMs:5000,maxDevelopmentEvalRuns:1,maxFinalEvaluationsPerRun:1,holdoutId:id,maxHoldoutUses:1});
test('automatic trigger counts settled trajectories, persists cutoff, and does not repeat the same batch',async()=>{
  const store=new SqliteStore();const domain=new KuhnPokerDomain({applicationId:'a',scopeId:'scope'});
  const model=new FixtureDecisionModel('f',q=>({score:0,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,i===0?1:0]))}));
  const runtime=new DuelLoop({applicationId:'a',domain,model,store});runtime.bootstrap(createKuhnStrategy(),'scope');let calls=0;
  const provider={id:'fixture-research',kind:'fixture',run:async()=>{calls++;return {output:{status:'no_change'},usage:{inputTokens:0,outputTokens:0,unknown:false}};}};
  const orchestrator=new ResearchOrchestrator({store,domain,model,evaluator:new KuhnEvaluationAdapter(),dependencies:runtime.dependencies,providers:{researcher:provider}});
  const worker=new ResearchWorker({store,orchestrator,scopeId:'scope',protocol:protocol('final',[5,6]),developmentProtocol:protocol('dev',[1,2]),settledTrajectories:2,cooldownMs:0});
  const now=Date.now();
  const feedback=(id,settled)=>({feedbackId:id,revision:1,eventTime:now,receivedAt:now,applicationId:'a',strategyScopeId:'scope',trajectoryId:id,metrics:{reward:1},settled});
  store.recordFeedback(feedback('one',true));store.recordFeedback(feedback('two',false));assert.equal(await worker.tick(),null);
  store.recordFeedback({...feedback('two',true),revision:2});assert.equal((await worker.tick()).run.status,'no_change');assert.equal(calls,1);
  const restored=new ResearchWorker({store,orchestrator,scopeId:'scope',protocol:protocol('final',[5,6]),developmentProtocol:protocol('dev',[1,2]),settledTrajectories:2,cooldownMs:0});
  assert.equal(await restored.tick(),null);assert.equal(calls,1);await runtime.close();store.close();
});

test('trigger consumes exact feedback revisions, including new arrivals sharing the previous timestamp',async()=>{
  const store=new SqliteStore();const domain=new KuhnPokerDomain({applicationId:'a',scopeId:'scope'});
  const model=new FixtureDecisionModel('f',()=>({score:0,confidence:1}));const runtime=new DuelLoop({applicationId:'a',domain,model,store});runtime.bootstrap(createKuhnStrategy(),'scope');
  let calls=0;const provider={id:'research',kind:'fixture',run:async()=>{calls++;return {output:{status:'no_change'},usage:{inputTokens:0,outputTokens:0,unknown:false}};}};
  const orchestrator=new ResearchOrchestrator({store,domain,model,evaluator:new KuhnEvaluationAdapter(),dependencies:runtime.dependencies,providers:{researcher:provider}});
  const makeWorker=()=>new ResearchWorker({store,orchestrator,scopeId:'scope',protocol:protocol('final',[5,6]),developmentProtocol:protocol('dev',[1,2]),settledTrajectories:1,cooldownMs:0});
  const now=Date.now()-100;const feedback=id=>({feedbackId:id,revision:1,eventTime:now,receivedAt:now,applicationId:'a',strategyScopeId:'scope',trajectoryId:id,metrics:{reward:1},settled:true});
  const worker=makeWorker();
  for(let i=0;i<3;i++)assert.equal(await worker.tick(),null);
  assert.equal(store.listArtifacts('snapshot').length,0,'Idle polling should not accumulate snapshots');
  store.recordFeedback(feedback('one'));assert.equal((await worker.tick()).run.status,'no_change');
  store.recordFeedback(feedback('two'));assert.equal((await makeWorker().tick()).run.status,'no_change','A new event at the same timestamp must count');
  assert.equal(calls,2);assert.equal(await worker.tick(),null,'A consumed revision must not retrigger');
  store.recordFeedback({...feedback('two'),revision:2,metrics:{reward:-1}});
  assert.equal((await worker.tick()).run.status,'no_change','A newly corrected settled revision is new evidence');assert.equal(calls,3);
  const count=store.listArtifacts('snapshot').length;assert.equal(await worker.tick(),null);assert.equal(store.listArtifacts('snapshot').length,count);
  await runtime.close();store.close();
});

function fixtureWorker(options={}) {
 const store=new SqliteStore(),domain=new KuhnPokerDomain({applicationId:'a',scopeId:'scope'});
 const model=new FixtureDecisionModel('worker-fixture',()=>({score:0,confidence:1}));
 const runtime=new DuelLoop({applicationId:'a',domain,model,store});runtime.bootstrap(createKuhnStrategy(),'scope');
 let calls=0;const provider={id:'worker-research-fixture',kind:'fixture',run:async()=>{calls++;return {output:{status:'no_change'},usage:{inputTokens:0,outputTokens:0,unknown:false}};}};
 const orchestrator=new ResearchOrchestrator({store,domain,model,evaluator:new KuhnEvaluationAdapter(),dependencies:runtime.dependencies,providers:{researcher:provider}});
 const final=protocol('final',[5,6]),development=protocol('development',[1,2]);
 const worker=new ResearchWorker({store,orchestrator,scopeId:'scope',protocol:final,developmentProtocol:development,settledTrajectories:1,cooldownMs:0,...options});
 const feedback=(id,receivedAt=Date.now())=>store.recordFeedback({feedbackId:id,revision:1,eventTime:receivedAt,receivedAt,applicationId:'a',strategyScopeId:'scope',trajectoryId:id,metrics:{reward:1},settled:true});
 return {store,runtime,orchestrator,worker,final,development,feedback,calls:()=>calls};
}
function spendHoldout(f) {
 const run=f.orchestrator.create({scopeId:'scope',protocol:f.final});
 for(const [from,to] of [['created','researching'],['researching','candidate_locked'],['candidate_locked','final_evaluating']])f.store.transitionRun(run.id,[from],to);
 f.store.claimHoldout(f.final.holdoutId,run.id,f.final.maxHoldoutUses);
 f.store.transitionRun(run.id,['final_evaluating'],'completed_failed');
}

test('exhausted evaluation resource waits before research and preserves feedback for an independent new protocol',async()=>{
 const f=fixtureWorker();spendHoldout(f);f.feedback('still-unconsumed');
 const snapshots=f.store.listArtifacts('snapshot').length,runs=f.store.listRuns('scope').length;
 for(let i=0;i<3;i++)assert.equal(await f.worker.tick(),null);
 assert.equal(f.worker.status().state,'waiting_protocol');assert.equal(f.calls(),0);
 assert.equal(f.store.listRuns('scope').length,runs);assert.equal(f.store.listArtifacts('snapshot').length,snapshots);
 assert.equal(f.store.latestEvent('scope','research.triggered'),undefined);
 assert.equal(f.store.events({scopeId:'scope',types:['research.worker_state'],allowPrivate:true}).length,1,'Repeated waits do not accumulate status events');
 assert.throws(()=>f.worker.updateProtocols({protocol:{...f.final,maxHoldoutUses:2},developmentProtocol:f.development}),e=>e.code==='HOLDOUT_UNAVAILABLE');
 assert.throws(()=>f.worker.updateProtocols({protocol:{...f.final,id:'renamed',holdoutId:'renamed'},developmentProtocol:f.development}),e=>e.code==='HOLDOUT_UNAVAILABLE');
 f.worker.updateProtocols({protocol:protocol('independent-next',[9,10]),developmentProtocol:f.development});
 assert.equal((await f.worker.tick()).run.status,'no_change');assert.equal(f.calls(),1);
 assert.equal(await f.worker.tick(),null,'Same feedback must not fund another research run');
 await f.runtime.close();f.store.close();
});

test('idle trigger polling uses scoped projections instead of loading event/run/snapshot history',async()=>{
 const f=fixtureWorker();f.feedback('one');assert.equal((await f.worker.tick()).run.status,'no_change');
 const readEvents=f.store.events.bind(f.store);let projectionReads=0;
 f.store.events=options=>{assert.equal(options.scopeId,'scope');assert.deepEqual(options.types,['research.triggered']);assert.equal(options.limit,1);assert.equal(options.descending,true);projectionReads++;return readEvents(options);};
 f.store.listRuns=()=>{throw Error('Unexpected run history scan');};
 f.store.getArtifact=()=>{throw Error('Unexpected old snapshot load');};
 f.store.latestFeedback=()=>{throw Error('Unexpected materialization of feedback history');};
 for(let i=0;i<3;i++)assert.equal(await f.worker.tick(),null);
 assert.equal(projectionReads,3,'The cursor query must remain scoped and bounded');
 assert.equal(f.calls(),1);await f.runtime.close();f.store.close();
});

test('committed feedback cursor survives repeated and future host timestamps',async()=>{
 const f=fixtureWorker(),future=Date.now()+60000;
 f.feedback('future',future);assert.equal((await f.worker.tick()).run.status,'no_change');
 const triggered=f.store.latestEvent('scope','research.triggered');assert.ok(triggered.data.feedbackEventId>0);
 assert.equal(f.store.getArtifact(f.store.getRun(triggered.data.runId).researchSnapshotId).feedback[0].feedbackId,'future');
 f.feedback('same-time',future);assert.equal((await f.worker.tick()).run.status,'no_change');
 assert.equal(await f.worker.tick(),null);assert.equal(f.calls(),2);await f.runtime.close();f.store.close();
});

test('deferred release notification leaves worker alive without repeating the consumed research batch',async()=>{
 const {DuelLoopError}=await import('../dist/index.js');let notifications=0;
 const f=fixtureWorker({onRelease:async()=>{notifications++;throw new DuelLoopError('ACTIVATION_DEFERRED','Waiting for domain boundary',{reason:'scope_boundary'});}});
 // This unit fixture injects a registered-release notification after real worker scheduling.
 // Runtime activation and boundary retry are exercised separately by runtime tests.
 const original=f.orchestrator.run.bind(f.orchestrator);
 f.orchestrator.run=async id=>({...await original(id),releaseDigest:'notification-fixture'});
 f.feedback('one');assert.equal((await f.worker.tick()).releaseDigest,'notification-fixture');
 assert.equal(f.worker.status().state,'idle');assert.equal(notifications,1);
 assert.equal(f.store.latestEvent('scope','research.release_notification').data.state,'deferred');
 assert.equal(await f.worker.tick(),null);assert.equal(notifications,1);assert.equal(f.calls(),1);
 f.feedback('two');assert.equal((await f.worker.tick()).run.status,'no_change');assert.equal(f.calls(),2);
 await f.runtime.close();f.store.close();
});

test('release notification persistence failures surface as errors, not normal deferral',async()=>{
 const {DuelLoopError}=await import('../dist/index.js');
 const f=fixtureWorker({onRelease:async()=>{throw new DuelLoopError('STORAGE_FAILURE','Cannot persist activation');}});
 const original=f.orchestrator.run.bind(f.orchestrator);
 f.orchestrator.run=async id=>({...await original(id),releaseDigest:'notification-fixture'});
 f.feedback('one');await assert.rejects(f.worker.tick(),e=>e.code==='STORAGE_FAILURE');
 assert.equal(f.worker.status().state,'error');assert.equal(f.store.latestEvent('scope','research.release_notification').data.state,'error');
 assert.equal(await f.worker.tick(),null);assert.equal(f.calls(),1);
 await f.runtime.close();f.store.close();
});

test('worker rolling snapshot window caps model evidence and consumes the observed batch once',async()=>{
 const f=fixtureWorker({snapshotOptions:{maxDecisions:1,maxFeedback:2}});
 const now=Date.now()-100;
 for(let i=0;i<4;i++)f.feedback(`evidence-${i}`,now+i);
 const result=await f.worker.tick(),snapshot=f.store.getArtifact(result.run.researchSnapshotId);
 assert.deepEqual(snapshot.feedback.map(item=>item.feedbackId),['evidence-2','evidence-3']);
 assert.equal(snapshot.window.maxDecisions,1);assert.equal(snapshot.window.maxFeedback,2);
 assert.equal(f.store.latestEvent('scope','research.triggered').data.settledTrajectories,4);
 assert.equal(await f.worker.tick(),null,'Old evidence outside the rolling window is not replayed');
 assert.equal(f.calls(),1);await f.runtime.close();f.store.close();
});

test('invalid release notification is recorded separately and does not stop research scheduling',async()=>{
 const {DuelLoopError}=await import('../dist/index.js');
 const f=fixtureWorker({onRelease:async()=>{throw new DuelLoopError('VERSION_INCOMPATIBLE','Model behavior changed');}});
 const original=f.orchestrator.run.bind(f.orchestrator);
 f.orchestrator.run=async id=>({...await original(id),releaseDigest:'notification-fixture'});
 f.feedback('one');assert.equal((await f.worker.tick()).run.status,'no_change');
 assert.equal(f.worker.status().state,'idle');
 assert.equal(f.store.latestEvent('scope','research.release_notification').data.state,'invalid');
 assert.equal(f.store.latestEvent('scope','release.invalid').data.reason,'VERSION_INCOMPATIBLE');
 assert.equal(await f.worker.tick(),null);assert.equal(f.calls(),1);
 await f.runtime.close();f.store.close();
});

test('stopping during research completion retains stopped worker state',async()=>{
 const f=fixtureWorker(),original=f.orchestrator.run.bind(f.orchestrator);
 f.orchestrator.run=async id=>{const result=await original(id);f.worker.stop();return result;};
 f.feedback('one');assert.equal((await f.worker.tick()).run.status,'no_change');
 assert.equal(f.worker.status().state,'stopped');assert.equal(await f.worker.tick(),null);
 await f.runtime.close();f.store.close();
});


test('first-settlement trigger ignores old corrections, retains them in next research snapshot and persists mode',async()=>{
 const f=fixtureWorker({feedbackTriggerMode:'first_settlement'});
 f.feedback('one');assert.equal((await f.worker.tick()).run.status,'no_change');assert.equal(f.calls(),1);
 const first=f.store.latestFeedback('scope')[0].feedback;
 f.store.recordFeedback({...first,revision:2,metrics:{reward:-5}});
 assert.equal(await f.worker.tick(),null);assert.equal(f.calls(),1);
 f.feedback('two');const result=await f.worker.tick();assert.equal(result.run.status,'no_change');assert.equal(f.calls(),2);
 const snapshot=f.store.getArtifact(result.run.researchSnapshotId,{allowPrivate:true});
 assert.equal(snapshot.feedback.find(item=>item.feedbackId==='one').metrics.reward,-5);
 assert.equal(f.store.latestEvent('scope','research.triggered').data.feedbackTriggerMode,'first_settlement');
 const restored=new ResearchWorker({store:f.store,orchestrator:f.orchestrator,scopeId:'scope',protocol:f.final,developmentProtocol:f.development,settledTrajectories:1,cooldownMs:0,feedbackTriggerMode:'first_settlement'});
 f.store.recordFeedback({...first,revision:3,metrics:{reward:-6}});assert.equal(await restored.tick(),null);assert.equal(f.calls(),2);
 await f.runtime.close();f.store.close();
});
