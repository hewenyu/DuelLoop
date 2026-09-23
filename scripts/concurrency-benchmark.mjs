#!/usr/bin/env node
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { cpus, availableParallelism, totalmem, freemem, release, tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import {
 DuelLoop, DuelLoopError, SqliteStore, KuhnPokerDomain, KuhnEvaluationAdapter,
 createKuhnStrategy, evaluateCandidate, digest,
} from 'duelloop';
import { configuredModel, quantiles, usageAccumulator, addUsage, emitReport } from './m0.mjs';

const now=()=>performance.timeOrigin+performance.now();
function parse(args) {
 const options={fixture:false,repetitions:3,steps:1000,warmup:10,slowRuns:100,slowHands:8,timeoutMs:5000,maxFastCalls:1200,maxSlowCalls:10000,wallSeconds:120,output:null};
 const flags={'--repetitions':'repetitions','--steps':'steps','--warmup':'warmup','--slow-runs':'slowRuns','--slow-hands':'slowHands','--timeout-ms':'timeoutMs','--max-fast-calls':'maxFastCalls','--max-slow-calls':'maxSlowCalls','--wall-seconds':'wallSeconds','--output':'output'};
 for(let i=0;i<args.length;i++) {
  if(args[i]==='--fixture'){options.fixture=true;continue;}
  const key=flags[args[i]];if(!key || args[i+1]===undefined)throw Error(`Unsupported or incomplete argument: ${args[i]}`);
  options[key]=key==='output'?args[++i]:Number(args[++i]);
 }
 for(const [key,value] of Object.entries(options))if(!['fixture','output'].includes(key)&&(!Number.isSafeInteger(value)||value<(key==='warmup'?0:1)))throw Error(`${key} must be a ${key==='warmup'?'nonnegative':'positive'} integer`);
 if(options.timeoutMs<=25)throw Error('timeout-ms must exceed the 25 ms execution reserve');
 if(options.maxFastCalls<options.steps+options.warmup)throw Error('max-fast-calls must cover steps + warmup');
 return options;
}
function measuredModel(options,role,store,scopeId) {
 const source=configuredModel(options.fixture),usage=usageAccumulator();let calls=0,budgetExhausted=false;
 const limit=role==='fast'?options.maxFastCalls:options.maxSlowCalls;
 const model={id:source.id,kind:source.kind,score:async input=>{
  if(calls>=limit){budgetExhausted=true;throw new DuelLoopError('BUDGET_EXHAUSTED',`${role} model call budget exhausted`);}
  calls++;
  try {
   const answer=await source.score(input);addUsage(usage,answer.usage);
   // Mirrors the evaluation usage journal, creating genuine shared SQLite write contention.
   if(role==='slow')store.appendEvent('benchmark.evaluation_model_usage',scopeId,{call:calls,usage:answer.usage??{unknown:true}},'private');
   return answer;
  } catch(error){addUsage(usage,error.context?.usage);throw error;}
 }};
 return {model,usage,calls:()=>calls,exhausted:()=>budgetExhausted};
}
function fastSummary(samples,startedAt,endedAt) {
 const count=samples.length;
 const completed=samples.filter(s=>s.decisionSource==='strategy').length;
 return {measuredSteps:count,completedSteps:completed,startedAt,endedAt,elapsedMs:endedAt-startedAt,
  stepsPerSecond:endedAt>startedAt?completed/((endedAt-startedAt)/1000):0,
  latencyMs:quantiles(samples.map(s=>s.latencyMs)),
  timeoutRate:count?samples.filter(s=>s.stopReason==='MODEL_TIMEOUT').length/count:null,
  stoppedRate:count?samples.filter(s=>s.decisionSource==='stopped').length/count:null,
  unknownReceiptCount:samples.filter(s=>s.receiptStatus==='unknown').length};
}
async function workerMain() {
 const {role,options,database,sharedFlag}=workerData;
 const fastDone=new Int32Array(sharedFlag),store=new SqliteStore(database);
 const measured=measuredModel(options,role,store,'benchmark');
 const domain=new KuhnPokerDomain({applicationId:'concurrency-benchmark',scopeId:'benchmark',seed:11,opponentId:'calling',knowledgeStateMode:'frozen',knowledge:{},decisionTimeoutMs:options.timeoutMs});
 const policy={maxDecisionMs:options.timeoutMs,executionReserveMs:25};
 const runtime=new DuelLoop({applicationId:'concurrency-benchmark',domain,model:measured.model,store,mode:options.fixture?'offline':'simulation',executionOwner:'framework',...policy});
 try {
  if(role==='fast') {
   for(let i=0;i<options.warmup;i++){const result=await runtime.step('fast-stream');if(result.receipt?.status==='unknown')throw new DuelLoopError('EXECUTION_UNKNOWN','Warmup execution unknown');}
  }
  parentPort.postMessage({type:'ready'});await once(parentPort,'message');
  if(role==='fast') {
   const samples=[],startedAt=now();let failureCode=null;
   for(let index=0;index<options.steps;index++) {
    const begin=now();
    try {
     const {decision,receipt}=await runtime.step('fast-stream');
     samples.push({startedAt:begin,endedAt:now(),latencyMs:now()-begin,decisionSource:decision.decisionSource,stopReason:decision.stopReason??null,receiptStatus:receipt?.status??null});
     if(receipt?.status==='unknown'){failureCode='EXECUTION_UNKNOWN';break;}
    } catch(error){failureCode=error.code??'FAST_WORKER_ERROR';samples.push({startedAt:begin,endedAt:now(),latencyMs:now()-begin,decisionSource:'stopped',stopReason:failureCode,receiptStatus:null});break;}
    if((index+1)%25===0)parentPort.postMessage({type:'progress',result:{...fastSummary(samples,startedAt,now()),modelCallsIncludingWarmup:measured.calls(),usageIncludingWarmup:measured.usage}});
   }
   const endedAt=now();Atomics.store(fastDone,0,1);
   return {role,status:failureCode?'incomplete':'completed',failureCode,...fastSummary(samples,startedAt,endedAt),modelCallsIncludingWarmup:measured.calls(),usageIncludingWarmup:measured.usage,samples};
  }
  const adapter=new KuhnEvaluationAdapter(policy),baseReleaseDigest=store.activeRelease('benchmark');
  const baseline=store.getArtifact(store.release(baseReleaseDigest).strategyDigest),candidate=structuredClone(baseline);
  candidate.version='benchmark-candidate';candidate.parentVersion=baseline.version;candidate.decision.defaultWeights.exposure=-.4;
  const protocol={version:'2.0',id:'concurrent-development-workload',domainId:domain.id,seeds:[101,103],opponentIds:['calling','tight'],trajectoriesPerSeed:options.slowHands,knowledgeStateMode:'frozen',initialKnowledge:{},metric:{name:'reward',direction:'maximize',unit:'net chips per hand'},minSamples:2,minimumImprovement:0,maxGroupRegression:1,confidenceLevel:.95,maxP95LatencyMs:options.timeoutMs,maxDevelopmentEvalRuns:options.slowRuns,maxFinalEvaluationsPerRun:1,holdoutId:'development-workload-not-release-evidence',maxHoldoutUses:1};
  const startedAt=now(),experiments=[];let failureCode=null;
  for(let index=0;index<options.slowRuns&&!Atomics.load(fastDone,0);index++) {
   const begin=now();
   if(measured.calls()>=options.maxSlowCalls){failureCode='BUDGET_EXHAUSTED';break;}
   try {
    const report=await evaluateCandidate({candidate,baseline,protocol,adapter,model:measured.model,dependencies:runtime.dependencies,baseReleaseDigest,stage:'development',signal:AbortSignal.timeout(options.wallSeconds*1000),
     onEvidence:evidence=>store.putArtifact('benchmark_development_evidence',{experiment:index,...evidence},'private')});
    const reportDigest=store.putArtifact('benchmark_development_report',report,'private');
    store.appendEvent('benchmark.development_result','benchmark',{experiment:index,reportDigest},'private');
    experiments.push({index,startedAt:begin,endedAt:now(),status:report.status,sampleCount:report.sampleCount});
    if(measured.exhausted()){failureCode='BUDGET_EXHAUSTED';break;}
   } catch(error){failureCode=error.code??'SLOW_WORKER_ERROR';break;}
   parentPort.postMessage({type:'progress',result:{completedExperiments:experiments.length,startedAt,endedAt:now(),modelCalls:measured.calls(),usage:measured.usage}});
  }
  return {role,status:failureCode?'incomplete':'completed',failureCode,startedAt,endedAt:now(),completedExperiments:experiments.length,stopReason:failureCode??(Atomics.load(fastDone,0)?'fast_worker_finished':'bounded_experiment_limit'),modelCalls:measured.calls(),usage:measured.usage,experiments};
 } finally {await runtime.close();store.close();}
}
async function phase(options,database,concurrent) {
 // Initialize schema and initial release before the workers start competing for the same file.
 const source=configuredModel(options.fixture),store=new SqliteStore(database);
 const domain=new KuhnPokerDomain({applicationId:'concurrency-benchmark',scopeId:'benchmark'});
 const runtime=new DuelLoop({applicationId:'concurrency-benchmark',domain,model:source,store,mode:options.fixture?'offline':'simulation',maxDecisionMs:options.timeoutMs,executionReserveMs:25});
 runtime.bootstrap(createKuhnStrategy(),'benchmark');await runtime.close();store.close();
 const sharedFlag=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),workers=[];
 const spawn=role=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{role,options,database,sharedFlag}});
  let readyResolve,readyReject,resultResolve,resultReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const result=new Promise((resolve,reject)=>{resultResolve=resolve;resultReject=reject;});
  const entry={role,worker,ready,result,progress:null};workers.push(entry);
  // Attach rejection handlers immediately while waiting for the readiness barrier.
  void result.catch(()=>{});void ready.catch(()=>{});
  worker.on('message',message=>{if(message.type==='ready')readyResolve();if(message.type==='progress')entry.progress=message.result;if(message.type==='result')resultResolve(message.result);});
  worker.on('error',error=>{readyReject(error);resultReject(error);});
  worker.on('exit',code=>{if(code!==0){const error=new Error(`Worker ${role} exited ${code}`);readyReject(error);resultReject(error);}});
  return entry;
 };
 const fast=spawn('fast'),slow=concurrent?spawn('slow'):null;
 let timer;
 try {
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Bounded benchmark phase expired'),{code:'BENCHMARK_TIMEOUT'})),options.wallSeconds*1000);});
  return await Promise.race([(async()=>{
   await Promise.all(workers.map(w=>w.ready));
   for(const entry of workers)entry.worker.postMessage({type:'start'});
   const [fastResult,slowResult]=await Promise.all([fast.result,slow?.result??null]);
   const overlap=slowResult?.experiments??[];
   const overlapSamples=(fastResult.samples??[]).filter(sample=>overlap.some(experiment=>sample.startedAt<experiment.endedAt&&sample.endedAt>experiment.startedAt));
   return {status:fastResult.status==='completed'&&(!slowResult||slowResult.status==='completed')?'completed':'incomplete',workerCount:workers.length,fast:fastResult,slow:slowResult,
    concurrentFastSteps:overlapSamples.length,concurrentFraction:fastResult.measuredSteps?overlapSamples.length/fastResult.measuredSteps:0,
    latencyWhileEvaluationActiveMs:quantiles(overlapSamples.map(s=>s.latencyMs))};
  })(),timeout]);
 } catch(error){return {status:'incomplete',failureCode:error.code??'WORKER_FAILURE',workerCount:workers.length,partialProgress:workers.map(w=>({role:w.role,...w.progress}))};}
 finally {clearTimeout(timer);for(const entry of workers)await entry.worker.terminate();}
}
async function main() {
 const startedAt=new Date().toISOString(),options=parse(process.argv.slice(2)),model=configuredModel(options.fixture);
 const directory=await mkdtemp(join(tmpdir(),'duelloop-concurrency-'));
 try {
  const ratio=(after,before)=>typeof before==='number'&&before>0&&typeof after==='number'?after/before:null;
  const difference=(after,before)=>typeof after==='number'&&typeof before==='number'?after-before:null;
  const repetitions=[];
  for(let index=0;index<options.repetitions;index++) {
   const measurementOrder=index%2===0?['standalone','concurrent']:['concurrent','standalone'];
   const phases={};
   for(const name of measurementOrder)phases[name]=await phase(options,join(directory,`${index}-${name}.sqlite`),name==='concurrent');
   const {standalone,concurrent}=phases;
   const comparison={p50LatencyRatio:ratio(concurrent.fast?.latencyMs?.p50,standalone.fast?.latencyMs?.p50),p95LatencyRatio:ratio(concurrent.fast?.latencyMs?.p95,standalone.fast?.latencyMs?.p95),p99LatencyRatio:ratio(concurrent.fast?.latencyMs?.p99,standalone.fast?.latencyMs?.p99),throughputRatio:ratio(concurrent.fast?.stepsPerSecond,standalone.fast?.stepsPerSecond),timeoutRateDifference:difference(concurrent.fast?.timeoutRate,standalone.fast?.timeoutRate),stoppedRateDifference:difference(concurrent.fast?.stoppedRate,standalone.fast?.stoppedRate)};
   const complete=standalone.status==='completed'&&concurrent.status==='completed'&&concurrent.concurrentFastSteps>0;
   repetitions.push({index,measurementOrder,status:complete?'completed':'incomplete',standalone,concurrent,comparison});
  }
  const describe=key=>{
   const values=repetitions.filter(r=>r.status==='completed').map(r=>r.comparison[key]).filter(Number.isFinite);
   return {count:values.length,mean:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,min:values.length?Math.min(...values):null,max:values.length?Math.max(...values):null};
  };
  const status=repetitions.every(r=>r.status==='completed')?'completed':'incomplete';
  const primary=repetitions[0];
  const report={schemaVersion:'2.0',experiment:'fast-worker-versus-concurrent-evaluation-shared-sqlite',status,modelKind:model.kind,model:model.id,
   startedAt,machine:{node:process.version,platform:process.platform,osRelease:release(),arch:process.arch,cpuModel:cpus()[0]?.model??'unknown',logicalCpus:cpus().length,availableParallelism:availableParallelism(),memoryBytes:totalmem(),freeMemoryBytesAtReport:freemem()},
   configuration:{...options,output:options.output??null,fastSeed:11,fastOpponent:'calling',evaluationSeeds:[101,103],evaluationOpponents:['calling','tight'],knowledgeStateMode:'frozen',initialKnowledge:{},strategyDigest:digest(createKuhnStrategy()),storage:'Two independent SQLite connections to one on-disk WAL database per phase. Every phase of every repetition uses a separate freshly initialized database.',concurrency:'Standalone: one fast worker thread. Concurrent: one fast and one slow evaluation worker thread, same process and SQLite file. No pi research conversation.',measurementOrder:'Alternating by repetition: standalone/concurrent, then concurrent/standalone.',totalBudgetUpperBounds:{fastModelCalls:2*options.repetitions*options.maxFastCalls,slowModelCalls:options.repetitions*options.maxSlowCalls,slowExperiments:options.repetitions*options.slowRuns,measuredPhaseWallSeconds:2*options.repetitions*options.wallSeconds,wallTimeNote:'Sum of phase timeout budgets; excludes setup, initialization, reporting and worker termination overhead.'},stopRule:'Slow worker finishes its in-progress experiment then stops when fast worker ends, or earlier at its declared call/experiment/wall-time cap.'},
   claim:options.fixture?'Local fixture CPU/storage contention and SDK end-to-end overhead only. No paid network calls; these numbers are not Jev or pi service latency and are not a scaling guarantee.':'Descriptive real-model measurements for this machine, database and workload. Provider contention is included; no generalized throughput guarantee.',
   primaryRepetition:0,primaryFieldsNote:'Top-level standalone/concurrent/comparison retain repetition zero for compatibility; they are not aggregate statistics.',standalone:primary.standalone,concurrent:primary.concurrent,comparison:primary.comparison,
   repetitions,descriptiveSummary:{interpretation:'Observed minimum, maximum and arithmetic mean across completed repetitions. These ranges are descriptive variability, not statistical confidence intervals. One repetition cannot estimate repeat variability.',completedRepetitions:repetitions.filter(r=>r.status==='completed').length,p50LatencyRatio:describe('p50LatencyRatio'),p95LatencyRatio:describe('p95LatencyRatio'),p99LatencyRatio:describe('p99LatencyRatio'),throughputRatio:describe('throughputRatio'),timeoutRateDifference:describe('timeoutRateDifference'),stoppedRateDifference:describe('stoppedRateDifference')}};
  await emitReport(report,options.output);if(status!=='completed')process.exitCode=1;
 } finally {await rm(directory,{recursive:true,force:true});}
}
if(isMainThread)main().catch(error=>{process.stderr.write(JSON.stringify({status:'not_executed',error:error.message})+'\n');process.exitCode=1;});
else workerMain().then(result=>parentPort.postMessage({type:'result',result}),error=>{parentPort.postMessage({type:'result',result:{status:'incomplete',failureCode:error.code??'WORKER_FAILURE'}});parentPort.postMessage({type:'ready'});});
