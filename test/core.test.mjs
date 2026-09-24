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
test('rejected model answers retain known usage and stop without issuing execution',async()=>{
 const measured={inputTokens:71,outputTokens:13,unknown:false};
 const recorded={...measured,knownCostUsd:0,costUnknown:true};
 const model={id:'rejected-answer',kind:'fixture',behaviorIdentity:fixture().behaviorIdentity,score:async()=>{throw new DuelLoopError('MODEL_INVALID','Bad answer',{usage:measured});}};
 const x=setup({model});
 try {
  let calls=0;x.domain.execute=async()=>{calls++;throw new Error('must never execute');};
  await assert.rejects(()=>x.runtime.step('usage-stopped'),error=>error.code==='MODEL_INVALID'&&typeof error.context.decisionId==='string');
  const decision=x.store.events().find(event=>event.type==='decision').data;
  assert.equal(decision.decisionSource,'stopped');assert.equal(decision.action,null);assert.deepEqual(decision.usage,recorded);
  assert.deepEqual(x.store.getArtifact(digest(decision)).usage,recorded);
  assert.equal(calls,0);assert.equal(x.store.intents().length,0);assert.equal(x.runtime.status().stopping,true);
  assert.equal(x.runtime.status().failure.decisionId,decision.decisionId);
  await assert.rejects(()=>x.runtime.start({streamIds:['usage-stopped'],maxSteps:1}),{code:'DECISION_STOPPED'});
 } finally {await x.runtime.close();x.store.close();}
});
test('runtime persists partial dollar cost without declaring a complete total',async()=>{
 const inner=fixture();const model={id:inner.id,kind:inner.kind,behaviorIdentity:inner.behaviorIdentity,
  score:async input=>({...await inner.score(input),usage:{inputTokens:7,outputTokens:3,knownCostUsd:0.125,costUnknown:true}})};
 const x=setup({model});
 try {
  const {decision}=await x.runtime.step('partial-cost');
  const expected={inputTokens:7,outputTokens:3,unknown:false,knownCostUsd:0.125,costUnknown:true};
  assert.deepEqual(decision.usage,expected);
  assert.deepEqual(x.store.getArtifact(digest(decision)).usage,expected);
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
  assert.equal(validateStrategy(s,domain).schemaVersion,'2.0');
  for(const change of [s=>s.execute='rm -rf',s=>s.questions[0].criteria=Array(11).fill('x'),s=>s.stateProjection.push('opponent.hiddenCard'),s=>delete s.decision.defaultWeights.gain,s=>s.decision.selection={mode:'softmax_sample',tieBreak:'domain_priority',temperature:0}]){
    const x=structuredClone(s);change(x);assert.throws(()=>validateStrategy(x,domain));
  }
  for(const change of [s=>s.decision.minRequiredConfidence=0,s=>s.fallback={mode:'domain_baseline'},s=>s.exitConditions=[]]){
    const old=structuredClone(s);change(old);assert.throws(()=>validateStrategy(old,domain),{code:'STRATEGY_INVALID'});
  }
  assert.throws(()=>validateStrategy({...s,schemaVersion:'1.0'},domain),{code:'VERSION_INCOMPATIBLE'});
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
test('shadow and host execution call models for single or multiple candidates and never execute',async()=>{
  for(const source of ['multiple','single','failure']) for(const mode of ['shadow','offline']){
    const d=new KuhnPokerDomain({applicationId:'test',scopeId:'scope'});let calls=0;const execute=d.execute.bind(d);d.execute=async c=>{calls++;return execute(c);};
    if(source==='single'){const candidates=d.candidates.bind(d);d.candidates=async o=>(await candidates(o)).slice(0,1);}
    let modelCalls=0;const inner=fixture();
    const model={id:inner.id,kind:'fixture',behaviorIdentity:fixture().behaviorIdentity,score:async request=>{modelCalls++;if(source==='failure')throw new Error('down');return inner.score(request);}};
    const store=new SqliteStore();const runtime=new DuelLoop({applicationId:'test',domain:d,model,store,mode,executionOwner:mode==='shadow'?'framework':'host'});
    runtime.bootstrap(createKuhnStrategy(),'scope');
    if(source==='failure')await assert.rejects(()=>runtime.step('a'),{code:'MODEL_INVALID'});
    else {const r=await runtime.step('a');assert.equal(r.receipt,null);assert.equal(r.decision.decisionSource,'strategy');}
    assert.equal(calls,0);assert.equal(modelCalls,1);assert.equal(store.intents().length,0);
    await runtime.close();store.close();
  }
});
test('framework single-candidate model decision requires persisted intent and current state',async()=>{
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
  const b=verifiedRelease(x.store,x.domain,x.model,'v3');x.store.pauseActivation('scope',true);await assert.rejects(()=>x.runtime.activate(b.release),{code:'ACTIVATION_DEFERRED'});
  x.store.pauseActivation('scope',false);x.store.setActivationMode('scope','explicit');await assert.rejects(()=>x.runtime.activate(b.release),{code:'ACTIVATION_DEFERRED'});await x.runtime.activate(b.release,true);
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

test('confidence zero is recorded and the model-selected action executes',async()=>{
  const inner=fixture();let modelCalls=0;
  const model={id:inner.id,kind:'fixture',behaviorIdentity:fixture().behaviorIdentity,score:async request=>{
    modelCalls++;const result=await inner.score(request);for(const answer of Object.values(result.answers))answer.confidence=0;return result;
  }};
  const x=setup({model});
  try {
    const {decision,receipt}=await x.runtime.step('zero-confidence');
    assert.equal(modelCalls,1);assert.equal(decision.action.id,'bet');assert.equal(decision.decisionSource,'strategy');
    assert.equal(receipt.status,'completed');assert(Object.values(decision.answers).every(answer=>answer.confidence===0));
    assert.equal(x.runtime.status().stopping,false);
  }finally{await x.runtime.close();x.store.close();}
});

test('missing, malformed, unavailable and mismatched model answers stop even with one candidate',async()=>{
  for(const failure of ['missing','invalid','unavailable','wrong-version'])for(const single of [false,true]){
    const inner=fixture();let modelCalls=0,executions=0;
    const model={id:inner.id,kind:'real',behaviorIdentity:fixture().behaviorIdentity,score:async request=>{
      modelCalls++;if(failure==='unavailable')throw new Error('network down');
      const result=await inner.score(request);
      if(failure==='missing')delete result.answers[request.questions[0].id];
      if(failure==='invalid')result.answers[request.questions[0].id].score=NaN;
      if(failure==='wrong-version')result.model='unexpected-model';
      return result;
    }};
    const x=setup({model,mode:'simulation'});
    try {
      if(single){const candidates=x.domain.candidates.bind(x.domain);x.domain.candidates=async o=>(await candidates(o)).slice(0,1);}
      x.domain.execute=async()=>{executions++;throw new Error('must never execute');};
      await assert.rejects(()=>x.runtime.step('failure'),{code:failure==='wrong-version'?'VERSION_INCOMPATIBLE':'MODEL_INVALID'});
      const stopped=x.store.events().find(event=>event.type==='decision').data;
      assert.equal(stopped.decisionSource,'stopped');assert.equal(stopped.action,null);assert.equal(modelCalls,1);
      assert.equal(executions,0);assert.equal(x.store.intents().length,0);
      await assert.rejects(()=>x.runtime.step('failure'),{code:'CANCELLED'});assert.equal(modelCalls,1);
    }finally{await x.runtime.close();x.store.close();}
  }
});

test('model timeout stops the continuous loop and a late answer cannot execute',async()=>{
  let finish;let entered;const called=new Promise(resolve=>{entered=resolve;});let calls=0,executions=0;
  const inner=fixture();
  const usage={inputTokens:9,outputTokens:2,costUsd:0,unknown:false};
  const model={id:inner.id,kind:'fixture',behaviorIdentity:fixture().behaviorIdentity,score:async request=>{calls++;const result={...await inner.score(request),usage};entered();return new Promise(resolve=>{finish=()=>resolve(result);});}};
  const x=setup({model,maxDecisionMs:60,executionReserveMs:5});
  try {
    x.domain.execute=async()=>{executions++;throw new Error('must never execute');};
    const run=x.runtime.start({streamIds:['timeout'],maxSteps:4});
    const rejected=assert.rejects(run,{code:'MODEL_TIMEOUT'});await called;await rejected;
    await finish();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);assert.equal(executions,0);assert.equal(x.store.intents().length,0);
    assert.equal(x.runtime.status().failure.code,'MODEL_TIMEOUT');
    assert.equal(x.store.events().filter(event=>event.type==='decision').length,1);
    const late=x.store.events().find(event=>event.type==='decision.late_model_result').data;
    assert.deepEqual(late.usage,{...usage,knownCostUsd:0,costUnknown:false});assert.equal(late.decisionId,x.runtime.status().failure.decisionId);
    assert.equal(x.store.events().find(event=>event.type==='decision').data.usage.unknown,true);
  }finally{await x.runtime.close();x.store.close();}
});

test('a failed stream prevents another in-flight model answer from being executed',async()=>{
  let finish;let entered;const called=new Promise(resolve=>{entered=resolve;});let executions=0;
  const inner=fixture();let calls=0;
  const model={id:inner.id,kind:'fixture',behaviorIdentity:fixture().behaviorIdentity,score:async request=>{
    if(++calls===1){entered();return new Promise(resolve=>{finish=async()=>resolve(await inner.score(request));});}
    throw new DuelLoopError('MODEL_INVALID','Second stream failed');
  }};
  const x=setup({model});
  try {
    x.domain.execute=async()=>{executions++;throw new Error('must never execute');};
    const first=x.runtime.step('first');const firstRejected=assert.rejects(first,{code:'CANCELLED'});
    await called;await assert.rejects(()=>x.runtime.step('second'),{code:'MODEL_INVALID'});
    await finish();await firstRejected;
    assert.equal(executions,0);assert.equal(x.store.intents().length,0);
    assert.equal(x.store.events().filter(event=>event.type==='decision').length,2);
  }finally{await x.runtime.close();x.store.close();}
});

test('no legal candidate stops without fabricating a wait or default action',async()=>{
  let calls=0;const x=setup({model:{id:'unused',kind:'fixture',behaviorIdentity:fixture().behaviorIdentity,score:async()=>{calls++;throw new Error('no questions');}}});
  try {
    x.domain.candidates=async()=>[];
    await assert.rejects(()=>x.runtime.step('empty'),error=>error.code==='DECISION_STOPPED'&&error.context.stopReason==='NO_LEGAL_ACTION');
    const stopped=x.store.events().find(event=>event.type==='decision').data;
    assert.equal(stopped.action,null);assert.equal(stopped.stopReason,'NO_LEGAL_ACTION');assert.equal(calls,0);
    assert.equal(x.store.intents().length,0);
  }finally{await x.runtime.close();x.store.close();}
});

test('a stop after durable intent but before send rejects the intent without executing',async()=>{
  const x=setup();let executed=0;const save=x.store.saveIntent.bind(x.store);
  try {
    x.domain.execute=async()=>{executed++;throw new Error('must never send');};
    x.store.saveIntent=intent=>{save(intent);queueMicrotask(()=>{void x.runtime.stop({drain:false});});};
    await assert.rejects(()=>x.runtime.step('stop-before-send'),{code:'CANCELLED'});
    assert.equal(executed,0);assert.equal(x.store.intents().length,1);
    assert.equal(x.store.intents()[0].receipt.status,'rejected');
    assert.equal(x.store.intents()[0].receipt.details.reason,'STOPPED_BEFORE_SEND');
  }finally{await x.runtime.close();x.store.close();}
});

test('execution entry rejects persisted legacy non-model sources and old runtime bindings',async()=>{
  for(const executionOwner of ['host','framework']){
    const x=setup({executionOwner});
    try {
      const decision=await x.runtime.decide(await x.domain.observe('legacy'));
      for(const source of ['domain_baseline','forced_action','abstain','stopped']){
        const legacy={...decision,decisionSource:source};x.store.putArtifact('decision',legacy);
        await assert.rejects(()=>executionOwner==='host'?x.runtime.prepareHostExecution(legacy):x.runtime.executeDecision(legacy),{code:'ACCESS_DENIED'});
      }
      assert.equal(x.store.intents().length,0);
    }finally{await x.runtime.close();x.store.close();}
  }
  const x=setup();
  try {
    const binding=x.store.release(x.store.activeRelease('scope'));
    const old=x.store.registerRelease({...binding,scopeId:'old-scope',dependencies:{...binding.dependencies,runtime:'duelloop-runtime-2'}});
    await assert.rejects(()=>x.runtime.activate(old,true),{code:'VERSION_INCOMPATIBLE'});
  }finally{await x.runtime.close();x.store.close();}
});

test('restored active research releases cannot inherit fixture qualification with a same-name real model',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'duelloop-live-qualification-'));const path=join(dir,'state.sqlite');const x=setup({path});
  const candidate=verifiedRelease(x.store,x.domain,x.model);await x.runtime.activate(candidate.release);await x.runtime.close();x.store.close();
  const store=new SqliteStore(path);let calls=0;
  const model={id:x.model.id,kind:'real',behaviorIdentity:x.model.behaviorIdentity,score:async request=>{calls++;return x.model.score(request);}};
  const app=new DuelLoop({applicationId:'test',domain:x.domain,model,store,mode:'live',executionOwner:'framework'});
  try {
    const observation=await x.domain.observe('restore');
    await assert.rejects(()=>app.decide(observation),{code:'VERSION_INCOMPATIBLE'});assert.equal(calls,0);assert.equal(store.intents().length,0);
  } finally {await app.close();store.close();rmSync(dir,{recursive:true});}
});

test('fixture validation is rejected in live decide and execution even when dependencies claim a real model',async()=>{
  const inner=fixture();const model={id:inner.id,kind:'real',behaviorIdentity:inner.behaviorIdentity,score:request=>inner.score(request)};
  const x=setup({model,mode:'simulation'});const research=verifiedRelease(x.store,x.domain,model);await x.runtime.activate(research.release);
  const oldDecision=await x.runtime.decide(await x.domain.observe('qualification'));
  const app=new DuelLoop({applicationId:'test',domain:x.domain,model,store:x.store,mode:'live',executionOwner:'framework'});
  try {
    await assert.rejects(()=>app.decide(oldDecision.observation),{code:'VALIDATION_REJECTED'});
    await assert.rejects(()=>app.executeDecision(oldDecision),{code:'VALIDATION_REJECTED'});
    await assert.rejects(()=>app.activate(research.release,true),{code:'VALIDATION_REJECTED'});
    await assert.rejects(()=>app.rollback('scope',research.release),{code:'VALIDATION_REJECTED'});
    assert.equal(x.store.intents().length,0);
  } finally {await app.close();await x.runtime.close();x.store.close();}
});

test('behavior identity changes invalidate previously bound releases and credentials are not required',async()=>{
  const x=setup();const changed={id:x.model.id,kind:x.model.kind,behaviorIdentity:{...x.model.behaviorIdentity,adapterVersion:'changed-implementation'},score:request=>x.model.score(request)};
  const app=new DuelLoop({applicationId:'test',domain:x.domain,model:changed,store:x.store,mode:'offline'});
  try {
    assert.notEqual(app.dependencies.modelBehaviorDigest,x.runtime.dependencies.modelBehaviorDigest);
    const observation=await x.domain.observe('changed');await assert.rejects(()=>app.decide(observation),{code:'VERSION_INCOMPATIBLE'});
    assert.throws(()=>new DuelLoop({applicationId:'test',domain:x.domain,store:x.store,model:{id:'missing',kind:'fixture',score:()=>{}}}),{code:'CONFIG_INVALID'});
  } finally {await app.close();await x.runtime.close();x.store.close();}
});

test('direct decide cancellation drains the actual model request and persists its late usage before close',async()=>{
  let entered,finish;const called=new Promise(resolve=>{entered=resolve;});const inner=fixture();let modelSignal;
  const model={id:inner.id,kind:inner.kind,behaviorIdentity:inner.behaviorIdentity,score:async request=>{
    const result=await inner.score(request);modelSignal=request.signal;entered();return new Promise(resolve=>{finish=()=>resolve({...result,usage:{inputTokens:7,outputTokens:3,unknown:false}});});
  }};
  const x=setup({model});const observation=await x.domain.observe('embedded');const decision=x.runtime.decide(observation);
  const rejected=assert.rejects(decision,{code:'CANCELLED'});await called;
  let closed=false;const closing=x.runtime.close().then(()=>{closed=true;});await rejected;
  await new Promise(resolve=>setImmediate(resolve));assert.equal(modelSignal.aborted,true);assert.equal(closed,false);
  assert.equal(x.store.events().filter(event=>event.type==='decision').length,1);
  finish();await closing;assert.equal(x.runtime.status().pendingOperations,0);
  assert.equal(x.store.events().find(event=>event.type==='decision.late_model_result').data.usage.inputTokens,7);x.store.close();
});

test('drain timeout leaves the runtime open until a noncooperative model settles',async()=>{
  let entered,finish;const called=new Promise(resolve=>{entered=resolve;});const inner=fixture();
  const model={id:inner.id,kind:inner.kind,behaviorIdentity:inner.behaviorIdentity,score:async request=>{
    const result=await inner.score(request);entered();return new Promise(resolve=>{finish=()=>resolve(result);});
  }};
  const x=setup({model});const decision=x.runtime.decide(await x.domain.observe('drain'));const rejected=assert.rejects(decision,{code:'CANCELLED'});await called;
  await assert.rejects(()=>x.runtime.stop({drain:true,timeoutMs:10}),{code:'MODEL_TIMEOUT'});await rejected;
  assert.ok(x.runtime.status().pendingOperations>0);finish();await x.runtime.close();assert.equal(x.runtime.status().pendingOperations,0);x.store.close();
});

test('pending activation defers until a scope boundary and activates exactly once without history scans',async()=>{
  const x=setup();let boundary=false;x.domain.capabilities.activationBoundary='scope';x.domain.canActivate=async()=>boundary;
  const release=verifiedRelease(x.store,x.domain,x.model).release;
  x.store.events=()=>{throw new Error('history events scan');};x.store.listArtifacts=()=>{throw new Error('history artifacts scan');};
  assert.equal(await x.runtime.activatePending('scope'),null);boundary=true;
  assert.equal(await x.runtime.activatePending('scope'),release);assert.equal(await x.runtime.activatePending('scope'),null);
  await x.runtime.close();x.store.close();
});

test('runtime step uses indexed intent lookups and records unambiguous end-to-end timing',async()=>{
  const x=setup();x.store.intents=()=>{throw new Error('historical intent scan');};
  const result=await x.runtime.step('indexed');assert.equal(result.receipt.status,'completed');
  const metric=x.store.events({scopeId:'scope'}).find(event=>event.type==='runtime.step_completed').data;
  assert.ok(metric.decisionEndToEndLatencyMs>=metric.modelLatencyMs);assert.ok(metric.stepLatencyMs>=metric.decisionEndToEndLatencyMs);
  assert.ok(metric.executionAckLatencyMs>=0);assert.equal(typeof metric.deadlineMiss,'boolean');await x.runtime.close();x.store.close();
});

test('direct execution remains in the drain until the submitted domain operation settles',async()=>{
  const x=setup();const decision=await x.runtime.decide(await x.domain.observe('direct-execute'));
  const execute=x.domain.execute.bind(x.domain);let entered,finish;const called=new Promise(resolve=>{entered=resolve;});
  x.domain.execute=async command=>{entered();return new Promise(resolve=>{finish=async()=>resolve(await execute(command));});};
  const executing=x.runtime.executeDecision(decision);await called;let closed=false;const closing=x.runtime.close().then(()=>{closed=true;});
  const receipt=await executing;assert.equal(receipt.status,'unknown');await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  await finish();await closing;assert.equal(x.store.intent(decision.decisionId).receipt.status,'unknown');
  assert.equal((await x.domain.executionStatus(decision.decisionId)).status,'completed');x.store.close();
});

test('validation revoked while checking freshness prevents intent creation and execution',async()=>{
  const x=setup();const next=verifiedRelease(x.store,x.domain,x.model);await x.runtime.activate(next.release);
  const decision=await x.runtime.decide(await x.domain.observe('revoked-during-prepare'));
  const observe=x.domain.observe.bind(x.domain);let entered,finish;const called=new Promise(resolve=>{entered=resolve;});
  x.domain.observe=async stream=>{const observation=await observe(stream);entered();return new Promise(resolve=>{finish=()=>resolve(observation);});};
  let executions=0;x.domain.execute=async()=>{executions++;throw new Error('must not execute');};
  const executing=x.runtime.executeDecision(decision);const rejected=assert.rejects(executing,{code:'VALIDATION_REJECTED'});await called;
  x.store.invalidateValidation(next.validationDigest,'corrected feedback');finish();await rejected;
  assert.equal(executions,0);assert.equal(x.store.intent(decision.decisionId),undefined);await x.runtime.close();x.store.close();
});

test('sync and async subscriber failures do not change durable events or action execution',async()=>{
  const x=setup();let detachedCalls=0,asyncCalls=0,successfulCalls=0;
  x.runtime.subscribe(()=>{throw new Error('synchronous observer failed');});
  x.runtime.subscribe(async()=>{asyncCalls++;throw new Error('asynchronous observer failed');});
  const detach=x.runtime.subscribe(()=>{detachedCalls++;});detach();
  x.runtime.subscribe(()=>{successfulCalls++;});
  try {
    const result=await x.runtime.step('observers');await new Promise(resolve=>setImmediate(resolve));
    assert.equal(result.receipt.status,'completed');assert.equal(detachedCalls,0);assert.ok(asyncCalls>0);assert.equal(successfulCalls,asyncCalls);
    assert.equal(x.store.events({scopeId:'scope',types:['decision']}).length,1);
    assert.equal(x.store.events({scopeId:'scope',types:['runtime.step_completed']}).length,1);
    assert.equal(x.store.intents().length,1);assert.equal(x.runtime.status().stopping,false);
  } finally {await x.runtime.close();x.store.close();}
});

test('start AbortSignal immediately cancels an active model request and persists a stopped decision',async()=>{
  let entered,modelSignal;const called=new Promise(resolve=>{entered=resolve;});const inner=fixture();
  const model={id:inner.id,kind:inner.kind,behaviorIdentity:inner.behaviorIdentity,score:async request=>{
    modelSignal=request.signal;entered();return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('transport cancelled')),{once:true}));
  }};
  const x=setup({model});let executions=0;x.domain.execute=async()=>{executions++;throw new Error('must not execute');};
  const controller=new AbortController();const running=x.runtime.start({streamIds:['abort-running'],maxSteps:2,signal:controller.signal});
  const rejected=assert.rejects(running,{code:'CANCELLED'});await called;controller.abort();await rejected;await x.runtime.close();
  assert.equal(modelSignal.aborted,true);assert.equal(executions,0);assert.equal(x.store.intents().length,0);
  const decisions=x.store.events({scopeId:'scope',types:['decision']});assert.equal(decisions.length,1);
  assert.equal(decisions[0].data.decisionSource,'stopped');assert.equal(decisions[0].data.stopReason,'CANCELLED');
  assert.equal(x.runtime.status().pendingOperations,0);x.store.close();
});

test('one deferred activation attempt writes exactly one durable deferral',async()=>{
  const x=setup();x.domain.capabilities.activationBoundary='scope';x.domain.canActivate=async()=>false;
  const release=verifiedRelease(x.store,x.domain,x.model).release;
  assert.equal(await x.runtime.activatePending('scope'),null);
  assert.equal(x.store.events({scopeId:'scope',types:['release.deferred']}).length,1);
  x.domain.canActivate=async()=>true;x.store.pauseActivation('scope',true);
  await assert.rejects(()=>x.runtime.activate(release),{code:'ACTIVATION_DEFERRED'});
  const deferred=x.store.events({scopeId:'scope',types:['release.deferred']});assert.equal(deferred.length,2);assert.equal(deferred[1].data.reason,'activation_paused');
  await x.runtime.close();x.store.close();
});

test('validation revoked during the model request prevents returning a successful embedded decision',async()=>{
  let entered,finish;const called=new Promise(resolve=>{entered=resolve;});const inner=fixture();
  const model={id:inner.id,kind:inner.kind,behaviorIdentity:inner.behaviorIdentity,score:async request=>{
    const response=await inner.score(request);entered();return new Promise(resolve=>{finish=()=>resolve(response);});
  }};
  const x=setup({model});const next=verifiedRelease(x.store,x.domain,model);await x.runtime.activate(next.release);
  const deciding=x.runtime.decide(await x.domain.observe('revoke-before-return'));const rejected=assert.rejects(deciding,{code:'VALIDATION_REJECTED'});await called;
  x.store.invalidateValidation(next.validationDigest,'corrected evidence');finish();await rejected;
  const decision=x.store.events({scopeId:'scope',types:['decision']})[0].data;assert.equal(decision.decisionSource,'stopped');assert.equal(decision.action,null);
  assert.equal(x.store.intents().length,0);await x.runtime.close();x.store.close();
});
