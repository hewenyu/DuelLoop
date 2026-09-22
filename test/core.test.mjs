import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteStore, DuelLoop, FixtureDecisionModel, KuhnPokerDomain, createKuhnStrategy,
  validateStrategy, evaluateAnswers, buildQuestions, matchCondition, seededRandom,
  behaviorDependencies, digest, DuelLoopError,
} from '../dist/index.js';

function fixture(id='fixture-core') {
  return new FixtureDecisionModel(id, q=>({score:q.actionId==='bet'?4:1,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,i===(q.actionId==='bet'?4:1)?1:0]))}));
}
function setup(options={}) {
  const domain=new KuhnPokerDomain({applicationId:'test',scopeId:'scope',seed:4});
  const model=fixture(); const store=new SqliteStore(options.path??':memory:');
  const runtime=new DuelLoop({applicationId:'test',domain,model,store,mode:'offline',executionOwner:'framework',...options});
  runtime.bootstrap(createKuhnStrategy(),'scope');return {domain,model,store,runtime};
}
test('rejected model answers retain known usage on the executed fallback decision',async()=>{
 const measured={inputTokens:71,outputTokens:13,unknown:false};
 const model={id:'rejected-answer',kind:'fixture',score:async()=>{throw new DuelLoopError('MODEL_INVALID','Bad answer',{usage:measured});}};
 const x=setup({model});
 try {
  const {decision,receipt}=await x.runtime.step('usage-fallback');
  assert.equal(decision.decisionSource,'domain_baseline');assert.equal(receipt.status,'completed');assert.deepEqual(decision.usage,measured);
  assert.deepEqual(x.store.getArtifact(digest(decision)).usage,measured);
 } finally {await x.runtime.close();x.store.close();}
});
const fakeRun=(store,id='run')=>store.createRun({id,scopeId:'scope',baseReleaseDigest:store.activeRelease('scope'),researchSnapshotId:store.snapshot('scope',Date.now()),evaluationProtocolDigest:store.putArtifact('protocol',{id:'p'},'private'),status:'created',data:{}});
function verifiedRelease(store,domain,model,version='v2') {
  const base=store.activeRelease('scope');const strategy=createKuhnStrategy();strategy.version=version;strategy.parentVersion='v1';
  const strategyDigest=store.putArtifact('strategy',strategy);const run=fakeRun(store,`run-${version}`);
  store.transitionRun(run.id,['created'],'researching');store.transitionRun(run.id,['researching'],'candidate_locked');store.transitionRun(run.id,['candidate_locked'],'final_evaluating');store.transitionRun(run.id,['final_evaluating'],'completed_passed');
  const dependencies=behaviorDependencies(domain,model);
  const validationDigest=store.putArtifact('validation_report',{candidateDigest:strategyDigest,baseReleaseDigest:base,dependencies,status:'passed',stage:'final',modelKind:'fixture'},'private');
  return {validationDigest,release:store.registerRelease({strategyDigest,dependencies,scopeId:'scope',expectedActiveDigest:base,validationDigest,source:'research',researchRunId:run.id}),dependencies};
}

test('strategy validates unknown fields, contracts, score limits and full dimension coverage',()=>{
  const domain=new KuhnPokerDomain();const s=createKuhnStrategy();
  assert.equal(validateStrategy(s,domain).schemaVersion,'1.0');
  for(const change of [s=>s.execute='rm -rf',s=>s.questions[0].criteria=Array(11).fill('x'),s=>s.stateProjection.push('opponent.hiddenCard'),s=>delete s.decision.defaultWeights.gain,s=>s.decision.selection={mode:'softmax_sample',tieBreak:'domain_priority',temperature:0}]){
    const x=structuredClone(s);change(x);assert.throws(()=>validateStrategy(x,domain));
  }
});
test('unknown condition stays unknown through negation; explicit false dominates all',()=>{
  const c={feature:'rate',op:'gte',value:.6};assert.equal(matchCondition(c,{}),null);assert.equal(matchCondition({not:c},{}),null);
  assert.equal(matchCondition({all:[c,{feature:'count',op:'gt',value:40}]},{count:0}),false);
});
test('softmax distribution, seeded sampling and arithmetic regression',async()=>{
  const d=new KuhnPokerDomain({applicationId:'test'});const o=await d.observe('a');const a=await d.candidates(o);const s=createKuhnStrategy();
  s.decision.selection={mode:'softmax_sample',tieBreak:'domain_priority',temperature:.5};
  const req=buildQuestions(s,o,a,d);const answers=await fixture().score({...req,signal:new AbortController().signal});
  const one=evaluateAnswers(s,o,a,answers.answers,seededRandom(3));const two=evaluateAnswers(s,o,a,answers.answers,seededRandom(3));assert.deepEqual(one,two);
  assert.ok(Math.abs(Object.values(one.probabilities).reduce((a,b)=>a+b)-1)<1e-12);
  let count=0;const rng=seededRandom('sampling');for(let n=0;n<10000;n++)if(evaluateAnswers(s,o,a,answers.answers,rng).action.id===a[0].id)count++;
  assert.ok(Math.abs(count/10000-one.probabilities[a[0].id])<.025);
  const bad=structuredClone(answers.answers);bad[req.questions[0].id].score=Infinity;assert.throws(()=>evaluateAnswers(s,o,a,bad),{code:'MODEL_INVALID'});
});
test('shadow and host execution never invoke adapter, including forced and fallback paths',async()=>{
  for(const source of ['strategy','forced','fallback']) for(const mode of ['shadow','offline']){
    const d=new KuhnPokerDomain({applicationId:'test',scopeId:'scope'});let calls=0;const execute=d.execute.bind(d);d.execute=async c=>{calls++;return execute(c);};
    if(source==='forced'){const candidates=d.candidates.bind(d);d.candidates=async o=>(await candidates(o)).slice(0,1);}
    const model=source==='fallback'?{id:'broken',kind:'fixture',score:async()=>{throw new Error('down');}}:fixture();
    const store=new SqliteStore();const runtime=new DuelLoop({applicationId:'test',domain:d,model,store,mode,executionOwner:mode==='shadow'?'framework':'host'});
    runtime.bootstrap(createKuhnStrategy(),'scope');const r=await runtime.step('a');assert.equal(calls,0);assert.equal(r.receipt,null);
    assert.equal(r.decision.decisionSource,source==='forced'?'forced_action':source==='fallback'?'domain_baseline':'strategy');
    await runtime.close();store.close();
  }
});
test('framework forced action still requires persisted intent and current state',async()=>{
  const x=setup();const c=x.domain.candidates.bind(x.domain);x.domain.candidates=async o=>(await c(o)).slice(0,1);
  let calls=0;x.domain.execute=async()=>{calls++;throw new Error();};x.store.saveIntent=()=>{throw new Error('disk full');};
  await assert.rejects(()=>x.runtime.step('a'),/disk full/);assert.equal(calls,0);await x.runtime.close();x.store.close();
});
test('decision stale before execution is not submitted',async()=>{
  const x=setup();const o=await x.domain.observe('a');const d=await x.runtime.decide(o);
  await x.domain.execute({decisionId:'external',idempotencyKey:'external',expectedStateRevision:o.revision,observation:o,action:d.action,deadline:o.deadline});
  await assert.rejects(()=>x.runtime.executeDecision(d),{code:'STATE_STALE'});assert.equal(x.store.intents().length,0);await x.runtime.close();x.store.close();
});
test('unknown execution blocks new submits and is reconciled instead of blindly retried',async()=>{
  const x=setup();const execute=x.domain.execute.bind(x.domain);let calls=0;
  x.domain.execute=async command=>{calls++;await execute(command);throw new Error('connection lost after acceptance');};
  const r=await x.runtime.step('a');assert.equal(r.receipt.status,'unknown');
  await assert.rejects(()=>x.runtime.step('a'),{code:'EXECUTION_UNKNOWN'});assert.equal(calls,1);
  const receipts=await x.runtime.reconcile('scope');assert.equal(receipts[0].status,'completed');await x.runtime.close();x.store.close();
});
test('trajectory bindings survive default switch, rollback and process-style store reopen',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'duelloop-bind-'));const path=join(dir,'state.sqlite');const x=setup({path});
  const v1=x.store.trajectoryRelease('scope','a','self','hand-a');const v2=verifiedRelease(x.store,x.domain,x.model);
  await x.runtime.activate(v2.release);assert.equal(x.store.trajectoryRelease('scope','a','self','hand-a'),v1);
  assert.equal(x.store.trajectoryRelease('scope','b','self','hand-b'),v2.release);
  x.store.rollback('scope',v1,x.runtime.dependencies);assert.equal(x.store.trajectoryRelease('scope','b','self','hand-b'),v2.release);
  await x.runtime.close();x.store.close();const reopened=new SqliteStore(path);assert.equal(reopened.trajectoryRelease('scope','b','self','hand-b'),v2.release);reopened.close();rmSync(dir,{recursive:true});
});
test('cancel and completion have durable ordering; late callback cannot revive a run',async()=>{
  const x=setup();const run=fakeRun(x.store);x.store.transitionRun(run.id,['created'],'researching');x.store.cancelRun(run.id);
  assert.throws(()=>x.store.transitionRun(run.id,['researching'],'candidate_locked'),{code:'CONFLICT'});
  assert.throws(()=>x.store.consumeBudget(run.id,'model',10),{code:'CANCELLED'});x.store.transitionRun(run.id,['cancel_requested'],'cancelled');assert.equal(x.store.cancelRun(run.id).status,'cancelled');
  await x.runtime.close();x.store.close();
});
test('activation checks current eligibility, mode, dependencies and evaluated baseline',async()=>{
  const x=setup();const a=verifiedRelease(x.store,x.domain,x.model);x.store.invalidateValidation(a.validationDigest,'feedback corrected');
  await assert.rejects(()=>x.runtime.activate(a.release),{code:'VALIDATION_REJECTED'});
  const b=verifiedRelease(x.store,x.domain,x.model,'v3');x.store.pauseActivation('scope',true);await assert.rejects(()=>x.runtime.activate(b.release),{code:'CONFLICT'});
  x.store.pauseActivation('scope',false);x.store.setActivationMode('scope','explicit');await assert.rejects(()=>x.runtime.activate(b.release),{code:'CONFLICT'});await x.runtime.activate(b.release,true);
  assert.throws(()=>x.store.activate(a.release,x.runtime.dependencies,{explicit:true}),{code:'CONFLICT'});
  await x.runtime.close();x.store.close();
});
test('feedback revisions freeze in snapshots, private artifacts stay private, backup restores hashes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'duelloop-backup-'));const x=setup({path:join(dir,'state.sqlite')});const now=Date.now();
  const f={feedbackId:'f',revision:1,eventTime:now-10,receivedAt:now,applicationId:'test',strategyScopeId:'scope',trajectoryId:'t',metrics:{reward:1},settled:true};x.store.recordFeedback(f);
  const old=x.store.snapshot('scope',now);x.store.recordFeedback({...f,revision:2,receivedAt:now+10,metrics:{reward:-2}});
  assert.equal(x.store.getArtifact(old).feedback[0].metrics.reward,1);assert.equal(x.store.getArtifact(x.store.snapshot('scope',now+20)).feedback[0].metrics.reward,-2);
  assert.throws(()=>x.store.recordFeedback({...f,metrics:{reward:3}}),{code:'CONFLICT'});
  const secret=x.store.putArtifact('holdout',{seed:99},'private');assert.throws(()=>x.store.getArtifact(secret),{code:'ACCESS_DENIED'});
  await x.store.backup(join(dir,'backup.sqlite'));const restored=SqliteStore.restore(join(dir,'backup.sqlite'),join(dir,'restored.sqlite'));
  assert.equal(restored.activeRelease('scope'),x.store.activeRelease('scope'));assert.equal(restored.integrity().ok,true);restored.close();await x.runtime.close();x.store.close();rmSync(dir,{recursive:true});
});
test('a second runtime cannot own the same stream',async()=>{
  const x=setup();const one=x.store.acquireOwner('scope','table','one');assert.throws(()=>x.store.acquireOwner('scope','table','two'),{code:'CONFLICT'});
  x.store.releaseOwner('scope','table',one);assert.notEqual(x.store.acquireOwner('scope','table','two'),one);await x.runtime.close();x.store.close();
});
test('host explicitly prepares intent, executes itself, and reports receipt; runtime does not execute',async()=>{
  const x=setup({executionOwner:'host'});let calls=0;const execute=x.domain.execute.bind(x.domain);x.domain.execute=async c=>{calls++;return execute(c);};
  const {decision}=await x.runtime.step('host');assert.equal(calls,0);
  const command=await x.runtime.prepareHostExecution(decision);assert.equal(calls,0);assert.equal(x.store.intents().length,1);
  const receipt=await x.domain.execute(command);x.runtime.recordHostReceipt(decision,receipt);assert.equal(calls,1);assert.equal(x.store.intents()[0].receipt.status,'completed');
  await assert.rejects(()=>x.runtime.executeDecision(decision),{code:'ACCESS_DENIED'});await x.runtime.close();x.store.close();
});
test('a scope cannot be taken over by another application; invalidated active release stops decisions',async()=>{
  const x=setup();assert.throws(()=>x.store.bindScope('scope','another-app'),{code:'ACCESS_DENIED'});
  const next=verifiedRelease(x.store,x.domain,x.model);await x.runtime.activate(next.release);x.store.invalidateValidation(next.validationDigest,'corrected observations');
  await assert.rejects(()=>x.runtime.step('a'),{code:'VALIDATION_REJECTED'});assert.equal(x.store.intents().length,0);await x.runtime.close();x.store.close();
});
test('garbage collection preserves artifacts reachable from runs and releases',async()=>{
  const x=setup();const orphan=x.store.putArtifact('snapshot',{orphan:true});const run=fakeRun(x.store);
  const dry=x.store.pruneUnreferencedArtifacts();assert.ok(dry.digests.includes(orphan));assert.ok(!dry.digests.includes(run.researchSnapshotId));
  x.store.pruneUnreferencedArtifacts({dryRun:false});assert.throws(()=>x.store.getArtifact(orphan),{code:'NOT_FOUND'});assert.ok(x.store.getArtifact(run.researchSnapshotId));
  await x.runtime.close();x.store.close();
});

test('rollback persists and never automatically reactivates a previously used candidate',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'duelloop-rollback-'));const path=join(dir,'state.sqlite');const x=setup({path});
  const base=x.store.activeRelease('scope');const next=verifiedRelease(x.store,x.domain,x.model);
  await x.runtime.activate(next.release);x.store.rollback('scope',base,x.runtime.dependencies);
  assert.equal(await x.runtime.activatePending('scope'),null);
  await x.runtime.close();x.store.close();
  const store=new SqliteStore(path);const app=new DuelLoop({applicationId:'test',domain:x.domain,model:x.model,store});
  assert.equal(await app.activatePending('scope'),null);assert.equal(store.activeRelease('scope'),base);
  await app.activate(next.release,true);assert.equal(store.activeRelease('scope'),next.release);
  await app.close();store.close();rmSync(dir,{recursive:true});
});
test('concurrent framework or host submissions atomically claim exactly one intent',async()=>{
  for(const executionOwner of ['framework','host']){
    const x=setup({executionOwner});let calls=0;const execute=x.domain.execute.bind(x.domain);
    x.domain.execute=async c=>{calls++;return execute(c);};
    const d=await x.runtime.decide(await x.domain.observe('a'));
    const submit=()=>executionOwner==='host'?x.runtime.prepareHostExecution(d):x.runtime.executeDecision(d);
    const results=await Promise.allSettled([submit(),submit()]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='EXECUTION_UNKNOWN').length,1);
    assert.equal(calls,executionOwner==='framework'?1:0);assert.equal(x.store.intents().length,1);
    await x.runtime.close();x.store.close();
  }
});
test('embedded decisions persist the runtime deadline and reject delayed execution',async()=>{
  const x=setup({maxDecisionMs:80,executionReserveMs:5});
  const o=await x.domain.observe('a');const d=await x.runtime.decide({...o,deadline:Date.now()+30000});
  assert.ok(d.observation.deadline<=d.startedAt+80);
  await new Promise(r=>setTimeout(r,Math.max(0,d.observation.deadline-Date.now())+5));
  await assert.rejects(()=>x.runtime.executeDecision(d),{code:'STATE_STALE'});assert.equal(x.store.intents().length,0);
  await x.runtime.close();x.store.close();
});
test('application boundaries cover feedback, activation and reconciliation',async()=>{
  const x=setup();const next=verifiedRelease(x.store,x.domain,x.model);
  const other=new DuelLoop({applicationId:'other',domain:new KuhnPokerDomain({applicationId:'other',scopeId:'scope'}),model:x.model,store:x.store});
  const now=Date.now();
  await assert.rejects(()=>other.submitFeedback({feedbackId:'pollution',revision:1,eventTime:now,receivedAt:now,applicationId:'other',strategyScopeId:'scope',trajectoryId:'t',metrics:{reward:999},settled:true}),{code:'ACCESS_DENIED'});
  assert.equal(x.store.getArtifact(x.store.snapshot('scope',now)).feedback.length,0);
  await assert.rejects(()=>other.activate(next.release),{code:'ACCESS_DENIED'});
  await assert.rejects(()=>other.reconcile('scope'),{code:'ACCESS_DENIED'});
  await other.close();await x.runtime.close();x.store.close();
});
