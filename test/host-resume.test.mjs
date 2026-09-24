import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuelLoop, SqliteStore, KuhnPokerDomain, FixtureDecisionModel, createKuhnStrategy } from '../dist/index.js';
const model=()=>new FixtureDecisionModel('resume-fixture',q=>({score:0,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,Number(i===0)]))}));
function runtime(store,decision){
 const domain=new KuhnPokerDomain({applicationId:'host-resume',scopeId:'scope'});
 if(decision){domain.observe=async()=>structuredClone(decision.observation);domain.candidates=async()=>structuredClone(decision.candidates);}
 const fixture=model();if(decision)fixture.score=()=>{throw new Error('Recovery must not call a model');};
 return {domain,app:new DuelLoop({applicationId:'host-resume',domain,model:fixture,store,mode:'simulation',executionOwner:'host'})};
}
async function prepared(store=new SqliteStore()){
 const {app,domain}=runtime(store);app.bootstrap(createKuhnStrategy(),'scope');
 const decision=await app.decide(await domain.observe('table'));const command=await app.prepareHostExecution(decision);
 return {store,app,decision,command};
}
const withoutOwner=({ownerToken:_,...command})=>command;

test('clean close permits the same immutable intent to resume and repeated resume is idempotent',async()=>{
 const f=await prepared();await f.app.close();const {app}=runtime(f.store,f.decision);
 try{
  const resumed=await app.resumeHostExecution(f.decision);assert.notEqual(resumed.ownerToken,f.command.ownerToken);
  assert.deepEqual(withoutOwner(resumed),withoutOwner(f.command));assert.deepEqual(await app.resumeHostExecution(f.decision),resumed);
  assert.equal(f.store.intent(f.decision.decisionId).ownerToken,resumed.ownerToken);
  assert.equal(f.store.intents().length,1);assert.equal(f.store.events({types:['execution.intent']}).length,1);
  assert.equal(f.store.events({types:['execution.owner_reclaimed'],allowPrivate:true}).length,1);
 }finally{await app.close();f.store.close();}
});

test('another live runtime cannot steal an unresolved intent even on the same process',async()=>{
 const f=await prepared();const {app}=runtime(f.store,f.decision);
 try{await assert.rejects(app.resumeHostExecution(f.decision),{code:'CONFLICT'});assert.equal(f.store.intent(f.decision.decisionId).ownerToken,f.command.ownerToken);
  f.store.assertOwner('scope','table',f.command.ownerToken);
 }finally{await app.close();await f.app.close();f.store.close();}
});

test('cancelled recovery never reacquires ownership or poisons unrelated decisions',async()=>{
 const f=await prepared();await f.app.close();const {app,domain}=runtime(f.store,f.decision);const controller=new AbortController();
 let resolve;let entered;const started=new Promise(r=>{entered=r;});domain.observe=()=>{entered();return new Promise(r=>{resolve=r;});};
 try{const pending=app.resumeHostExecution(f.decision,{signal:controller.signal});await started;controller.abort();await assert.rejects(pending,{code:'CANCELLED'});
  assert.equal(app.status().stopping,false);assert.equal(f.store.events({types:['execution.owner_reclaimed'],allowPrivate:true}).length,0);
 }finally{resolve(structuredClone(f.decision.observation));await app.close();f.store.close();}
});

test('recovery rejects stale state, illegal candidates and original deadline expiry before owner claim',async()=>{
 for(const kind of ['revision','candidates','deadline']){
  const f=await prepared();await f.app.close();const {app,domain}=runtime(f.store,f.decision);const originalNow=Date.now;
  if(kind==='revision')domain.observe=async()=>({...f.decision.observation,revision:'new-revision'});
  if(kind==='candidates')domain.candidates=async()=>[];
  if(kind==='deadline')Date.now=()=>f.decision.observation.deadline+1;
  try{await assert.rejects(app.resumeHostExecution(f.decision),{code:'STATE_STALE'});assert.equal(f.store.events({types:['execution.owner_reclaimed'],allowPrivate:true}).length,0);}
  finally{Date.now=originalNow;await app.close();f.store.close();}
 }
});

test('terminal intents and modified decision payload cannot be resumed',async()=>{
 const f=await prepared();await f.app.close();const {app}=runtime(f.store,f.decision);
 try{
  await assert.rejects(app.resumeHostExecution({...f.decision,action:{...f.decision.action,kind:'modified'}}));
  f.store.recordReceipt({decisionId:f.decision.decisionId,idempotencyKey:f.decision.decisionId,status:'completed',timestamp:Date.now()});
  await assert.rejects(app.resumeHostExecution(f.decision),{code:'EXECUTION_UNKNOWN'});assert.equal(f.store.events({types:['execution.owner_reclaimed'],allowPrivate:true}).length,0);
 }finally{await app.close();f.store.close();}
});

test('an owner recorded on another hostname remains blocked even with an apparently dead PID',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'duelloop-host-owner-'));const path=join(dir,'store.sqlite');const f=await prepared(new SqliteStore(path));const {app}=runtime(f.store,f.decision);
 const db=new DatabaseSync(path);db.prepare('UPDATE owners SET host=?,pid=?').run('unknown-different-host',2147483647);db.close();
 try{await assert.rejects(app.resumeHostExecution(f.decision),{code:'CONFLICT'});assert.equal(f.store.intent(f.decision.decisionId).ownerToken,f.command.ownerToken);}
 finally{await app.close();await f.app.close();f.store.close();rmSync(dir,{recursive:true,force:true});}
});

test('a genuinely killed local process releases eligibility to reclaim only its original intent',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'duelloop-killed-owner-')),path=join(dir,'store.sqlite');
 const source=`import {DuelLoop,SqliteStore,KuhnPokerDomain,FixtureDecisionModel,createKuhnStrategy} from 'duelloop';
 const store=new SqliteStore(process.argv[1]),domain=new KuhnPokerDomain({applicationId:'host-resume',scopeId:'scope'});
 const model=new FixtureDecisionModel('resume-fixture',q=>({score:0,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,Number(i===0)]))}));
 const app=new DuelLoop({applicationId:'host-resume',domain,model,store,mode:'simulation',executionOwner:'host'});app.bootstrap(createKuhnStrategy(),'scope');
 const decision=await app.decide(await domain.observe('table'));await app.prepareHostExecution(decision);console.log(JSON.stringify(decision));setInterval(()=>{},1000);`;
 const processOwner=spawn(process.execPath,['--input-type=module','-e',source,path],{stdio:['ignore','pipe','pipe']});let store,app;let error='';processOwner.stderr.on('data',chunk=>{error+=chunk;});
 try{
  let output='';await new Promise((resolve,reject)=>{processOwner.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n'))resolve();});processOwner.once('error',reject);processOwner.once('exit',()=>reject(new Error(error||'Owner exited before intent')));});
  const decision=JSON.parse(output.trim());store=new SqliteStore(path);({app}=runtime(store,decision));
  await assert.rejects(app.resumeHostExecution(decision),{code:'CONFLICT'});
  const exited=once(processOwner,'exit');processOwner.kill('SIGKILL');await exited;
  assert.throws(()=>store.acquireOwner('scope','table','ordinary-new-owner'),{code:'EXECUTION_UNKNOWN'});
  const command=await app.resumeHostExecution(decision);assert.equal(command.idempotencyKey,decision.decisionId);
  assert.equal(store.intents().length,1);assert.equal(store.intent(decision.decisionId).ownerToken,command.ownerToken);
 }finally{if(processOwner.exitCode===null&&!processOwner.signalCode){processOwner.kill('SIGKILL');await once(processOwner,'exit');}await app?.close();store?.close();rmSync(dir,{recursive:true,force:true});}
});
