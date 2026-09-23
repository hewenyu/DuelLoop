import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore, DuelLoop, KuhnPokerDomain, FixtureDecisionModel, createKuhnStrategy } from 'duelloop';
const child=(source,args=[])=>new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['--input-type=module','-e',source,...args],{stdio:['ignore','pipe','pipe']});let output='',error='';
  p.stdout.on('data',v=>output+=v);p.stderr.on('data',v=>error+=v);p.on('error',reject);p.on('exit',code=>resolve({code,output,error}));
});
const model=()=>new FixtureDecisionModel('process-fixture',q=>({score:1,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,Number(i===1)]))}));

test('two actual worker processes cannot create concurrent research for one scope',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'duelloop-process-'));const path=join(dir,'state.sqlite');
  try {
    const store=new SqliteStore(path);const app=new DuelLoop({applicationId:'process',domain:new KuhnPokerDomain(),model:model(),store});app.bootstrap(createKuhnStrategy(),'scope');await app.close();store.close();
    const source=`import {SqliteStore} from 'duelloop';const s=new SqliteStore(process.argv[1]);try{s.createRun({id:process.argv[2],scopeId:'scope',baseReleaseDigest:s.activeRelease('scope'),researchSnapshotId:s.snapshot('scope',Date.now()),evaluationProtocolDigest:s.putArtifact('protocol',{id:'p'},'private'),status:'created',data:{}});console.log('created');}catch(e){console.log(e.code);}finally{s.close();}`;
    const results=await Promise.all([child(source,[path,'one']),child(source,[path,'two'])]);
    assert.ok(results.every(r=>r.code===0),JSON.stringify(results));
    assert.deepEqual(results.map(r=>r.output.trim()).sort(),['CONFLICT','created']);
    const restored=new SqliteStore(path);assert.equal(restored.listRuns('scope').length,1);restored.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('crash after external acceptance preserves intent and requires reconciliation before owner takeover',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'duelloop-crash-'));const path=join(dir,'state.sqlite'),ledger=join(dir,'external-ledger.json');
  try {
    const result=await child(`import {writeFileSync} from 'node:fs';import {SqliteStore,DuelLoop,KuhnPokerDomain,FixtureDecisionModel,createKuhnStrategy} from 'duelloop';const store=new SqliteStore(process.argv[1]);const domain=new KuhnPokerDomain({applicationId:'process',scopeId:'scope'});domain.execute=async c=>{writeFileSync(process.argv[2],JSON.stringify({decisionId:c.decisionId,idempotencyKey:c.idempotencyKey,status:'completed',timestamp:Date.now()}));process.exit(17);};const app=new DuelLoop({applicationId:'process',domain,model:new FixtureDecisionModel('process-fixture',q=>({score:1,confidence:1,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[i,Number(i===1)]))})),store,executionOwner:'framework'});app.bootstrap(createKuhnStrategy(),'scope');await app.step('a');`,[path,ledger]);
    assert.equal(result.code,17,result.error);
    const store=new SqliteStore(path);const intent=store.intents('scope')[0];assert.ok(intent);assert.equal(intent.receipt,null);
    assert.throws(()=>store.acquireOwner('scope','a','new-process'),{code:'EXECUTION_UNKNOWN'});
    const domain=new KuhnPokerDomain({applicationId:'process',scopeId:'scope'});let queries=0,executes=0;
    domain.executionStatus=async()=>{queries++;return JSON.parse(readFileSync(ledger,'utf8'));};domain.execute=async()=>{executes++;throw Error('must not resend');};
    const app=new DuelLoop({applicationId:'process',domain,model:model(),store,executionOwner:'framework'});
    const receipts=await app.reconcile('scope');assert.equal(receipts[0].status,'completed');assert.equal(queries,1);assert.equal(executes,0);
    assert.ok(store.acquireOwner('scope','a','new-process'));assert.equal(store.integrity().ok,true);
    await app.close();store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
