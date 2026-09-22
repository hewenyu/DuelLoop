import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
 DuelLoop, SqliteStore, JevDecisionModel, PiResearchProvider, KuhnPokerDomain,
 KuhnEvaluationAdapter, createKuhnStrategy, ResearchOrchestrator,
 buildQuestions, evaluateAnswers, digest, diffStrategies, DuelLoopError, withDeadline,
} from 'duelloop';

const keyEnv=process.env.DUELLOOP_JEV_KEY_ENV??'TYPESAFE_API_KEY';
const piKeyEnv=process.env.DUELLOOP_PI_KEY_ENV;
const enabled=process.env.DUELLOOP_LIVE==='1' && process.env.DUELLOOP_LIVE_CLOSED_LOOP==='1';
const configured=process.env[keyEnv] && process.env.DUELLOOP_JEV_MODEL && process.env.DUELLOOP_PI_PROVIDER && process.env.DUELLOOP_PI_MODEL && piKeyEnv && process.env[piKeyEnv];
function positiveEnv(name,fallback) {const n=Number(process.env[name]??fallback);assert.ok(Number.isSafeInteger(n)&&n>0,`${name} must be a positive integer`);return n;}
function unitEnv(name,fallback) {const n=Number(process.env[name]??fallback);assert.ok(Number.isFinite(n)&&n>=0&&n<=1,`${name} must be in [0, 1]`);return n;}
function distributionsDiffer(left,right,tolerance=1e-9) {
 return [...new Set([...Object.keys(left),...Object.keys(right)])].some(action=>Math.abs((left[action]??0)-(right[action]??0))>tolerance);
}
const experienceSteps=positiveEnv('DUELLOOP_LIVE_EXPERIENCE_STEPS',30);
const postSteps=positiveEnv('DUELLOOP_LIVE_POST_STEPS',20);
const decisionMs=positiveEnv('DUELLOOP_LIVE_DECISION_MS',10000);
const researchSeconds=positiveEnv('DUELLOOP_LIVE_RESEARCH_SECONDS',900);
// Each post step may require a separate old-question request. Cleanup has an additional minute.
const defaultTimeoutSeconds=Math.ceil((experienceSteps+2*postSteps)*decisionMs/1000)+researchSeconds+60;

// This is a separately opted-in, paid experiment. A normal no_change/rejection is not R2 acceptance.
test('LIVE R2: autonomous pi proposal → independent real-Jev evaluation → release → subsequent SDK actions',{
 skip:!enabled || !configured?'Not executed: explicit DUELLOOP_LIVE=1, DUELLOOP_LIVE_CLOSED_LOOP=1, model names and both credentials required':false,
 timeout:positiveEnv('DUELLOOP_LIVE_TIMEOUT_SECONDS',defaultTimeoutSeconds)*1000,
},async t=>{
 const experimentRoot=resolve(process.env.DUELLOOP_LIVE_OUTPUT_DIR??join('artifacts','live-closed-loop'));
 const output=join(experimentRoot,new Date().toISOString().replaceAll(':','-'));
 await mkdir(output,{recursive:true,mode:0o700});
 const initialPolicyKind=process.env.DUELLOOP_LIVE_INITIAL_POLICY??'inverted_weights';
 assert.ok(['inverted_weights','passive'].includes(initialPolicyKind),'DUELLOOP_LIVE_INITIAL_POLICY must be inverted_weights or passive');
 const scopeId=initialPolicyKind==='passive'?'controlled-passive':'controlled';
 const maxDecisionCalls=positiveEnv('DUELLOOP_LIVE_MAX_DECISION_CALLS',1200);
 const maxTokens=positiveEnv('DUELLOOP_LIVE_MAX_TOKENS',600000);
 const handsPerSeed=positiveEnv('DUELLOOP_LIVE_HANDS_PER_SEED',8);
 const maxDecisionMs=decisionMs;
 const initialMinRequiredConfidence=unitEnv('DUELLOOP_LIVE_MIN_CONFIDENCE',.55);
 const rawModel=new JevDecisionModel({model:process.env.DUELLOOP_JEV_MODEL,apiKeyEnv:keyEnv,baseURL:process.env.DUELLOOP_JEV_BASE_URL,timeoutMs:maxDecisionMs});
 let decisionCalls=0;
 const model={id:rawModel.id,kind:'real',score:async input=>{
  if(t.signal.aborted)throw new DuelLoopError('CANCELLED','Live acceptance cancelled');
  if(decisionCalls>=maxDecisionCalls)throw new DuelLoopError('BUDGET_EXHAUSTED','Real decision call budget exhausted');
  decisionCalls++;
  return rawModel.score({...input,signal:AbortSignal.any([input.signal,t.signal])});
 }};
 const provider=new PiResearchProvider({provider:process.env.DUELLOOP_PI_PROVIDER,model:process.env.DUELLOOP_PI_MODEL,apiKeyEnv:piKeyEnv,baseURL:process.env.DUELLOOP_PI_BASE_URL,maxTurns:positiveEnv('DUELLOOP_LIVE_PI_MAX_TURNS',16)});
 const abortableProvider={id:provider.id,kind:provider.kind,run:input=>provider.run({...input,signal:AbortSignal.any([input.signal,t.signal])})};
 const domain=new KuhnPokerDomain({applicationId:'live-closed-loop',scopeId,seed:811,opponentId:'calling',knowledgeStateMode:'frozen',knowledge:{},decisionTimeoutMs:maxDecisionMs});
 const store=new SqliteStore(join(experimentRoot,'evidence.sqlite'));
 const runtime=new DuelLoop({applicationId:'live-closed-loop',domain,model,store,mode:'simulation',executionOwner:'framework',maxDecisionMs,executionReserveMs:100,randomSeed:'r2-controlled-v1'});
 // Deliberately defective initial utility, not a hand-written candidate. No correction is supplied to pi.
 // The passive condition uses a separate scope in the SAME database and shares the final holdout quota.
 const baseline=createKuhnStrategy();baseline.decision.defaultWeights=initialPolicyKind==='passive'?{gain:0,exposure:0}:{gain:-1,exposure:.8};baseline.version=initialPolicyKind==='passive'?'controlled-passive-v1':'controlled-v1';
 baseline.decision.minRequiredConfidence=initialMinRequiredConfidence;
 baseline.provenance.hypothesis='Controlled capability experiment initial policy, not a production baseline';
 const summary={schemaVersion:'1.1',experiment:'real-autonomous-closed-loop',status:'started',R2:'not_demonstrated',decisionModelKind:'real',researchProviderKind:'real',environment:'Kuhn Poker simulation',models:{decision:model.id,research:provider.id},artifactsDirectory:output,initialPolicyKind,scopeId,initialMinRequiredConfidence,
  budgets:{experienceSteps,postSteps,maxDecisionMs,maxDecisionCalls,maxTokens,researchSeconds,testTimeoutSeconds:positiveEnv('DUELLOOP_LIVE_TIMEOUT_SECONDS',defaultTimeoutSeconds),oldQuestionComparisonsShareDecisionCallBudget:true},evaluationScale:{handsPerSeed,developmentSeeds:3,developmentOpponents:2,finalSeeds:6,finalOpponents:3,maxDevelopmentEvaluations:2,maxFinalEvaluations:1}};
 let writeQueue=Promise.resolve();
 const save=()=>{const content=JSON.stringify(summary,null,2)+'\n';writeQueue=writeQueue.then(()=>writeFile(join(output,'result.json'),content,{mode:0o600}));return writeQueue;};
 let orchestrator,runId;
 const onAbort=()=>{
  if(orchestrator&&runId)orchestrator.cancel(runId);
  summary.status='cancel_requested';summary.errorCode='CANCELLED';summary.decisionCalls=decisionCalls;
  void save().catch(()=>{});
  void runtime.stop({drain:false}).catch(()=>{});
 };
 t.signal.addEventListener('abort',onAbort,{once:true});
 const ensureActive=()=>{if(t.signal.aborted)throw new DuelLoopError('CANCELLED','Live acceptance cancelled');};
 try {
  ensureActive();
  const existing=store.activeRelease(scopeId);
  if(existing)assert.equal(store.release(existing).strategyDigest,digest(baseline),'Controlled application already advanced or initial calibration changed; inspect its existing evidence instead of resetting the holdout');
  const baseReleaseDigest=existing??runtime.bootstrap(baseline,scopeId);
  const before=[];
  const experienceStream=`experience-${Date.now()}`;
  summary.phase='experience';await save();
  for(let i=0;i<experienceSteps;i++) {
   ensureActive();
   if(decisionCalls>=maxDecisionCalls)throw new DuelLoopError('BUDGET_EXHAUSTED','Decision budget exhausted during experience collection');
   const {decision,receipt}=await runtime.step(experienceStream);before.push(decision);
   assert.equal(receipt?.status,'completed','Evidence collection must execute and settle real simulated actions');
  }
  assert.ok(before.some(d=>d.decisionSource==='strategy'&&d.modelKind==='real'),'No real Jev decisions available for research');
  const protocol={version:'1.0',id:initialPolicyKind==='passive'?'controlled-passive-final-v1':'controlled-final-v1',domainId:domain.id,
   seeds:[1009,2003,3001,4001,5003,6007],opponentIds:['calling','tight','random'],
   trajectoriesPerSeed:handsPerSeed,
   knowledgeStateMode:'frozen',initialKnowledge:{},metric:{name:'reward',direction:'maximize',unit:'net chips per hand'},
   minSamples:6,minimumImprovement:0,maxGroupRegression:.5,confidenceLevel:.95,maxFallbackRate:.2,maxP95LatencyMs:maxDecisionMs,
   maxDevelopmentEvalRuns:2,maxFinalEvaluationsPerRun:1,holdoutId:'controlled-independent-holdout-v1',maxHoldoutUses:1};
  const developmentProtocol={...protocol,id:initialPolicyKind==='passive'?'controlled-passive-development-v1':'controlled-development-v1',seeds:[31,73,113],minSamples:3,opponentIds:['calling','tight'],holdoutId:'controlled-development-only'};
  orchestrator=new ResearchOrchestrator({store,domain,model,evaluator:new KuhnEvaluationAdapter({maxDecisionMs,executionReserveMs:100,randomSeed:'r2-controlled-v1'}),dependencies:runtime.dependencies,providers:{researcher:abortableProvider},mode:'single',maxRounds:2,budget:{maxWallTimeSeconds:researchSeconds,maxTokensTotal:maxTokens,maxModelCalls:8,maxDecisionModelCalls:maxDecisionCalls,maxRepairAttempts:1}});
  const run=orchestrator.create({scopeId,protocol,developmentProtocol});runId=run.id;
  summary.phase='research';summary.runId=run.id;summary.baseReleaseDigest=baseReleaseDigest;summary.researchSnapshotId=run.researchSnapshotId;summary.evaluationProtocolDigest=run.evaluationProtocolDigest;
  await save();ensureActive();
  const result=await orchestrator.run(run.id);
  Object.assign(summary,{status:result.run.status,researchStatus:result.run.status,researchError:result.run.data.error??null,decisionCalls,counters:result.run.counters,submissionDigest:result.submissionDigest??null,validationDigest:result.validationDigest??null,evidenceDigest:result.run.data.evidenceDigest??null,releaseDigest:result.releaseDigest??null});
  if(['error','cancelled'].includes(result.run.status)){await save();assert.fail(`Real closed-loop run did not complete: ${result.run.status}; inspect protected evidence in ${output}`);}
  if(result.run.status!=='completed_passed') {
   summary.explanation='The system completed without a verified update. This can be a correct research outcome, but does not prove controlled R2 update capability.';await save();
   t.skip(`R2 not demonstrated: ${result.run.status}. Evidence: ${join(output,'result.json')}`);return;
  }
  ensureActive();assert.equal(result.report.modelKind,'real');assert.ok(result.releaseDigest);assert.ok(result.validationDigest);
  const submission=store.getArtifact(result.submissionDigest);
  assert.equal(submission.strategy.provenance.researchRunId,run.id);assert.notEqual(digest(submission.strategy),digest(baseline));
  assert.ok(store.events({scopeId}).some(e=>e.type==='research.role_output'&&e.data.providerKind==='real'));
  await runtime.activate(result.releaseDigest,true);assert.equal(store.activeRelease(scopeId),result.releaseDigest);
  summary.phase='post_activation';
  const after=[],comparisons=[],comparisonIssues=[];
  let postObservationStatus='completed';
  for(let i=0;i<postSteps;i++) {
   ensureActive();
   if(decisionCalls>=maxDecisionCalls){postObservationStatus='budget_exhausted';break;}
   const {decision,receipt}=await runtime.step(`after-${run.id}`);after.push(decision);
   assert.equal(decision.releaseDigest,result.releaseDigest);assert.equal(receipt?.status,'completed');
   if(decision.decisionSource!=='strategy')continue;
   const oldQuestions=buildQuestions(baseline,decision.observation,decision.candidates,domain);
   const newQuestions=buildQuestions(submission.strategy,decision.observation,decision.candidates,domain);
   let oldAnswers=decision.answers,referenceResponseDigest=null,comparisonMode='same_questions_same_answers_interpreter';
   if(oldQuestions.questionDigest!==newQuestions.questionDigest) {
    // Changed semantics need a separate real old-question response on the SAME visible observation.
    if(decisionCalls>=maxDecisionCalls){postObservationStatus='budget_exhausted';comparisonIssues.push({decisionId:decision.decisionId,reason:'No budget for old-question reference response'});break;}
    try {
     const reference=await withDeadline(Date.now()+maxDecisionMs,signal=>model.score({...oldQuestions,signal}),t.signal);
     referenceResponseDigest=store.putArtifact('r2_old_question_response',{runId:run.id,decisionId:decision.decisionId,questionDigest:oldQuestions.questionDigest,modelKind:'real',...reference},'private');
     assert.equal(reference.model,model.id,'Old-question reference response changed model version');
     oldAnswers=reference.answers;comparisonMode='same_observation_separate_real_question_responses';
    } catch(error) {
     if(t.signal.aborted)throw error;
     comparisonIssues.push({decisionId:decision.decisionId,reason:error.code??'REFERENCE_RESPONSE_FAILURE'});
     if(error.code==='BUDGET_EXHAUSTED'){postObservationStatus='budget_exhausted';break;}
     continue;
    }
   }
   try {
    const old=evaluateAnswers(baseline,decision.observation,decision.candidates,oldAnswers,()=>.5);
    const distributionChanged=distributionsDiffer(old.probabilities,decision.probabilities);
    comparisons.push({decisionId:decision.decisionId,comparisonMode,referenceResponseDigest,baseAction:old.action.id,actualCandidateAction:decision.action.id,sampledActionsDiffer:old.action.id!==decision.action.id,distributionChanged,baseProbabilities:old.probabilities,candidateProbabilities:decision.probabilities});
   } catch(error){comparisonIssues.push({decisionId:decision.decisionId,reason:error.code??'BASELINE_RESPONSE_NOT_COMPARABLE'});}
  }
  const behaviorChangeObserved=comparisons.some(c=>c.distributionChanged);
  const samplingComplete=postObservationStatus==='completed'&&after.length===postSteps&&after.some(d=>d.decisionSource==='strategy'&&d.modelKind==='real');
  const demonstrated=behaviorChangeObserved&&samplingComplete;
  Object.assign(summary,{R2:demonstrated?'demonstrated_in_controlled_simulation':'partially_demonstrated',postObservationStatus,decisionCalls,strategyDiff:diffStrategies(baseline,submission.strategy),laterDecisionIds:after.map(d=>d.decisionId),behaviorComparisons:comparisons,comparisonIssues,claim:'Real pi independently submitted the candidate; real Jev evaluation authorized activation. Behavior evidence compares full action distributions on the same observed state. Identical questions reuse identical answers; changed questions use separate real old-question responses. These comparisons are not payoff or repeatability evidence; payoff evidence remains the independent paired experiment. No production transfer claim.'});
  await save();
  if(!demonstrated)t.skip(`Update validated and activated, but the declared post-activation behavior check is incomplete or has no observed distribution change (${postObservationStatus}); R2 remains partial. Evidence: ${output}`);
  else t.diagnostic(`R2 controlled evidence saved to ${join(output,'result.json')}`);
 } catch(error) {
  summary.status=t.signal.aborted?'cancelled':error.code==='BUDGET_EXHAUSTED'?'budget_exhausted':'error';summary.errorCode=error.code??'ASSERTION_OR_EXPERIMENT_FAILURE';summary.errorMessage=error.message;summary.decisionCalls=decisionCalls;await save();
  if(error.code==='BUDGET_EXHAUSTED'&&!t.signal.aborted){t.skip(`R2 budget exhausted before complete evidence. See ${output}`);return;}
  throw error;
 } finally {t.signal.removeEventListener('abort',onAbort);await provider.dispose();await runtime.close();store.close();await writeQueue;}
});

test('R2 behavior evidence compares distributions, not independent random action draws',()=>{
 const baseline={action:'check',probabilities:{check:.5,bet:.5}};
 const sameDistribution={action:'bet',probabilities:{check:.5,bet:.5}};
 assert.notEqual(baseline.action,sameDistribution.action);
 assert.equal(distributionsDiffer(baseline.probabilities,sameDistribution.probabilities),false);
 assert.equal(distributionsDiffer(baseline.probabilities,{check:.75,bet:.25}),true);
});
