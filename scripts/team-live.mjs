#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
 DuelLoop, DuelLoopError, SqliteStore, KuhnPokerDomain, KuhnEvaluationAdapter,
 PiResearchProvider, ResearchOrchestrator, createKuhnStrategy, digest,
} from 'duelloop';
import { configuredModel, usageAccumulator, addUsage } from './m0.mjs';

function boundedEnv(name,fallback,maximum) {
 const value=Number(process.env[name]??fallback);
 if(!Number.isSafeInteger(value)||value<1||value>maximum)throw Error(`${name} must be an integer in [1, ${maximum}]`);
 return value;
}
async function main() {
 const args=process.argv.slice(2);if(args.some(arg=>arg!=='--check'))throw Error('Supported argument: --check (offline public-interface validation only)');
 const check=args.includes('--check');
 const researchMode=process.env.DUELLOOP_LIVE_RESEARCH_MODE??'team';
 if(!['single','team'].includes(researchMode))throw Error('DUELLOOP_LIVE_RESEARCH_MODE must be single or team');
 const comparisonPlan={id:'normal-baseline-single-team-v1',modes:['single','team'],baseline:'createKuhnStrategy schema 2.0; model decisions only',developmentSeeds:[131,137],finalHoldouts:{single:{id:'normal-single-independent-holdout-v1',seeds:[3203,3209,3217,3221]},team:{id:'normal-team-independent-holdout-v1',seeds:[2203,2213,2221,2237]}},maxFinalUsesPerMode:1,interpretation:'Two predeclared experiments with separate holdouts; one run per mode supports descriptive outcome/cost comparison only, not a statistical claim that a research mode is superior.'};
 const holdout=comparisonPlan.finalHoldouts[researchMode];
 if(!check&&process.env.DUELLOOP_TEAM_LIVE!=='1')throw Error('Real team experiment requires explicit DUELLOOP_TEAM_LIVE=1 and DUELLOOP_LIVE=1');
 const source=configuredModel(check);
 const piEnv=process.env.DUELLOOP_PI_KEY_ENV;
 if(!check&&(!process.env.DUELLOOP_PI_PROVIDER||!process.env.DUELLOOP_PI_MODEL||!piEnv||!process.env[piEnv]))throw Error('Explicit pi provider/model and a configured credential environment reference are required');
 const configuration={maxResearchCalls:6,maxTurns:boundedEnv('DUELLOOP_TEAM_MAX_TURNS',16,32),maxTokens:boundedEnv('DUELLOOP_TEAM_MAX_TOKENS',1000000,2000000),maxDecisionCalls:boundedEnv('DUELLOOP_TEAM_MAX_DECISION_CALLS',200,200),researchSeconds:boundedEnv('DUELLOOP_TEAM_RESEARCH_SECONDS',600,900),decisionMs:boundedEnv('DUELLOOP_TEAM_DECISION_MS',10000,30000),experienceSteps:12,maxRounds:2,maxRepairAttempts:1};
 if(configuration.decisionMs<=100)throw Error('DUELLOOP_TEAM_DECISION_MS must exceed the 100 ms execution reserve');
 const root=check?null:resolve(process.env.DUELLOOP_TEAM_OUTPUT_DIR??join('artifacts','team-live'));
 const output=root?join(root,researchMode,new Date().toISOString().replaceAll(':','-')):null;
 if(output)await mkdir(output,{recursive:true,mode:0o700});
 const store=new SqliteStore(root?join(root,`${researchMode}-evidence.sqlite`):':memory:');
 const controller=new AbortController();
 const decisionUsage=usageAccumulator(),researchUsage=usageAccumulator();
 let decisionCalls=0,orchestrator,runId;
 const roleRuns=[];
 const model={id:source.id,kind:source.kind,behaviorIdentity:source.behaviorIdentity,score:async input=>{
  if(controller.signal.aborted)throw new DuelLoopError('CANCELLED','Team experiment cancelled');
  if(decisionCalls>=configuration.maxDecisionCalls)throw new DuelLoopError('BUDGET_EXHAUSTED','Team decision-call budget exhausted');
  decisionCalls++;
  try {const answer=await source.score({...input,signal:AbortSignal.any([input.signal,controller.signal])});addUsage(decisionUsage,answer.usage);return answer;}
  catch(error){addUsage(decisionUsage,error.context?.usage);throw error;}
 }};
 const domain=new KuhnPokerDomain({applicationId:'team-live',scopeId:'team',seed:419,opponentId:'calling',knowledgeStateMode:'frozen',knowledge:{},decisionTimeoutMs:configuration.decisionMs});
 const policy={maxDecisionMs:configuration.decisionMs,executionReserveMs:100,randomSeed:'team-normal-baseline-v1'};
 const runtime=new DuelLoop({applicationId:'team-live',domain,model,store,mode:check?'offline':'simulation',executionOwner:'framework',...policy});
 const rawProvider=check?null:new PiResearchProvider({provider:process.env.DUELLOOP_PI_PROVIDER,model:process.env.DUELLOOP_PI_MODEL,apiKeyEnv:piEnv,baseURL:process.env.DUELLOOP_PI_BASE_URL,maxTurns:configuration.maxTurns});
 const provider={id:rawProvider?.id??'offline-team-interface-fixture',kind:rawProvider?.kind??'fixture',run:async input=>{
  const invocation={role:input.role,sessionId:input.sessionId,provider:provider.id,providerKind:provider.kind,startedAt:Date.now(),status:'running'};roleRuns.push(invocation);
  const prompt=input.prompt+'\nResearch phase contract: researcher and adversary report structured findings, uncertainties and counterexamples; reserve the final status=no_change conclusion for the integrator after all three roles have examined the evidence. No candidate is required when improvement is unsupported. Do not claim team consensus proves performance.';
  try {
   const answer=rawProvider?await rawProvider.run({...input,prompt,signal:AbortSignal.any([input.signal,controller.signal])}):{
    output:input.role==='integrator'?{status:'no_change',reason:'Offline interface check; no real research was performed'}:{analysis:'Fixture verifies role/session interfaces only'},usage:{inputTokens:0,outputTokens:0,costUsd:0,unknown:false},
   };
   addUsage(researchUsage,answer.usage);invocation.status='completed';invocation.finishedAt=Date.now();invocation.usage=answer.usage;
   invocation.sessionInfo=rawProvider?.sessionInfo(input.sessionId)??null;
   invocation.outputDigest=store.putArtifact('team_role_output',{runId:runId??null,role:input.role,sessionId:input.sessionId,output:answer.output,usage:answer.usage},'private');
   return answer;
  } catch(error){invocation.status='failed';invocation.finishedAt=Date.now();invocation.errorCode=error.code??'PROVIDER_ERROR';invocation.usage=error.context?.usage??{unknown:true};invocation.sessionInfo=rawProvider?.sessionInfo(input.sessionId)??null;addUsage(researchUsage,invocation.usage);throw error;}
 },releaseSession:async sessionId=>{await rawProvider?.releaseSession(sessionId);}};
 const baseline=createKuhnStrategy();
 // This is the ordinary illustrative baseline, not the deliberately reversed R2 capability fixture.
 const protocol={version:'3.0',id:`normal-${researchMode}-final-v1`,domainId:domain.id,seeds:holdout.seeds,opponentIds:['calling','tight','random'],trajectoriesPerSeed:2,knowledgeStateMode:'frozen',initialKnowledge:{},metric:{name:'reward',direction:'maximize',unit:'net chips per hand'},minSamples:4,minimumImprovement:.01,maxGroupRegression:.5,confidenceLevel:.95,maxP95DecisionComputeMs:configuration.decisionMs,maxDevelopmentEvalRuns:1,maxFinalEvaluationsPerRun:1,holdoutId:holdout.id,maxHoldoutUses:1};
 const developmentProtocol={...protocol,id:'normal-shared-development-v1',seeds:[131,137],opponentIds:['calling','tight'],minSamples:2,holdoutId:'normal-shared-development-only-v1'};
 const summary={schemaVersion:'2.0',experiment:researchMode==='team'?'same-model-three-isolated-team-roles':'single-model-shared-session-three-phases',status:'started',mode:check?'offline_interface_check':'real_research_experiment',researchMode,comparisonPlan,comparisonPlanDigest:digest(comparisonPlan),decisionModelKind:model.kind,researchProviderKind:provider.kind,models:{decision:model.id,research:provider.id},configuration,
  initialStrategyDigest:digest(baseline),
  evaluationScale:{development:{independentSeeds:2,opponents:2,handsPerBlock:2,strategyArms:2,maxRuns:1,maxDecisionCalls:32},final:{independentSeeds:4,opponents:3,handsPerBlock:2,strategyArms:2,maxRuns:1,maxDecisionCalls:96},experienceSteps:12,maximumPlannedDecisionCalls:140},
  protocolDigest:digest(protocol),developmentProtocolDigest:digest(developmentProtocol),roleRuns,outputDirectory:output,database:root?join(root,`${researchMode}-evidence.sqlite`):':memory:',activation:'candidate_only'};
 let writeQueue=Promise.resolve();
 const save=()=>{if(!output)return Promise.resolve();const text=JSON.stringify(summary,null,2)+'\n';writeQueue=writeQueue.then(()=>writeFile(join(output,'result.json'),text,{mode:0o600}));return writeQueue;};
 const abort=()=>{controller.abort();if(orchestrator&&runId)orchestrator.cancel(runId);summary.status='cancel_requested';void save().catch(()=>{});};
 process.once('SIGINT',abort);process.once('SIGTERM',abort);
 const totalSeconds=configuration.researchSeconds+Math.ceil(configuration.experienceSteps*configuration.decisionMs/1000)+60;
 const timer=setTimeout(abort,totalSeconds*1000);
 const started=performance.now();
 try {
  const active=store.activeRelease('team');
  if(active){if(store.release(active).strategyDigest!==digest(baseline)||digest(store.release(active).dependencies)!==digest(runtime.dependencies))throw new DuelLoopError('VERSION_INCOMPATIBLE','Existing team application differs from the frozen baseline/configuration; inspect its existing evidence');}
  else runtime.bootstrap(baseline,'team');
  store.setActivationMode('team','candidate_only');
  summary.phase='experience';await save();
  const stream=`experience-${Date.now()}`;
  for(let index=0;index<configuration.experienceSteps;index++) {
   if(controller.signal.aborted)throw new DuelLoopError('CANCELLED','Team experiment cancelled');
   if(decisionCalls>=configuration.maxDecisionCalls)throw new DuelLoopError('BUDGET_EXHAUSTED','Team decision budget exhausted during experience');
   const result=await runtime.step(stream);
   if(result.receipt?.status!=='completed')throw new DuelLoopError('EXECUTION_UNKNOWN','Experience action did not complete');
  }
  orchestrator=new ResearchOrchestrator({store,domain,model,evaluator:new KuhnEvaluationAdapter(policy),dependencies:runtime.dependencies,
   providers:{researcher:provider,adversary:provider,integrator:provider},mode:researchMode,maxRounds:configuration.maxRounds,
   budget:{maxWallTimeSeconds:configuration.researchSeconds,maxTokensTotal:configuration.maxTokens,maxModelCalls:configuration.maxResearchCalls,maxDecisionModelCalls:configuration.maxDecisionCalls,maxRepairAttempts:configuration.maxRepairAttempts}});
  const run=orchestrator.create({scopeId:'team',protocol,developmentProtocol});runId=run.id;
  summary.runId=run.id;summary.phase='research';summary.researchSnapshotId=run.researchSnapshotId;summary.baseReleaseDigest=run.baseReleaseDigest;await save();
  const result=await orchestrator.run(run.id);
  const expectedRoles=['researcher','adversary','integrator'];
  const sessionIdFor=role=>`${run.id}:${researchMode==='team'?role:'single'}`;
  const sessions=expectedRoles.map(role=>({role,sessionId:sessionIdFor(role),info:roleRuns.findLast(r=>r.sessionId===sessionIdFor(role))?.sessionInfo??{fixture:check,invoked:roleRuns.some(r=>r.role===role)},released:rawProvider?rawProvider.sessionInfo(sessionIdFor(role))===null:null}));
  const allRolesCompleted=expectedRoles.every(role=>roleRuns.some(invocation=>invocation.role===role&&invocation.status==='completed'));
  const distinctSessionCount=new Set(roleRuns.map(invocation=>invocation.sessionId)).size;
  const distinctSessions=distinctSessionCount===(researchMode==='team'?3:1);
  Object.assign(summary,{status:result.run.status,phase:'finished',researchError:result.run.data.error??null,counters:result.run.counters,submissionDigest:result.submissionDigest??null,validationDigest:result.validationDigest??null,finalEvidenceDigest:result.run.data.evidenceDigest??null,releaseDigest:result.releaseDigest??null,sessions,distinctSessionCount,researchSessionContract:allRolesCompleted&&distinctSessions?'demonstrated':'incomplete',teamSessionContract:researchMode==='team'?(allRolesCompleted&&distinctSessions?'demonstrated':'incomplete'):'not_applicable',validationReport:result.report??null,
   developmentEvaluationsExecuted:result.run.counters.developmentEvaluations??0,finalEvaluationsExecuted:result.run.counters.finalEvaluations??0,
   claim:check?'Offline fixture verified public interfaces and the selected session contract only. No real model acceptance.':'This run measures the selected research mode within controlled tools and budgets. no_change, rejection and insufficient evidence are valid research outcomes. Compare report outcomes, elapsed time, calls, tokens and known costs across the two predeclared modes descriptively; separate holdout seeds and one trial per mode cannot establish a team-performance advantage.'});
  if(check&&(result.run.status!=='no_change'||!allRolesCompleted||!distinctSessions))throw new DuelLoopError('VALIDATION_REJECTED','Offline team interface check failed');
  if(!check&&(['error','cancelled','budget_exhausted'].includes(result.run.status)||!allRolesCompleted||!distinctSessions))process.exitCode=1;
 } catch(error){summary.status=controller.signal.aborted?'cancelled':error.code==='BUDGET_EXHAUSTED'?'budget_exhausted':'error';summary.errorCode=error.code??'TEAM_EXPERIMENT_FAILURE';summary.errorMessage=error.message;process.exitCode=1;}
 finally {
  clearTimeout(timer);process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
  Object.assign(summary,{elapsedMs:performance.now()-started,decisionCalls,decisionUsageIncludingExperience:decisionUsage,researchUsage});
  await save();await rawProvider?.dispose();await runtime.close();store.close();await writeQueue;
 }
 process.stdout.write(JSON.stringify(summary,null,2)+'\n');
}
main().catch(error=>{process.stderr.write(JSON.stringify({status:'not_executed',error:error.message})+'\n');process.exitCode=1;});
