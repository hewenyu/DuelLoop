import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore, ResearchWorker, ResearchOrchestrator, DuelLoop, FixtureDecisionModel, KuhnPokerDomain, KuhnEvaluationAdapter, createKuhnStrategy } from '../dist/index.js';

const protocol=(id,seeds)=>({version:'2.0',id,domainId:'kuhn-poker',seeds,opponentIds:['calling'],trajectoriesPerSeed:2,knowledgeStateMode:'frozen',initialKnowledge:{},metric:{name:'reward',direction:'maximize',unit:'chips'},minSamples:2,minimumImprovement:.01,maxGroupRegression:1,confidenceLevel:.95,maxP95LatencyMs:5000,maxDevelopmentEvalRuns:1,maxFinalEvaluationsPerRun:1,holdoutId:id,maxHoldoutUses:1});
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
