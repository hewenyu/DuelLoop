#!/usr/bin/env node
// Offline engineering experiment: synthetic durable history, real SDK paths, shared SQLite contention.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { DuelLoop, SqliteStore, KuhnPokerDomain, KuhnEvaluationAdapter, createKuhnStrategy, evaluateCandidate, digest, behaviorDependencies } from 'duelloop';
import { configuredModel, quantiles, emitReport } from './m0.mjs';
const now = () => performance.timeOrigin + performance.now();
const policy = { maxDecisionMs: 5000, executionReserveMs: 25 };
function parse(args) {
 const options = { history: [1000,10000,100000], steps: 300, repetitions: 2, slowRuns: 100, snapshotRecords: 1000, wallSeconds: 60, output: null };
 const flags = {'--history':'history','--steps':'steps','--repetitions':'repetitions','--slow-runs':'slowRuns','--snapshot-records':'snapshotRecords','--wall-seconds':'wallSeconds','--output':'output'};
 for (let i=0;i<args.length;i++) {
  const key = flags[args[i]]; if (!key || args[i+1]===undefined) throw Error(`Invalid option: ${args[i]}`);
  const value=args[++i]; options[key]=key==='output'?value:key==='history'?value.split(',').map(Number):Number(value);
 }
 if (!options.history.length || !options.history.every(n=>Number.isSafeInteger(n)&&n>=0)) throw Error('Invalid history sizes');
 for (const key of ['steps','repetitions','slowRuns','snapshotRecords','wallSeconds']) if (!Number.isSafeInteger(options[key])||options[key]<1) throw Error(`Invalid ${key}`);
 return options;
}
function setup(database) {
 const store = new SqliteStore(database), domain = new KuhnPokerDomain({applicationId:'history-benchmark',scopeId:'history',seed:11,opponentId:'calling'});
 const model = configuredModel(true), app = new DuelLoop({applicationId:'history-benchmark',domain,model,store,executionOwner:'framework',...policy});
 return {store,domain,model,app};
}
async function seed(database, count) {
 const {store,app}=setup(database); app.bootstrap(createKuhnStrategy(),'history');
 const {decision,receipt}=await app.step('seed-stream'); await app.close(); store.close();
 const db = new DatabaseSync(database); db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
 const addEvent=db.prepare('INSERT INTO events(type,scope_id,timestamp,visibility,data) VALUES(?,?,?,?,?)');
 const addIntent=db.prepare('INSERT INTO intents(decision_id,scope_id,stream_id,idem,data,status) VALUES(?,?,?,?,?,?)');
 const addArtifact=db.prepare('INSERT OR IGNORE INTO artifacts(digest,kind,visibility,data) VALUES(?,?,?,?)');
 const addFeedback=db.prepare('INSERT INTO feedback(scope_id,feedback_id,revision,received_at,data) VALUES(?,?,?,?,?)');
 const addLatest=db.prepare('INSERT INTO feedback_latest(scope_id,feedback_id,revision,received_at,event_id,data) VALUES(?,?,?,?,?,?)');
 const stamp=Date.now()-1000000;
 try {
  for(let offset=0;offset<count;offset+=500) {
   db.exec('BEGIN IMMEDIATE');
   for(let i=offset;i<Math.min(offset+500,count);i++) {
    const id=`history-${i}`,trajectoryId=`history-trajectory-${i}`;
    const observation={...decision.observation,trajectoryId,streamId:'fast-stream',revision:id,observedAt:stamp,deadline:stamp+5000};
    const archived={...decision,decisionId:id,observation,startedAt:stamp,finishedAt:stamp};
    const json=JSON.stringify(archived); addArtifact.run(digest(archived),'decision','public',json); addEvent.run('decision','history',stamp,'public',json);
    const command={decisionId:id,idempotencyKey:id,expectedStateRevision:id,observation,action:decision.action,deadline:stamp+5000,ownerToken:'synthetic-history'};
    const acknowledged={...receipt,decisionId:id,idempotencyKey:id,status:'completed',timestamp:stamp};
    addIntent.run(id,'history','fast-stream',id,JSON.stringify({decisionId:id,scopeId:'history',streamId:'fast-stream',ownerToken:'synthetic-history',command,receipt:acknowledged}),'completed');
    const feedback={feedbackId:id,revision:1,eventTime:stamp,receivedAt:stamp,applicationId:'history-benchmark',strategyScopeId:'history',trajectoryId,decisionId:id,metrics:{reward:0},settled:true};
    const feedbackJson=JSON.stringify(feedback); const event=addEvent.run('feedback.received','history',stamp,'public',feedbackJson);
    addFeedback.run('history',id,1,stamp,feedbackJson);addLatest.run('history',id,1,stamp,Number(event.lastInsertRowid),feedbackJson);
   }
   db.exec('COMMIT');
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 } catch(error){try{db.exec('ROLLBACK');}catch{}throw error;} finally{db.close();}
 return (await stat(database)).size;
}
function memory() { const {rss,heapUsed,external}=process.memoryUsage(); return {processRssBytes:rss,workerHeapUsedBytes:heapUsed,workerExternalBytes:external}; }
async function workerMain() {
 const {role,database,options,flag}=workerData,done=new Int32Array(flag);
 const {store,app,model,domain}=setup(database); const samples=[],experiments=[];
 let peak=memory(),before,diagnosticsBefore,startedAt,endedAt,failureCode=null;
 const sampleMemory=()=>{const current=memory();for(const key of Object.keys(peak))peak[key]=Math.max(peak[key],current[key]);};
 const metrics=new Map();app.subscribe(event=>{if(event.type==='runtime.step_completed'||event.type==='runtime.step_failed')metrics.set(event.data.decisionId??'failed',event.data);});
 try {
  if(role==='fast') for(let i=0;i<10;i++)await app.step('fast-stream');
  const start=new Promise(resolve=>parentPort.once('message',resolve));parentPort.postMessage({type:'ready'});await start;
  before=memory();peak={...before};diagnosticsBefore=store.diagnostics();startedAt=now();
  if(role==='fast') {
   for(let i=0;i<options.steps;i++) {
    const begin=now();
    try {const result=await app.step('fast-stream');const end=now();
     samples.push({startedAt:begin,endedAt:end,stepLatencyMs:end-begin,...metrics.get(result.decision.decisionId),receiptStatus:result.receipt?.status??null});
     // Public timing event ends before its own durable write; external elapsed includes that write.
     samples.at(-1).stepLatencyMs=end-begin;
     metrics.clear();if(result.receipt?.status==='unknown'){failureCode='EXECUTION_UNKNOWN';break;}
    } catch(error){failureCode=error.code??'RUNTIME_FAILURE';samples.push({startedAt:begin,endedAt:now(),stepLatencyMs:now()-begin,deadlineMiss:now()-begin>=policy.maxDecisionMs,failureCode});break;}
    if(i%20===0)sampleMemory();
   }
   Atomics.store(done,0,1);
  } else {
   const adapter=new KuhnEvaluationAdapter(policy),baseReleaseDigest=store.activeRelease('history');
   const baseline=store.getArtifact(store.release(baseReleaseDigest).strategyDigest),candidate=structuredClone(baseline);candidate.version='history-candidate';candidate.parentVersion=baseline.version;candidate.decision.defaultWeights.exposure=-.4;
   const protocol={version:'3.0',id:'history-development',domainId:domain.id,seeds:[701,703],opponentIds:['calling','tight'],trajectoriesPerSeed:8,knowledgeStateMode:'frozen',initialKnowledge:{},metric:{name:'reward',direction:'maximize',unit:'chips'},minSamples:2,minimumImprovement:0,maxGroupRegression:1,confidenceLevel:.95,maxP95DecisionComputeMs:5000,maxDevelopmentEvalRuns:options.slowRuns,maxFinalEvaluationsPerRun:1,holdoutId:'development-not-release-evidence',maxHoldoutUses:1};
   for(let i=0;i<options.slowRuns&&!Atomics.load(done,0);i++) {
    const begin=now(),snapshotStart=now();
    const snapshot=store.snapshot('history',Date.now(),{maxDecisions:options.snapshotRecords,maxFeedback:options.snapshotRecords});
    const snapshotMs=now()-snapshotStart;
    const report=await evaluateCandidate({baseline,candidate,model,adapter,protocol,dependencies:app.dependencies,baseReleaseDigest,stage:'development',signal:AbortSignal.timeout(options.wallSeconds*1000),onEvidence:e=>store.putArtifact('benchmark_evidence',{index:i,...e},'private')});
    store.putArtifact('benchmark_report',{index:i,snapshot,...report},'private');
    const snapshotBytes=Buffer.byteLength(JSON.stringify(store.getArtifact(snapshot)));
    experiments.push({startedAt:begin,endedAt:now(),snapshotMs,snapshotBytes,status:report.status});sampleMemory();
   }
  }
  endedAt=now();sampleMemory();
  const diagnostics=store.diagnostics();for(const key of ['writeTransactions','writeLockWaitMs'])diagnostics[key]-=diagnosticsBefore[key];
  return {role,status:failureCode?'incomplete':'completed',failureCode,startedAt,endedAt,samples,experiments,
   modelLatencyMs:quantiles(samples.map(x=>x.modelLatencyMs).filter(Number.isFinite)),decisionEndToEndLatencyMs:quantiles(samples.map(x=>x.decisionEndToEndLatencyMs).filter(Number.isFinite)),executionAckLatencyMs:quantiles(samples.map(x=>x.executionAckLatencyMs).filter(Number.isFinite)),stepLatencyMs:quantiles(samples.map(x=>x.stepLatencyMs)),
   deadlineMissRate:samples.length?samples.filter(x=>x.deadlineMiss).length/samples.length:null,timeoutRate:samples.length?samples.filter(x=>x.failureCode==='MODEL_TIMEOUT').length/samples.length:null,
   stoppedRate:samples.length?samples.filter(x=>x.failureCode).length/samples.length:null,memory:{before,peak,after:memory()},sqlite:diagnostics};
 } finally {await app.close();store.close();}
}
async function phase(database,options,concurrent) {
 const flag=new SharedArrayBuffer(4),entries=[];let timer;
 const spawn=role=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:{role,database,options,flag}});let readyResolve,readyReject,resultResolve,resultReject;
  const ready=new Promise((r,j)=>{readyResolve=r;readyReject=j;}),result=new Promise((r,j)=>{resultResolve=r;resultReject=j;});void ready.catch(()=>{});void result.catch(()=>{});
  worker.on('message',m=>{if(m.type==='ready')readyResolve();if(m.type==='result')resultResolve(m.result);});worker.on('error',e=>{readyReject(e);resultReject(e);});worker.on('exit',code=>{if(code){const e=Error(`Worker exited ${code}`);readyReject(e);resultReject(e);}});
  const entry={worker,ready,result};entries.push(entry);return entry;
 };
 const fast=spawn('fast'),slow=concurrent?spawn('slow'):null;
 try {return await Promise.race([(async()=>{
  await Promise.all(entries.map(x=>x.ready));entries.forEach(x=>x.worker.postMessage('start'));
  const [a,b]=await Promise.all([fast.result,slow?.result??null]);
  const overlap=a.samples?.filter(s=>b?.experiments?.some(e=>s.startedAt<e.endedAt&&s.endedAt>e.startedAt)).length??0;
  return {status:a.status==='completed'&&(!b||b.status==='completed'&&overlap>0)?'completed':'incomplete',fast:a,slow:b,concurrentSteps:overlap};
 })(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Benchmark wall budget exhausted')),options.wallSeconds*1000);})]);}
 finally{clearTimeout(timer);await Promise.all(entries.map(x=>x.worker.terminate()));}
}
async function main(){
 const options=parse(process.argv.slice(2)),directory=await mkdtemp(join(tmpdir(),'duelloop-history-')),measurements=[];
 try {
  for(const historyRecords of options.history)for(let repetition=0;repetition<options.repetitions;repetition++) {
   const order=repetition%2?['concurrent','standalone']:['standalone','concurrent'];
   for(const mode of order){
    const database=join(directory,`${historyRecords}-${repetition}-${mode}.sqlite`);
    process.stderr.write(`history=${historyRecords} repetition=${repetition+1} mode=${mode}: seeding\n`);
    const databaseBytes=await seed(database,historyRecords);
    const result=await phase(database,options,mode==='concurrent');
    measurements.push({historyRecords,repetition,mode,databaseBytes,...result});
    await rm(database,{force:true});await rm(database+'-wal',{force:true});await rm(database+'-shm',{force:true});
   }
  }
  const status=measurements.every(m=>m.status==='completed')?'completed':'incomplete';
  await emitReport({schemaVersion:'1.0',testedAt:new Date().toISOString(),dependencies:behaviorDependencies(new KuhnPokerDomain({applicationId:'history-benchmark',scopeId:'history',seed:11,opponentId:'calling'}),configuredModel(true),policy),strategyDigest:digest(createKuhnStrategy()),experiment:'history-scaled-sdk-with-concurrent-snapshot-and-evaluation',status,modelKind:'fixture',configuration:options,machine:{node:process.version,platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model},
   definitions:{modelLatencyMs:'await model.score',decisionEndToEndLatencyMs:'step entry through observe, candidate/release checks, model, score combination and durable decision',executionAckLatencyMs:'execute entry through re-observe, intent, domain execution and durable receipt',stepLatencyMs:'external monotonic clock around complete step, including feedback, activation scheduling and telemetry write',deadlineMissRate:'steps finishing past SDK deadline (also includes feedback and activation scheduling)',sqlite:'BEGIN IMMEDIATE acquisition elapsed includes statement overhead and lock waiting, not exclusively blocking time',memory:'heap/external per worker isolate; RSS covers entire process and is shared between threads'},
   limitations:['Offline engineering measurements only; no Jev/pi quality, latency or improvement claims.','Historical records are synthetic copies of one genuine fixture SDK decision, with unique identities and completed receipts.','Each phase starts with a fresh on-disk WAL database; repeated snapshot windows are bounded, not full history.','Slow workload runs snapshots and development evaluation, not paid research or final holdout consumption.','Sampled peak memory is descriptive and may miss short transients.'],measurements},options.output);
  if(status!=='completed')process.exitCode=1;
 } finally {await rm(directory,{recursive:true,force:true});}
}
if(isMainThread)main().catch(e=>{process.stderr.write(e.stack+'\n');process.exitCode=1;});
else workerMain().then(result=>parentPort.postMessage({type:'result',result}),e=>{parentPort.postMessage({type:'result',result:{status:'incomplete',failureCode:e.code??e.message}});parentPort.postMessage({type:'ready'});});
