import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStore } from '../dist/storage.js';
import { ResearchOrchestrator, validateSubmission } from '../dist/research.js';
import { KuhnPokerDomain, createKuhnStrategy } from '../dist/domains.js';
import { buildQuestions } from '../dist/strategy.js';
import { digest } from '../dist/utils.js';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { decisionPolicyRuntimeVersion } from '../dist/runtime.js';
import { DuelLoopError } from '../dist/errors.js';
const decisionPolicy = { maxDecisionMs: 5000, executionReserveMs: 25 };
const evaluationQuestions=[{id:'gain:check',actionId:'check',dimensionId:'gain',instructions:'Fixture utility',criteria:['low','high']}];
const evaluationAnswers={'gain:check':{score:0,confidence:0,probabilities:{'0':1,'1':0}}};
const domainDependencies = { rules:'1', featureBuilder:'1', knowledgeUpdater:'1',  continuationPolicy:'1', contextDigest:digest(new KuhnPokerDomain().context) };
const protocol = {version:'2.0',id:'final',domainId:'kuhn-poker',seeds:[701,702,703],opponentIds:['calling'],trajectoriesPerSeed:10,knowledgeStateMode:'frozen',initialKnowledge:{},metric:{name:'reward',direction:'maximize',unit:'chips'},minSamples:3,minimumImprovement:0,maxGroupRegression:0,confidenceLevel:.95,maxP95LatencyMs:100,maxDevelopmentEvalRuns:2,maxFinalEvaluationsPerRun:1,holdoutId:'secret-holdout',maxHoldoutUses:1};
function setup(provider,extra={}) {
 const store=new SqliteStore(), domain=new KuhnPokerDomain({scopeId:'scope'}), baseline=createKuhnStrategy();
 const model={id:'fixture',kind:'fixture',score:async()=>{throw Error('not used by synthetic evaluator')}};
 const dependencies={model:model.id,runtime:decisionPolicyRuntimeVersion(decisionPolicy),rules:'1',featureBuilder:'1',knowledgeUpdater:'1',continuationPolicy:'1',contextDigest:digest(domain.context)};
 const release=store.registerRelease({strategyDigest:store.putArtifact('strategy',baseline),dependencies,scopeId:'scope',expectedActiveDigest:null,validationDigest:null,source:'bootstrap'});
 store.activate(release,dependencies);
 const now=Date.now(); store.recordFeedback({feedbackId:'experience',revision:1,eventTime:now,receivedAt:now,applicationId:'test',strategyScopeId:'scope',trajectoryId:'t',metrics:{reward:-1},settled:true});
 const evaluator={id:'synthetic-fixture-no-domain-performance-claim',decisionPolicy,domainDependencies,episode:async({strategy})=>({reward:strategy.version==='v1'?0:1,decisions:10,latenciesMs:Array(10).fill(1),modelCalls:0})};
 const orchestrator=new ResearchOrchestrator({store,domain,model,evaluator,dependencies,providers:{researcher:provider},...extra});
 const run=orchestrator.create({scopeId:'scope',protocol});
 return {store,domain,baseline,orchestrator,run,release};
}
function submission(f) {
 const s=structuredClone(f.baseline); s.version='v2';s.parentVersion='v1';s.provenance={researchRunId:f.run.id,snapshotId:f.run.researchSnapshotId,hypothesis:'Avoid weak-card exposure'};
 s.decision.branches=[{id:'weak',when:{feature:'self.card',op:'eq',value:'J'},weights:{gain:1,exposure:-1}}];
 const observation={applicationId:'test',domainId:'kuhn-poker',strategyScopeId:'scope',streamId:'s',actorId:'self',trajectoryId:'t',revision:'0',observedAt:Date.now(),deadline:Date.now()+60000,features:{'self.card':'J','self.seat':0,'self.committedChips':1,'round.history':'','round.pot':2,'opponent.observedCallRate':.5,'opponent.callOpportunities':0}};
 const candidates=['check','bet'].map(id=>({id,kind:id,parameters:{},revision:'0'}));
 const answer=score=>({score,confidence:1,probabilities:Object.fromEntries([0,1,2,3,4].map(n=>[n,n===score?1:0]))});
 const answers={'gain:check':answer(2),'exposure:check':answer(0),'gain:bet':answer(4),'exposure:bet':answer(4)};
 const c={id:'weak-changes',observation,candidates,answers,questionDigest:buildQuestions(s,observation,candidates,f.domain).questionDigest,assertion:{op:'utility_margin_decreases',actionId:'bet',otherActionId:'check'}};
 const r=structuredClone(c);r.id='strong-unchanged';r.observation.features['self.card']='K';r.questionDigest=buildQuestions(s,r.observation,candidates,f.domain).questionDigest;r.assertion={op:'utilities_equal'};
 return {submissionId:`candidate-${f.run.id}`,researchRunId:f.run.id,strategy:s,baseReleaseDigest:f.run.baseReleaseDigest,researchSnapshotId:f.run.researchSnapshotId,evaluationProtocolDigest:f.run.evaluationProtocolDigest,hypothesis:'Avoid weak-card exposure',evidenceRefs:['experience@1'],expectedBehaviorChanges:[c],regressionCases:[r],knownRisks:[]};
}
const usage={inputTokens:10,outputTokens:10};
test('failed provider output retains measured token costs without consuming holdout',async()=>{
 const f=setup({id:'invalid-output',kind:'fixture',run:async()=>{throw new DuelLoopError('MODEL_INVALID','Invalid final JSON',{usage:{inputTokens:120,outputTokens:30,costUsd:.001,unknown:false}});}});
 const result=await f.orchestrator.run(f.run.id);
 assert.equal(result.run.status,'error');assert.equal(result.run.counters.tokens,150);assert.equal(result.run.counters.finalEvaluations,undefined);
 const event=f.store.events().find(e=>e.type==='research.model_usage');
 assert.equal(event.data.outcome,'failed');assert.equal(event.data.usage.costUsd,.001);
 assert.equal(f.store.events().find(e=>e.type==='research.ended').data.usageUnknown,false);
 f.store.close();
});
test('single research uses one session, validates real contract and keeps final evidence private',async()=>{
 let f;const sessions=[],prompts=[],toolsets=[];
 const provider={id:'fixture-research',kind:'fixture',run:async input=>{
  sessions.push(input.sessionId);prompts.push(input.prompt);toolsets.push(input.tools.map(t=>t.name));
  if(input.role==='integrator') {
   const candidate=submission(f);
   for (const cases of [candidate.expectedBehaviorChanges,candidate.regressionCases]) {
    for (let index=0;index<cases.length;index++) {
     const {questionDigest,...fixture}=cases[index];
     const registered=await input.tools.find(t=>t.name==='register_behavior_fixture').execute({...fixture,strategy:candidate.strategy});
     assert.equal(registered.behaviorCase.questionDigest,questionDigest);cases[index]=registered.behaviorCase;
    }
   }
   await input.tools.find(t=>t.name==='submit_candidate').execute(candidate);
  }
  return {output:{analysis:'synthetic fixture, no real model claim'},usage};
 }};
 f=setup(provider);const result=await f.orchestrator.run(f.run.id);
 assert.equal(result.run.status,'completed_passed',JSON.stringify(result.run));assert.equal(result.report.modelKind,'fixture');assert.ok(result.releaseDigest);
 assert.equal(new Set(sessions).size,1);assert.equal(sessions.length,3);
 assert.equal(f.store.activeRelease('scope'),f.release,'research does not auto-activate');
 assert.ok(prompts.every(p=>!p.includes('701')&&!p.includes('secret-holdout')));
 assert.ok(toolsets.every(t=>!t.includes('run_final_eval')));
 assert.throws(()=>f.store.getArtifact(result.validationDigest),e=>e.code==='ACCESS_DENIED');
 assert.equal(f.store.listArtifacts('validation_report').length,0);
 assert.equal(f.store.listArtifacts('final_evaluation_evidence').length,0);
 assert.equal(f.store.getArtifact(result.run.data.evidenceDigest,{allowPrivate:true}).blocks.length,3);
 assert.equal(f.store.getRun(f.run.id).counters.finalEvaluations,1);
 await assert.rejects(f.orchestrator.run(f.run.id),e=>e.code==='CONFLICT');
 const second=f.orchestrator.create({scopeId:'scope',protocol});f.run=second;
 assert.equal((await f.orchestrator.run(second.id)).run.status,'budget_exhausted','new task ID cannot reset holdout use');
 f.store.close();
});
test('new question wording invalidates old responses, and evidence cannot escape snapshot',()=>{
 const f=setup({id:'fixture',kind:'fixture',run:async()=>({output:{status:'no_change'},usage})});
 const s=submission(f);
 s.strategy.questions[0].instructions+=' New meaning.';
 assert.throws(()=>validateSubmission(s,{run:f.run,baseline:f.baseline,domain:f.domain,evidenceRefs:new Set(['experience@1'])}),e=>e.code==='VALIDATION_REJECTED');
 const bad=submission(f);bad.evidenceRefs=['unrelated-secret'];
 assert.throws(()=>validateSubmission(bad,{run:f.run,baseline:f.baseline,domain:f.domain,evidenceRefs:new Set(['experience@1'])}),e=>e.code==='VALIDATION_REJECTED');
 f.store.close();
});
test('no_change ends normally without consuming holdout',async()=>{
 const f=setup({id:'fixture',kind:'fixture',run:async()=>({output:{status:'no_change'},usage})});
 assert.equal((await f.orchestrator.run(f.run.id)).run.status,'no_change');
 assert.equal(f.store.getRun(f.run.id).counters.finalEvaluations,undefined);
 assert.equal(f.orchestrator.cancel(f.run.id).status,'no_change');f.store.close();
});
test('cancel wins over a late non-cooperative provider and cannot be undone by its tools',async()=>{
 let resolve,started; const ready=new Promise(r=>started=r);let tools;
 const f=setup({id:'fixture',kind:'fixture',run:input=>{tools=input.tools;started();return new Promise(r=>resolve=r);}});
 const running=f.orchestrator.run(f.run.id);await ready;
 assert.equal(f.orchestrator.cancel(f.run.id).status,'cancel_requested');
 const result=await running;assert.equal(result.run.status,'cancelled');
 await assert.rejects(tools.find(t=>t.name==='submit_candidate').execute(submission(f)),e=>e.code==='CANCELLED');
 resolve({output:{status:'no_change'},usage});await new Promise(r=>setImmediate(r));
 assert.equal(f.store.getRun(f.run.id).status,'cancelled');
 assert.ok(f.store.events({allowPrivate:true}).some(e=>e.type==='research.late_model_result'));
 f.store.close();
});
test('team sessions are role-isolated; all roles share explicitly curated evidence',async()=>{
 let f;const inputs=[];const provider={id:'same-model',kind:'fixture',run:async input=>{inputs.push(input);return {output:input.role==='integrator'?{status:'no_change'}:{proposal:'test'},usage};}};
 f=setup(provider,{mode:'team',providers:{researcher:provider,adversary:provider,integrator:provider}});
 assert.equal((await f.orchestrator.run(f.run.id)).run.status,'no_change');
 assert.equal(new Set(inputs.map(x=>x.sessionId)).size,3);
 assert.ok(!inputs[0].tools.some(t=>t.name==='submit_candidate'));assert.ok(inputs[2].tools.some(t=>t.name==='submit_candidate'));
 assert.ok(inputs[1].prompt.includes('proposal'));f.store.close();
});
test('unknown usage and exhausted repair budgets fail closed; interrupted work is not replayed',async()=>{
 const f=setup({id:'fixture',kind:'fixture',run:async()=>({output:{status:'no_change'},usage:{unknown:true}})});
 assert.equal((await f.orchestrator.run(f.run.id)).run.status,'budget_exhausted');
 const run=f.orchestrator.create({scopeId:'scope',protocol});f.store.transitionRun(run.id,['created'],'researching');
 assert.equal(f.orchestrator.recover(run.id).status,'error');f.store.close();
 const g=setup({id:'fixture',kind:'fixture',run:async()=>({output:{analysis:'no formal submission'},usage})},{budget:{maxRepairAttempts:1}});
 const result=await g.orchestrator.run(g.run.id);assert.equal(result.run.status,'error');assert.equal(result.run.counters.modelCalls,4);g.store.close();
});
test('development protocol cannot reuse a final seed',()=>{
 const f=setup({id:'fixture',kind:'fixture',run:async()=>({output:{status:'no_change'},usage})});
 assert.throws(()=>f.orchestrator.create({scopeId:'scope',protocol,developmentProtocol:{...protocol,id:'dev',holdoutId:'dev'}}),e=>e.code==='CONFIG_INVALID');f.store.close();
});

test('an evaluator cannot swallow model-budget failure to earn final approval',async()=>{
 let f;
 const provider={id:'fixture',kind:'fixture',run:async input=>{if(input.role==='integrator') await input.tools.find(t=>t.name==='submit_candidate').execute(submission(f));return {output:{analysis:'synthetic'},usage};}};
 const evaluator={id:'error-swallowing',decisionPolicy,domainDependencies,episode:async({model,signal})=>{
  try { await model.score({state:{},questions:evaluationQuestions,signal}); } catch {}
  return {reward:100,decisions:1,latenciesMs:[1],modelCalls:1};
 }};
 f=setup(provider,{evaluator,model:{id:'fixture',kind:'fixture',score:async()=>({answers:evaluationAnswers,model:'fixture',usage:{unknown:true}})}});
 const result=await f.orchestrator.run(f.run.id);
 assert.equal(result.run.status,'budget_exhausted');assert.equal(result.releaseDigest,undefined);assert.equal(f.store.activeRelease('scope'),f.release);f.store.close();
});
test('final failure terminates the task and never returns detailed holdout output to research',async()=>{
 let f;let calls=0;
 const provider={id:'fixture',kind:'fixture',run:async input=>{calls++;if(input.role==='integrator') await input.tools.find(t=>t.name==='submit_candidate').execute(submission(f));return {output:{analysis:'synthetic'},usage};}};
 f=setup(provider,{evaluator:{id:'negative-fixture',decisionPolicy,domainDependencies,episode:async({strategy})=>({reward:strategy.version==='v1'?1:0,decisions:1,latenciesMs:[1],modelCalls:0})}});
 const result=await f.orchestrator.run(f.run.id);assert.equal(result.run.status,'completed_failed');assert.equal(calls,3);assert.equal(result.releaseDigest,undefined);
 await assert.rejects(f.orchestrator.run(f.run.id),e=>e.code==='CONFLICT');assert.equal(f.store.listArtifacts('validation_report').length,0);f.store.close();
});
test('integrator may request another bounded round; single mode keeps the same session',async()=>{
 let integrations=0;const sessions=[];
 const provider={id:'fixture',kind:'fixture',run:async input=>{sessions.push(input.sessionId);if(input.role==='integrator') return {output:{status:++integrations===1?'revise':'no_change'},usage};return {output:{hypothesis:'revisit'},usage};}};
 const f=setup(provider,{maxRounds:2});
 assert.equal((await f.orchestrator.run(f.run.id)).run.status,'no_change');assert.equal(sessions.length,6);assert.equal(new Set(sessions).size,1);f.store.close();
});
test('two orchestrators cannot claim the same run or terminate the winner',async()=>{
 let release,started;const ready=new Promise(r=>started=r);
 const provider={id:'fixture',kind:'fixture',run:async()=>{started();await new Promise(r=>release=r);return {output:{status:'no_change'},usage};}};
 const f=setup(provider);
 let staleOnce=true;
 // Emulate worker B reading 'created' immediately before worker A commits its claim.
 const racingStore=new Proxy(f.store,{get(target,key){
  if(key==='getRun')return id=>{if(staleOnce&&id===f.run.id){staleOnce=false;return structuredClone(f.run);}return target.getRun(id);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const second=new ResearchOrchestrator({store:racingStore,domain:f.domain,model:{id:'fixture',kind:'fixture',score:async()=>{throw Error('unused')}},evaluator:{id:'unused',decisionPolicy,domainDependencies,episode:async()=>{throw Error('unused')}},dependencies:f.store.release(f.release).dependencies,providers:{researcher:provider}});
 const winner=f.orchestrator.run(f.run.id);await ready;
 await assert.rejects(second.run(f.run.id),e=>e.code==='CONFLICT');assert.equal(f.store.getRun(f.run.id).status,'researching');
 release();assert.equal((await winner).run.status,'no_change');f.store.close();
});
test('cross-worker cancellation preserves measured late charges without reviving research',async()=>{
 let resolve,started;const ready=new Promise(r=>started=r);
 const provider={id:'fixture',kind:'fixture',run:()=>{started();return new Promise(r=>resolve=r);}};
 const f=setup(provider);
 const second=new ResearchOrchestrator({store:f.store,domain:f.domain,model:{id:'fixture',kind:'fixture',score:async()=>{throw Error('unused')}},evaluator:{id:'unused',decisionPolicy,domainDependencies,episode:async()=>{throw Error('unused')}},dependencies:f.store.release(f.release).dependencies,providers:{researcher:provider}});
 const pending=f.orchestrator.run(f.run.id);await ready;
 assert.equal(second.cancel(f.run.id).status,'cancelled');
 const measured={inputTokens:17,outputTokens:23,costUsd:.12,unknown:false};
 resolve({output:{status:'no_change'},usage:measured});
 const result=await pending;assert.equal(result.run.status,'cancelled');assert.equal(result.releaseDigest,undefined);
 const charges=f.store.events({allowPrivate:true}).filter(e=>['research.model_usage','research.late_model_result'].includes(e.type));
 assert.equal(charges.length,1);assert.equal(charges[0].type,'research.late_model_result');assert.equal(charges[0].visibility,'private');assert.deepEqual(charges[0].data.usage,measured);
 assert.equal(charges[0].data.modelCallId,`${f.run.id}:research:1`);
 assert.equal(f.store.events().filter(e=>e.type==='research.role_output').length,0);
 assert.equal(f.store.activeRelease('scope'),f.release);f.store.close();
});
test('zero remaining tokens prevent evaluation requests both at entry and between calls',async()=>{
 for(const maxTokensTotal of [60,61]) {
  let f,actualCalls=0;
  const provider={id:'fixture',kind:'fixture',run:async input=>{if(input.role==='integrator')await input.tools.find(t=>t.name==='submit_candidate').execute(submission(f));return {output:{analysis:'synthetic'},usage};}};
  const model={id:'fixture',kind:'fixture',score:async()=>{actualCalls++;return {answers:evaluationAnswers,model:'fixture',usage:{inputTokens:1,outputTokens:0,costUsd:0}};}};
  const evaluator={id:'calls-real-injected-interface',decisionPolicy,domainDependencies,episode:async({model,signal})=>{await model.score({state:{},questions:evaluationQuestions,signal});return {reward:1,decisions:1,latenciesMs:[1],modelCalls:1};}};
  f=setup(provider,{model,evaluator,budget:{maxTokensTotal}});
  const result=await f.orchestrator.run(f.run.id);
  assert.equal(result.run.status,'budget_exhausted');assert.equal(actualCalls,maxTokensTotal-60,'no score may start when remaining tokens are zero');
  assert.equal(result.run.counters.decisionModelCalls??0,actualCalls);assert.equal(result.run.counters.tokens,maxTokensTotal);
  assert.equal(result.releaseDigest,undefined);assert.equal(f.store.activeRelease('scope'),f.release);f.store.close();
 }
});
test('a provider discovers assertion and version contracts solely through controlled tools',async()=>{
 let discovered=false;
 const provider={id:'contract-only-fixture',kind:'fixture',run:async input=>{
  if(input.role!=='integrator')return {output:{analysis:'inspect public contract during integration'},usage};
  const read=await input.tools.find(t=>t.name==='read_strategy').execute({});
  const experience=await input.tools.find(t=>t.name==='query_experience').execute({});
  const register=input.tools.find(t=>t.name==='register_behavior_fixture');
  const submit=input.tools.find(t=>t.name==='submit_candidate');
  const contract=read.submissionContract;
  assert.deepEqual(register.schema,contract.fixtureSchema);
  assert.deepEqual(submit.schema,contract.schema);
  const variant=register.schema.properties.assertion.oneOf[0];
  assert.equal(variant.properties.op.const,contract.assertionSchema.oneOf[0].properties.op.const);
  assert.ok(variant.description.includes('argmax'));
  assert.equal(contract.schema.properties.strategy.properties.version.type,'string');
  const candidate={...structuredClone(read.strategy),...contract.strategyBindings,version:read.strategy.version+'-contract-fixture',provenance:{...contract.strategyBindings.provenance,hypothesis:'Contract-discovery fixture; not a real model hypothesis'}};
  const weight=Object.keys(candidate.decision.defaultWeights)[0];candidate.decision.defaultWeights[weight]+=.01;
  const decisionRef=experience.items.find(item=>item.kind==='decision').evidenceRef;
  const evidence=(await input.tools.find(t=>t.name==='query_experience').execute({evidenceRef:decisionRef,fields:['observation','candidates']})).record;
  const answers=Object.fromEntries(candidate.questions.flatMap(dimension=>evidence.candidates.map(action=>[
   contract.answerKeyTemplate.replace('{dimensionId}',dimension.id).replace('{candidateId}',action.id),
   {score:0,confidence:0,probabilities:Object.fromEntries(dimension.criteria.map((_,index)=>[String(index),Number(index===0)]))},
  ])));
  const create=async id=>{
   const argumentsObject={id,strategy:candidate,observation:evidence.observation,candidates:evidence.candidates,answers,assertion:{op:variant.properties.op.const,actionId:evidence.candidates[0].id}};
   const validated=validateToolArguments({name:register.name,parameters:register.schema},{id:'fixture-call',type:'toolCall',name:register.name,arguments:argumentsObject});
   const value=await register.execute(validated);
   return value.behaviorCase;
  };
  const expected=await create('contract-expected'),regression=await create('contract-regression');
  const complete={submissionId:contract.bindings.researchRunId+'-contract',...contract.bindings,strategy:candidate,hypothesis:candidate.provenance.hypothesis,evidenceRefs:experience.evidenceRefs.slice(0,1),expectedBehaviorChanges:[expected],regressionCases:[regression],knownRisks:[]};
  for(const key of contract.schema.required)assert.ok(Object.hasOwn(complete,key),`Missing discoverable field ${key}`);
  assert.equal(contract.strategyBindings.schemaVersion,'2.0');
  assert.doesNotMatch(JSON.stringify(read.strategyLanguage),/minRequiredConfidence|exitConditions|domain_baseline/);
  for(const mutate of [
   strategy=>{strategy.schemaVersion='1.0';},
   strategy=>{strategy.decision.minRequiredConfidence=0;},
   strategy=>{strategy.exitConditions=[];},
   strategy=>{strategy.fallback={mode:'domain_baseline'};},
  ]) {
   const legacy=structuredClone(complete);mutate(legacy.strategy);
   assert.throws(()=>validateToolArguments({name:submit.name,parameters:submit.schema},{id:'legacy-call',type:'toolCall',name:submit.name,arguments:legacy}));
   await assert.rejects(submit.execute(legacy),error=>['VERSION_INCOMPATIBLE','STRATEGY_INVALID'].includes(error.code));
  }
  const validatedSubmission=validateToolArguments({name:submit.name,parameters:submit.schema},{id:'submission-call',type:'toolCall',name:submit.name,arguments:complete});
  await submit.execute(validatedSubmission);discovered=true;return {output:{analysis:'valid submission built using the public contract'},usage};
 }};
 const f=setup(provider);f.orchestrator.cancel(f.run.id);
 const observation=await f.domain.observe('contract-observation');const candidates=await f.domain.candidates(observation);
 f.store.appendEvent('decision','scope',{decisionId:'contract-observation',observation,candidates});
 const run=f.orchestrator.create({scopeId:'scope',protocol});
 const result=await f.orchestrator.run(run.id);
 assert.equal(discovered,true);assert.equal(result.run.status,'completed_passed',JSON.stringify(result.run));assert.ok(result.submissionDigest);f.store.close();
});

test('experience queries page bounded summaries and retrieve exact immutable evidence without holdout',async()=>{
 let f,verified=false;
 const provider={id:'paged-evidence',kind:'fixture',run:async input=>{
  const tool=input.tools.find(tool=>tool.name==='query_experience');
  const query=async args=>tool.execute(validateToolArguments({name:tool.name,parameters:tool.schema},{id:'query',type:'toolCall',name:tool.name,arguments:args}));
  const first=await query({});
  assert.equal(first.snapshotId,f.run.researchSnapshotId);assert.equal(first.items.length,5);assert.equal(first.nextOffset,5);
  assert.deepEqual(first.counts,{decision:12,feedback:1});assert.ok(JSON.stringify(first).length<15000);
  assert.ok(!JSON.stringify(first).includes('BIG-QUESTION'));assert.ok(!JSON.stringify(first).includes('secret-holdout'));
  const refs=[];let offset=0;
  do {const page=await query({offset,limit:5});refs.push(...page.evidenceRefs);offset=page.nextOffset;} while(offset!==null);
  assert.equal(refs.length,13);assert.equal(new Set(refs).size,13);
  const decisions=await query({kind:'decision',offset:10,limit:20});assert.equal(decisions.items.length,2);assert.equal(decisions.nextOffset,null);
  const full=await query({evidenceRef:'d0'});assert.equal(full.record.questions[0].instructions.length,12000);assert.deepEqual(full.record.answers,{'gain:check':{score:2,confidence:.8}});
  const selected=await query({evidenceRef:'d0',fields:['observation','candidates','answers']});assert.deepEqual(Object.keys(selected.record).sort(),['answers','candidates','observation']);
  const feedback=await query({kind:'feedback'});assert.deepEqual(feedback.evidenceRefs,['experience@1']);
  assert.equal((await query({evidenceRef:'experience@1'})).record.metrics.reward,-1);
  for(const args of [{evidenceRef:'experience@2'},{evidenceRef:'outside'},{kind:'feedback',evidenceRef:'d0'}])await assert.rejects(query(args),error=>error.code==='ACCESS_DENIED');
  for(const args of [{limit:21},{offset:-1},{evidenceRef:'d0',offset:0},{fields:['answers']},{evidenceRef:'d0',fields:['__proto__']}])await assert.rejects(tool.execute(args),error=>error.code==='CONFIG_INVALID');
  assert.equal(digest(f.store.getArtifact(f.run.researchSnapshotId)),f.run.researchSnapshotId);
  verified=true;return {output:{status:'no_change'},usage};
 }};
 f=setup(provider);f.orchestrator.cancel(f.run.id);
 for(let i=0;i<12;i++)f.store.appendEvent('decision','scope',{decisionId:`d${i}`,decisionSource:'strategy',observation:{features:{large:'x'.repeat(10000)}},candidates:[{id:'check'}],questions:[{instructions:'BIG-QUESTION'.repeat(1000)}],answers:{'gain:check':{score:2,confidence:.8}}});
 f.run=f.orchestrator.create({scopeId:'scope',protocol});
 const now=Date.now();f.store.recordFeedback({feedbackId:'experience',revision:2,eventTime:now,receivedAt:now,applicationId:'test',strategyScopeId:'scope',trajectoryId:'t',metrics:{reward:999},settled:true});
 const result=await f.orchestrator.run(f.run.id);assert.equal(result.run.status,'no_change',JSON.stringify(result.run));assert.equal(verified,true);f.store.close();
});

test('joint budget counts in-flight provider usage before each nested development call',async()=>{
 let f,modelCalls=0,providerCalls=0,remaining;
 const model={id:'fixture',kind:'fixture',score:async()=>{modelCalls++;return {answers:evaluationAnswers,model:'fixture',usage:{inputTokens:10,outputTokens:0,unknown:false}};}};
 const evaluator={id:'joint-budget-fixture',decisionPolicy,domainDependencies,episode:async({model,signal})=>{for(let n=0;n<6;n++)await model.score({state:{},questions:evaluationQuestions,signal});return {reward:1,decisions:6,latenciesMs:[1],modelCalls:6};}};
 const measured={inputTokens:50,outputTokens:0,unknown:false};
 const provider={id:'joint-budget',kind:'fixture',run:async input=>{
  providerCalls++;input.onUsage(measured);assert.equal(input.getRemainingTokens(),100,'callback excludes outstanding local provider usage');
  try {await input.tools.find(tool=>tool.name==='run_development_eval').execute({strategy:f.baseline});}
  catch(error){remaining=input.getRemainingTokens();throw new DuelLoopError(error.code,error.message,{usage:measured});}
  throw Error('sixth evaluation call should have been blocked');
 }};
 f=setup(provider,{model,evaluator,budget:{maxTokensTotal:100}});f.orchestrator.cancel(f.run.id);
 f.run=f.orchestrator.create({scopeId:'scope',protocol,developmentProtocol:{...protocol,id:'development',holdoutId:'dev',seeds:[1,2,3]}});
 const result=await f.orchestrator.run(f.run.id);
 assert.equal(result.run.status,'budget_exhausted',JSON.stringify(result.run));assert.equal(modelCalls,5);assert.equal(providerCalls,1);await new Promise(resolve=>setImmediate(resolve));assert.equal(remaining,0);
 assert.equal(result.run.counters.tokens,100,'provider cumulative usage must be accounted once');assert.equal(result.run.counters.decisionModelCalls,5);assert.equal(result.run.counters.finalEvaluations,undefined);
 assert.equal(f.store.events({allowPrivate:true}).filter(event=>['research.model_usage','research.late_model_result'].includes(event.type)).length,1);f.store.close();
});

test('unknown in-flight research usage blocks evaluation and further provider calls',async()=>{
 let f,calls=0,paidCalls=0;
 const provider={id:'unknown-in-flight',kind:'fixture',run:async input=>{
  calls++;input.onUsage({unknown:true});
  await input.tools.find(tool=>tool.name==='run_development_eval').execute({strategy:f.baseline});
  return {output:{status:'no_change'},usage:{unknown:true}};
 }};
 const model={id:'fixture',kind:'fixture',score:async()=>{paidCalls++;throw Error('must not call');}};
 f=setup(provider,{model});const result=await f.orchestrator.run(f.run.id);
 assert.equal(result.run.status,'budget_exhausted');assert.equal(calls,1);assert.equal(paidCalls,0);await new Promise(resolve=>setImmediate(resolve));f.store.close();
});

test('behavior fixtures use observedAt as a fixed clock for old and new strategy',async()=>{
 const {checkBehaviorCase}=await import('../dist/research.js');
 const f=setup({id:'unused',kind:'fixture',run:async()=>({output:{},usage})});
 const candidate=submission(f);const c=candidate.expectedBehaviorChanges[0];
 candidate.strategy.decision.branches=[{id:'stale',when:{feature:'observation.isStale',op:'eq',value:true},weights:{gain:1,exposure:-1}}];
 c.assertion={op:'utilities_equal'};
 c.observation.observedAt=1000;c.observation.deadline=2000;
 c.questionDigest=buildQuestions(candidate.strategy,c.observation,c.candidates,f.domain).questionDigest;
 assert.doesNotThrow(()=>checkBehaviorCase(c,f.baseline,candidate.strategy,f.domain));
 c.observation.deadline=1000;c.questionDigest=buildQuestions(candidate.strategy,c.observation,c.candidates,f.domain).questionDigest;
 c.assertion={op:'utility_margin_decreases',actionId:'bet',otherActionId:'check'};
 assert.doesNotThrow(()=>checkBehaviorCase(c,f.baseline,candidate.strategy,f.domain));
 f.store.close();
});

test('failed evaluation calls account known tokens once and stop all calls when usage is unknown',async()=>{
 for(const known of [true,false]) {
  let f,calls=0;
  const provider={id:'failed-evaluation-cost',kind:'fixture',run:async input=>{if(input.role==='integrator')await input.tools.find(tool=>tool.name==='submit_candidate').execute(submission(f));return {output:{analysis:'fixture'},usage};}};
  const model={id:'fixture',kind:'fixture',score:async()=>{calls++;throw new DuelLoopError('MODEL_INVALID','Semantic response rejected',known?{usage:{inputTokens:7,outputTokens:3,unknown:false}}:{});}};
  const evaluator={id:'failed-model-swallowing',decisionPolicy,domainDependencies,episode:async({model,signal})=>{for(let i=0;i<2;i++)try{await model.score({state:{},questions:evaluationQuestions,signal});}catch{}return {reward:0,decisions:2,latenciesMs:[1,1],modelCalls:2};}};
  f=setup(provider,{model,evaluator});const result=await f.orchestrator.run(f.run.id);
  const events=f.store.events({allowPrivate:true}).filter(event=>event.type==='research.evaluation_model_usage');
  assert.equal(result.releaseDigest,undefined);assert.equal(f.store.activeRelease('scope'),f.release);
  assert.equal(events.length,calls,'failed remote requests logged exactly once');assert.ok(events.every(event=>event.data.outcome==='failed'));
  if(known){assert.equal(result.run.status,'error',JSON.stringify(result.run));assert.equal(calls,1);assert.equal(result.run.counters.tokens,70);}
  else{assert.equal(result.run.status,'budget_exhausted');assert.equal(calls,1);assert.equal(result.run.counters.decisionModelCalls,1);assert.equal(result.run.counters.tokens,60);}
  f.store.close();
 }
});

test('phase prompts expose actionable roles and remaining budgets without promising extra rounds',async()=>{
 let f;const prompts=[];
 const provider={id:'phase-contract',kind:'fixture',run:async input=>{
  const prompt=JSON.parse(input.prompt);prompts.push(prompt);
  const phase=prompt.phaseContract;
  assert.equal(phase.roundNumber,prompt.round+1);assert.equal(phase.totalRounds,2);assert.equal(phase.repairAttempt,prompt.repair);
  assert.equal(phase.remaining.tokens,200-(prompts.length-1)*20);
  assert.equal(phase.remaining.providerCallsAfterThisCall,6-prompts.length);
  assert.equal(phase.remaining.decisionModelCalls,10);
  assert.deepEqual(phase.allowedTools,input.tools.map(tool=>tool.name));
  assert.equal(phase.remaining.developmentEvaluations,prompts.length===1?2:1);
  assert.equal(phase.canRequestAnotherRound,input.role==='integrator'&&prompt.round===0);
  assert.ok(phase.continuation.includes('no_change is a valid result'));
  assert.ok(!input.prompt.includes('secret-holdout'));assert.ok(!input.prompt.includes('701'));
  if(prompts.length===1)await input.tools.find(tool=>tool.name==='run_development_eval').execute({strategy:f.baseline});
  if(input.role==='integrator')return {output:{status:prompt.round===0?'revise':'no_change'},usage};
  return {output:{analysis:'Phase-specific fixture findings'},usage};
 }};
 f=setup(provider,{maxRounds:2,budget:{maxTokensTotal:200,maxModelCalls:6,maxDecisionModelCalls:10}});f.orchestrator.cancel(f.run.id);
 f.run=f.orchestrator.create({scopeId:'scope',protocol,developmentProtocol:{...protocol,id:'development',holdoutId:'dev',seeds:[1,2,3]}});
 const result=await f.orchestrator.run(f.run.id);assert.equal(result.run.status,'no_change',JSON.stringify(result.run));assert.equal(prompts.length,6);
 assert.match(prompts[0].phaseContract.objective,/specific supported hypothesis/);
 assert.match(prompts[1].phaseContract.objective,/exploitable case/);
 assert.match(prompts[3].phaseContract.objective,/In a new round/);
 assert.match(prompts[5].phaseContract.completion,/last round.*no_change/);
 assert.equal(prompts[5].phaseContract.remaining.rounds,0);assert.equal(result.run.counters.finalEvaluations,undefined);f.store.close();
});
