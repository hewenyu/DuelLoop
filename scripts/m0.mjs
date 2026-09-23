#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JevDecisionModel, FixtureDecisionModel, KuhnPokerDomain, createKuhnStrategy, buildQuestions, evaluateAnswers, seededRandom, withDeadline, digest } from 'duelloop';

export function quantiles(values) {
  const ordered=[...values].sort((a,b)=>a-b);
  const at=p=>ordered.length?ordered[Math.max(0,Math.ceil(ordered.length*p)-1)]:null;
  return {p50:at(.5),p95:at(.95),p99:at(.99)};
}
export function parseArguments(args) {
 const options={fixture:false,seeds:[11,29,47],opponents:['calling','tight','random'],hands:20,timeoutMs:5000,maxCalls:1000,output:null};
 const names={'--seeds':'seeds','--opponents':'opponents','--hands':'hands','--timeout-ms':'timeoutMs','--max-calls':'maxCalls','--output':'output'};
 for(let i=0;i<args.length;i++) {
  if(args[i]==='--fixture'){options.fixture=true;continue;}
  const key=names[args[i]];if(!key || args[i+1]===undefined) throw Error(`Unsupported or incomplete argument: ${args[i]}`);
  const raw=args[++i];options[key]=key==='seeds'?raw.split(',').map(Number):key==='opponents'?raw.split(','):key==='output'?raw:Number(raw);
 }
 for(const key of ['hands','timeoutMs','maxCalls']) if(!Number.isSafeInteger(options[key]) || options[key]<1)throw Error(`${key} must be a positive integer`);
 if(!options.seeds.length || options.seeds.some(x=>!Number.isSafeInteger(x)) || new Set(options.seeds).size!==options.seeds.length)throw Error('Seeds must be distinct integers');
 if(!options.opponents.length || options.opponents.some(x=>!['calling','tight','random','adaptive'].includes(x)) || new Set(options.opponents).size!==options.opponents.length)throw Error('Unsupported or repeated opponent');
 return options;
}
export function makeFixtureModel() {
 const model=new FixtureDecisionModel('visible-state-fixture-not-real-jev',(question,state)=>{
  const action=state.candidates.find(a=>a.id===question.actionId);
  const commits=['bet','call'].includes(action.kind),strong=state.features['self.card']==='K';
  const score=question.dimensionId==='gain'?(strong===commits?4:1):(commits&&!strong?4:0);
  return {score,confidence:1,probabilities:Object.fromEntries(question.criteria.map((_,i)=>[i,Number(i===score)]))};
 });
 model.choice=async({state,candidates})=>{
  const strong=state.features['self.card']==='K';
  const preferred=strong?(Object.hasOwn(candidates,'call')?'call':'bet'):(Object.hasOwn(candidates,'fold')?'fold':'check');
  return {actionId:preferred,confidence:1,probabilities:Object.fromEntries(Object.keys(candidates).map(id=>[id,Number(id===preferred)])),model:model.id,usage:{inputTokens:0,outputTokens:0,costUsd:0,unknown:false}};
 };
 return model;
}
export function configuredModel(fixture) {
 if(fixture)return makeFixtureModel();
 const keyEnv=process.env.DUELLOOP_JEV_KEY_ENV??'TYPESAFE_API_KEY';
 if(process.env.DUELLOOP_LIVE!=='1')throw Error('Paid model calls require explicit DUELLOOP_LIVE=1; use --fixture for offline mechanism checks');
 if(!process.env[keyEnv] || !process.env.DUELLOOP_JEV_MODEL)throw Error('Set DUELLOOP_JEV_MODEL and the credential referenced by DUELLOOP_JEV_KEY_ENV (default TYPESAFE_API_KEY)');
 return new JevDecisionModel({model:process.env.DUELLOOP_JEV_MODEL,apiKeyEnv:keyEnv,baseURL:process.env.DUELLOOP_JEV_BASE_URL,timeoutMs:60000});
}
export function usageAccumulator() {return {inputTokens:0,outputTokens:0,knownCostUsd:0,unknownTokenUsage:false,unknownCost:false};}
export function addUsage(total,usage) {
 if(!usage || usage.unknown || usage.inputTokens===undefined || usage.outputTokens===undefined)total.unknownTokenUsage=true;
 total.inputTokens+=usage?.inputTokens??0;total.outputTokens+=usage?.outputTokens??0;
 if(usage?.costUsd===undefined || usage?.unknown)total.unknownCost=true;
 total.knownCostUsd+=usage?.costUsd??0;
}
export async function episode(path,seed,opponentId,options,model,budget) {
 if(!['jev_choice','jev_score'].includes(path))throw Error('M0 supports only explicit model decision paths');
 const domain=new KuhnPokerDomain({applicationId:'m0',scopeId:'m0',seed,opponentId,knowledge:{},knowledgeStateMode:'frozen',decisionTimeoutMs:options.timeoutMs+250});
 const strategy=createKuhnStrategy(),random=seededRandom(`${seed}:selection`);
 const started=performance.now(),times=[],settled=new Set();
 let reward=0,modelCalls=0,stoppedDecisions=0,timeouts=0;
 const usage=usageAccumulator();let failureCode=null;
 try {
 while(settled.size<options.hands) {
  const begin=performance.now(),observation=await domain.observe('table'),candidates=await domain.candidates(observation);
  if(!candidates.length)throw Object.assign(Error('No legal candidates'),{code:'NO_LEGAL_ACTION'});
  if(budget.used>=options.maxCalls)throw Object.assign(Error('M0 model call limit reached'),{code:'BUDGET_EXHAUSTED'});
  let action,responseUsageRecorded=false;
  try {
   const request=buildQuestions(strategy,observation,candidates,domain);
   budget.used++;modelCalls++;
   if(path==='jev_choice') {
    const answer=await withDeadline(observation.deadline-250,signal=>model.choice({state:request.state,instructions:'Choose the legal action with the best expected net chips through the end of this Kuhn hand, following the documented reference continuation. Use only visible facts.',candidates:Object.fromEntries(candidates.map(c=>[c.id,{kind:c.kind,parameters:c.parameters}])),signal}));
    addUsage(usage,answer.usage);responseUsageRecorded=true;
    if(answer.model!==model.id)throw Object.assign(Error('Model version changed'),{code:'VERSION_INCOMPATIBLE'});
    if(!Number.isFinite(answer.confidence)||answer.confidence<0||answer.confidence>1)throw Object.assign(Error('Invalid confidence'),{code:'MODEL_INVALID'});
    action=candidates.find(c=>c.id===answer.actionId);if(!action)throw Object.assign(Error('Illegal model action'),{code:'MODEL_INVALID'});
   } else {
    const answer=await withDeadline(observation.deadline-250,signal=>model.score({...request,signal}));
    addUsage(usage,answer.usage);responseUsageRecorded=true;
    if(answer.model!==model.id)throw Object.assign(Error('Model version changed'),{code:'VERSION_INCOMPATIBLE'});
    action=evaluateAnswers(strategy,observation,candidates,answer.answers,random).action;
   }
  } catch(error) {
   // Stop this experiment. A rejected response never becomes a program-selected action.
   if(!responseUsageRecorded)addUsage(usage,error.context?.usage);
   throw error;
  }
  const decisionId=`m0:${path}:${seed}:${opponentId}:${times.length}`;
  const receipt=await domain.execute({decisionId,idempotencyKey:decisionId,expectedStateRevision:observation.revision,observation,action,deadline:observation.deadline});
  if(receipt.status!=='completed')throw Error('M0 action did not complete');
  times.push(performance.now()-begin);
  for(const feedback of await domain.feedback())if(feedback.settled&&!settled.has(feedback.feedbackId)){settled.add(feedback.feedbackId);reward+=feedback.metrics.reward;}
  if(times.length>options.hands*3)throw Error('Kuhn trajectory failed to settle');
 }
 } catch(error){failureCode=error.code??'EXPERIMENT_ERROR';stoppedDecisions=1;if(failureCode==='MODEL_TIMEOUT')timeouts=1;}
 const elapsedMs=performance.now()-started;
 return {status:failureCode?'incomplete':'completed',failureCode,seed,opponentId,path,hands:settled.size,rewardPerHand:settled.size?reward/settled.size:null,decisions:times.length,modelCalls,stoppedDecisions,timeouts,elapsedMs,decisionsPerSecond:times.length/(elapsedMs/1000),latencyMs:quantiles(times),rawLatencyMs:times,usage};
}
export async function runM0(options) {
 const model=configuredModel(options.fixture),blocks=[],budget={used:0};const started=new Date().toISOString();
 let status='completed',failureCode=null;
 outer:for(const seed of options.seeds)for(const opponent of options.opponents)for(const path of ['jev_choice','jev_score']) {
  try {const block=await episode(path,seed,opponent,options,model,budget);blocks.push(block);if(block.status!=='completed'){status='incomplete';failureCode=block.failureCode;break outer;}}
  catch(error){status='incomplete';failureCode=error.code??'EXPERIMENT_ERROR';break outer;}
 }
 const paths=Object.fromEntries(['jev_choice','jev_score'].map(path=>{
  const values=blocks.filter(b=>b.path===path),decisions=values.reduce((s,b)=>s+b.decisions,0),duration=values.reduce((s,b)=>s+b.elapsedMs,0);
  const usage=usageAccumulator();for(const v of values){usage.inputTokens+=v.usage.inputTokens;usage.outputTokens+=v.usage.outputTokens;usage.knownCostUsd+=v.usage.knownCostUsd;usage.unknownTokenUsage||=v.usage.unknownTokenUsage;usage.unknownCost||=v.usage.unknownCost;}
  return [path,{completedBlocks:values.filter(v=>v.status==='completed').length,hands:values.reduce((s,b)=>s+b.hands,0),meanRewardPerHand:values.reduce((s,b)=>s+b.hands,0)?values.reduce((s,b)=>s+(b.rewardPerHand??0)*b.hands,0)/values.reduce((s,b)=>s+b.hands,0):null,decisions,modelCalls:values.reduce((s,b)=>s+b.modelCalls,0),stoppedDecisions:values.reduce((s,b)=>s+b.stoppedDecisions,0),timeouts:values.reduce((s,b)=>s+b.timeouts,0),decisionsPerSecond:duration?decisions/(duration/1000):null,latencyMs:quantiles(values.flatMap(b=>b.rawLatencyMs)),usage}];
 }));
 return {schemaVersion:'2.0',experiment:'M0-two-model-path-control',status,failureCode,modelCallsAttempted:budget.used,modelKind:model.kind,model:model.id,startedAt:started,node:process.version,platform:process.platform,conditions:{seeds:options.seeds,opponents:options.opponents,handsPerBlock:options.hands,knowledgeStateMode:'frozen',initialKnowledge:{},timeoutMs:options.timeoutMs,maxModelCalls:options.maxCalls,strategyDigest:digest(createKuhnStrategy()),environment:'Kuhn Poker simulation; every path receives an independent initial environment/knowledge/opponent instance'},claim:options.fixture?'Offline fixture mechanism/timing only; no real Jev latency or playing-strength claim':'Descriptive measurements on declared seeds/opponents; no independent holdout or production transfer claim',paths,blocks};
}
export async function emitReport(report,output) {
 const text=JSON.stringify(report,null,2)+'\n';
 if(output){await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,text,{mode:0o600});}
 process.stdout.write(text);
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 try {const options=parseArguments(process.argv.slice(2));const report=await runM0(options);await emitReport(report,options.output);if(report.status!=='completed')process.exitCode=1;}
 catch(error){process.stderr.write(JSON.stringify({status:'not_executed',error:error.message})+'\n');process.exitCode=1;}
}
