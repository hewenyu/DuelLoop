import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuelLoop, SqliteStore, KuhnPokerDomain, FixtureDecisionModel, createKuhnStrategy, digest } from '../dist/index.js';

const fixture=()=>new FixtureDecisionModel('live-contract-fixture',q=>({score:0,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,i===0?1:0]))}));
function setup(options={}) {
  const store=options.store??new SqliteStore(),domain=new KuhnPokerDomain({applicationId:'test',scopeId:'scope'}),model=options.model??fixture();
  const runtime=new DuelLoop({applicationId:'test',domain,model,store,executionOwner:'host',...options});
  if(!store.activeRelease('scope'))runtime.bootstrap(createKuhnStrategy(),'scope');
  return {store,domain,model,runtime};
}
async function close(x){await x.runtime.close();x.store.close();}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('per-call cancellation isolates streams, preserves stopped artifact and records late usage',async()=>{
  const inner=fixture(),entered=deferred(),late=deferred();let calls=0;
  const model={...inner,id:inner.id,kind:inner.kind,behaviorIdentity:inner.behaviorIdentity,score:async request=>{
    calls++;if(calls===1){entered.resolve();await late.promise;}
    return {...await inner.score(request),usage:{inputTokens:5,outputTokens:2,costUsd:.01}};
  }};
  const x=setup({model});const controller=new AbortController();
  const first=await x.domain.observe('one'),second=await x.domain.observe('two');
  const cancelled=x.runtime.decide(first,undefined,{signal:controller.signal});
  await entered.promise;const continuing=x.runtime.decide(second);controller.abort();
  await assert.rejects(cancelled,{code:'CANCELLED'});
  const stopped=x.store.latestEvent('scope','decision').data;
  assert.equal(stopped.action,null);assert.equal(stopped.stopReason,'CANCELLED');
  assert.equal(x.runtime.status().stopping,false);assert.equal(x.runtime.status().failure,undefined);
  const successful=await continuing;assert.equal(successful.decisionSource,'strategy');
  late.resolve();await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(x.store.getArtifact(digest(stopped)),stopped);
  assert.equal(x.store.events({types:['decision.cancelled']}).length,1);
  assert.equal(x.store.events({types:['decision.late_model_result']}).length,1);
  assert.equal(x.store.intents().length,0);await close(x);
});

test('pre-aborted call makes no provider request and does not stop another call',async()=>{
 const x=setup();const original=x.model.score.bind(x.model);let calls=0;x.model.score=async input=>{calls++;return original(input);};
 const observation=await x.domain.observe('a');const controller=new AbortController();controller.abort();
 await assert.rejects(x.runtime.decide(observation,undefined,{signal:controller.signal}),{code:'CANCELLED'});
 assert.equal(calls,0);assert.equal(x.runtime.status().stopping,false);
 await x.runtime.decide(observation);assert.equal(calls,1);await close(x);
});

test('per-call abort propagates to provider signal and prevents its next retry',async()=>{
 const entered=deferred();let attempts=0;let receivedSignal;
 const inner=fixture(),model={id:inner.id,kind:inner.kind,behaviorIdentity:inner.behaviorIdentity,score:async({signal})=>{
  receivedSignal=signal;attempts++;entered.resolve();
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  if(signal.aborted)throw signal.reason;
  attempts++;throw new Error('must not retry');
 }};
 const x=setup({model}),controller=new AbortController();
 const pending=x.runtime.decide(await x.domain.observe('a'),undefined,{signal:controller.signal});
 await entered.promise;controller.abort();await assert.rejects(pending,{code:'CANCELLED'});
 assert.equal(receivedSignal.aborted,true);assert.equal(attempts,1);assert.equal(x.runtime.status().stopping,false);await close(x);
});

test('explicit model deadline expires without shortening authority and remains fatal',async()=>{
 const entered=deferred(),inner=fixture();const model={id:inner.id,kind:inner.kind,behaviorIdentity:inner.behaviorIdentity,score:async({signal})=>{
  entered.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw signal.reason;
 }};
 const x=setup({model});const observation=await x.domain.observe('a');observation.deadline=Date.now()+5000;
 const modelDeadline=Date.now()+100;const pending=x.runtime.decide(observation,undefined,{modelDeadline});await entered.promise;
 await assert.rejects(pending,{code:'MODEL_TIMEOUT'});
 const stopped=x.store.latestEvent('scope','decision').data;
 assert.equal(stopped.observation.deadline,observation.deadline);assert.equal(stopped.modelDeadline,modelDeadline);
 assert.equal(x.runtime.status().stopping,true);assert.equal(x.store.intents().length,0);await close(x);
});

test('host receipt stable event delivery is persistent and cannot downgrade completion',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'duelloop-receipt-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'store.sqlite');const x=setup({store:new SqliteStore(path)});
 const decision=await x.runtime.decide(await x.domain.observe('a'));await x.runtime.prepareHostExecution(decision);
 const accepted={decisionId:decision.decisionId,idempotencyKey:decision.decisionId,eventId:'ack-1',status:'accepted',timestamp:1};
 x.runtime.recordHostReceipt(decision,accepted);x.runtime.recordHostReceipt(decision,accepted);
 assert.equal(x.store.events({types:['execution.receipt']}).length,1);assert.equal(x.store.events({types:['host.execution.receipt']}).length,1);
 const completed={...accepted,eventId:'settled-1',status:'completed',timestamp:2};x.runtime.recordHostReceipt(decision,completed);
 await close(x);const store=new SqliteStore(path);
 assert.equal(store.recordReceipt(accepted),false);assert.equal(store.intent(decision.decisionId).receipt.status,'completed');
 assert.equal(store.recordReceipt(completed),false);
 assert.throws(()=>store.recordReceipt({...accepted,timestamp:3}),{code:'CONFLICT'});
 assert.throws(()=>store.recordReceipt({...completed,eventId:'contradiction',status:'rejected'}),{code:'CONFLICT'});
 assert.equal(store.events({types:['execution.receipt']}).length,2);assert.equal(store.unresolvedIntents().length,0);store.close();
});

test('first-settlement cursor survives revisions and schema-2 migration',t=>{
 const dir=mkdtempSync(join(tmpdir(),'duelloop-settlement-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'store.sqlite');
 let store=new SqliteStore(path);
 const f=(id,revision,settled=true)=>({feedbackId:id,revision,eventTime:1,receivedAt:revision,applicationId:'test',strategyScopeId:'scope',trajectoryId:id,metrics:{reward:revision},settled});
 store.recordFeedback(f('one',1));const first=store.feedbackProgress('scope',0,'first_settlement');
 store.recordFeedback(f('one',2));store.recordFeedback(f('two',1,false));
 assert.equal(store.feedbackProgress('scope',first.eventId,'first_settlement').settledTrajectories,0);
 store.close();const old=new DatabaseSync(path);old.exec('DROP TABLE receipt_events; DROP TABLE first_settlements; PRAGMA user_version=2;');old.close();
 store=new SqliteStore(path);assert.deepEqual(store.feedbackProgress('scope',0,'first_settlement'),first);
 store.recordFeedback(f('two',2));const next=store.feedbackProgress('scope',first.eventId,'first_settlement');assert.equal(next.settledTrajectories,1);
 store.recordFeedback({...f('two-alias',1),trajectoryId:'two'});assert.equal(store.feedbackProgress('scope',next.eventId,'first_settlement').settledTrajectories,0);
 store.recordFeedback(f('one',3));assert.equal(store.feedbackProgress('scope',next.eventId,'first_settlement').settledTrajectories,0);
 const snapshot=store.getArtifact(store.snapshot('scope',Date.now()));assert.equal(snapshot.feedback.find(f=>f.feedbackId==='one').revision,3);
 assert.equal(store.feedbackProgress('scope',first.eventId).settledTrajectories,2);store.close();
});

test('early trajectory pins survive activation and process-like reopen',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'duelloop-pin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'store.sqlite');
 let x=setup({store:new SqliteStore(path)});const observation=await x.domain.observe('a');
 assert.equal(x.runtime.lookupTrajectoryRelease(observation),undefined);
 const candidates=await x.domain.candidates(observation);const first=x.runtime.pinTrajectory(observation);const strategy=createKuhnStrategy();strategy.version='next';
 const strategyDigest=x.store.putArtifact('strategy',strategy);
 const run=x.store.createRun({id:'verified-next',scopeId:'scope',baseReleaseDigest:first,researchSnapshotId:x.store.snapshot('scope',Date.now()),evaluationProtocolDigest:x.store.putArtifact('protocol',{id:'p'},'private'),status:'created',data:{}});
 for(const [from,to] of [['created','researching'],['researching','candidate_locked'],['candidate_locked','final_evaluating'],['final_evaluating','completed_passed']])x.store.transitionRun(run.id,[from],to);
 const validationDigest=x.store.putArtifact('validation_report',{candidateDigest:strategyDigest,baseReleaseDigest:first,dependencies:x.runtime.dependencies,status:'passed',stage:'final',modelKind:'fixture'},'private');
 const next=x.store.registerRelease({strategyDigest,dependencies:x.runtime.dependencies,scopeId:'scope',expectedActiveDigest:first,validationDigest,source:'research',researchRunId:run.id});
 await x.runtime.activate(next,true);assert.equal(x.runtime.lookupTrajectoryRelease(observation),first);assert.equal(x.runtime.pinTrajectory(observation),first);
 assert.equal(x.runtime.lookupTrajectoryRelease({...observation,trajectoryId:'next-hand'}),undefined);
 assert.equal(x.runtime.pinTrajectory({...observation,trajectoryId:'next-hand'}),next);
 await close(x);x=setup({store:new SqliteStore(path)});
 assert.equal(x.runtime.pinTrajectory(observation),first);assert.equal((await x.runtime.decide(observation,candidates)).releaseDigest,first);
 await close(x);
});
