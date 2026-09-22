#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuelLoop, SqliteStore, KuhnPokerDomain, createKuhnStrategy, digest } from 'duelloop';
import { configuredModel, parseArguments, quantiles, usageAccumulator, addUsage, emitReport } from './m0.mjs';

// Records full public-SDK step latency, including durable intent/receipt/decision writes.
async function main() {
 const args=process.argv.slice(2).map(x=>x==='--steps'?'--hands':x);
 const options=parseArguments(['--hands','1000','--max-calls','2000',...args]);
 const model=configuredModel(options.fixture),usage=usageAccumulator();
 const directory=await mkdtemp(join(tmpdir(),'duelloop-benchmark-'));
 let calls=0;
 const measuredModel={id:model.id,kind:model.kind,score:async input=>{
  if(calls>=options.maxCalls)throw Object.assign(Error('Benchmark call budget exceeded'),{code:'BUDGET_EXHAUSTED'});
  calls++;
  try {const result=await model.score(input);addUsage(usage,result.usage);return result;}
  catch(error){addUsage(usage,error.context?.usage);throw error;}
 }};
 const domain=new KuhnPokerDomain({applicationId:'benchmark',scopeId:'benchmark',seed:options.seeds[0],opponentId:options.opponents[0],knowledgeStateMode:'frozen',knowledge:{},decisionTimeoutMs:options.timeoutMs});
 const store=new SqliteStore(join(directory,'benchmark.sqlite'));
 const runtime=new DuelLoop({applicationId:'benchmark',domain,model:measuredModel,store,mode:options.fixture?'offline':'simulation',executionOwner:'framework',maxDecisionMs:options.timeoutMs,executionReserveMs:25,randomSeed:'benchmark-1'});
 const samples=[];let fallback=0,timeouts=0,abstain=0;
 try {
  runtime.bootstrap(createKuhnStrategy(),'benchmark');
  const warmup=Math.min(10,options.hands);for(let i=0;i<warmup && calls<options.maxCalls;i++)await runtime.step('stream');
  const wallStart=performance.now();let failureCode=null;
  for(let index=0;index<options.hands;index++) {
   if(calls>=options.maxCalls){failureCode='BUDGET_EXHAUSTED';break;}
   const started=performance.now();
   try {
    const {decision,receipt}=await runtime.step('stream');
    samples.push({latencyMs:performance.now()-started,decisionSource:decision.decisionSource,receiptStatus:receipt?.status??null,fallbackReason:decision.fallbackReason??null});
    if(decision.decisionSource==='domain_baseline')fallback++;
    if(decision.decisionSource==='abstain')abstain++;
    if(decision.fallbackReason==='MODEL_TIMEOUT')timeouts++;
    if(receipt?.status==='unknown'){failureCode='EXECUTION_UNKNOWN';break;}
   } catch(error){failureCode=error.code??'RUNTIME_FAILURE';break;}
  }
  const elapsedMs=performance.now()-wallStart;
  await emitReport({schemaVersion:'1.0',experiment:'public-sdk-durable-step-throughput',modelKind:model.kind,model:model.id,status:failureCode?'incomplete':'completed',failureCode,node:process.version,platform:process.platform,storage:'temporary on-disk SQLite WAL; includes durable intent and receipt writes',claim:options.fixture?'Fixture measures local framework and storage overhead only. It is not real-model latency.':'End-to-end sequential SDK measurements include model, runtime, and local storage; no concurrency/scaling guarantee.',configuration:{requestedSteps:options.hands,warmupSteps:warmup,seed:options.seeds[0],opponent:options.opponents[0],knowledgeStateMode:'frozen',maxDecisionMs:options.timeoutMs,maxModelCalls:options.maxCalls,strategyDigest:digest(createKuhnStrategy()),dependencies:runtime.dependencies},measuredSteps:samples.length,elapsedMs,stepsPerSecond:elapsedMs?samples.length/(elapsedMs/1000):0,latencyMs:quantiles(samples.map(s=>s.latencyMs)),fallbackRate:samples.length?fallback/samples.length:null,timeoutRate:samples.length?timeouts/samples.length:null,abstentionRate:samples.length?abstain/samples.length:null,modelCallsIncludingWarmup:calls,usageIncludingWarmup:usage,samples},options.output);
  if(failureCode)process.exitCode=1;
 } finally {await runtime.close();store.close();await rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{process.stderr.write(JSON.stringify({status:'not_executed',error:error.message})+'\n');process.exitCode=1;});
