import { randomUUID } from 'node:crypto';
import { DuelLoopError, invariant } from './errors.js';
import { digest, jsonValue, seededRandom, withDeadline } from './utils.js';
import { buildQuestions, compileStrategy, evaluateAnswers } from './strategy.js';
import { evaluateCandidate, validateProtocol } from './evaluation.js';
import { modelBehaviorDigest } from './runtime.js';
import type { BehaviorCase, BehaviorDependencies, CandidateSubmission, DecisionModel, DomainDefinition, DuelLoopStore, EvaluationAdapter, EvaluationProtocol, Json, ResearchProvider, ResearchRun, ResearchTool, RunStatus, StrategyPackage, ValidationReport } from './types.js';

const textSchema: Record<string, Json> = {type:'string',minLength:1,maxLength:10000};
const scoreAnswerSchema: Record<string, Json> = {type:'object',additionalProperties:false,required:['score','confidence','probabilities'],properties:{
  score:{type:'number',minimum:0,description:'Expected rubric score between 0 and criteria.length - 1; fractional values are permitted.'},
  confidence:{type:'number',minimum:0,maximum:1,description:'Observed model confidence in [0,1], including zero. It never gates acceptance of an otherwise valid answer.'},
  probabilities:{type:'object',description:'Exactly the string keys 0 through criteria.length - 1; finite nonnegative probabilities must sum to one.',additionalProperties:{type:'number',minimum:0,maximum:1}},
}};
const actionSchema: Record<string, Json> = {type:'object',additionalProperties:false,required:['id','kind','parameters','revision'],properties:{id:textSchema,kind:textSchema,parameters:{type:'object'},revision:{...textSchema,description:'Same state revision as observation.revision.'}}};
const observationSchema: Record<string, Json> = {type:'object',additionalProperties:false,required:['applicationId','domainId','strategyScopeId','streamId','actorId','trajectoryId','revision','observedAt','deadline','features'],properties:{
  applicationId:textSchema,domainId:textSchema,strategyScopeId:textSchema,streamId:textSchema,actorId:textSchema,trajectoryId:textSchema,revision:textSchema,
  observedAt:{type:'number',description:'Event timestamp in epoch milliseconds.'},deadline:{type:'number',description:'Epoch milliseconds; fixtures evaluate time at observation.observedAt. deadline <= observedAt intentionally activates observation.isStale, independent of wall clock.'},features:{type:'object',description:'Visible feature names and types from read_strategy.domain.features. Copy a development observation; never invent hidden information.'},terminal:{type:'boolean'},
}};
const assertionSchema: Record<string, Json> = {type:'object',description:'Choose one finite operator. Comparative operators require identical baseline and candidate rendered questions; selected_action_is checks only candidate argmax behavior.',oneOf:[
  {type:'object',additionalProperties:false,required:['op','actionId'],properties:{op:{const:'selected_action_is'},actionId:{...textSchema,description:'Candidate action ID that argmax must select.'},tolerance:{type:'number',minimum:0,maximum:0.01}},description:'Candidate selected action equals actionId. Only argmax supports this assertion. It may use a fresh candidate question fixture; it does not by itself compare old and new model quality.'},
  {type:'object',additionalProperties:false,required:['op','actionId','otherActionId'],properties:{op:{const:'utility_margin_decreases'},actionId:textSchema,otherActionId:textSchema,tolerance:{type:'number',minimum:0,maximum:0.01,default:1e-9}},description:'U_candidate(actionId) - U_candidate(otherActionId) < U_baseline(actionId) - U_baseline(otherActionId) - tolerance. Both action IDs must be legal candidates.'},
  {type:'object',additionalProperties:false,required:['op'],properties:{op:{const:'utilities_equal'},tolerance:{type:'number',minimum:0,maximum:0.01,default:1e-9}},description:'For every candidate action, absolute U_candidate - U_baseline is at most tolerance. Use a regression scene whose utility should remain unchanged.'},
  {type:'object',additionalProperties:false,required:['op','actionId'],properties:{op:{const:'action_probability_decreases'},actionId:textSchema,tolerance:{type:'number',minimum:0,maximum:0.01,default:1e-9}},description:'P_candidate(actionId) < P_baseline(actionId) - tolerance. Use distribution comparisons for randomized strategies instead of asserting one sampled action.'},
]};
function submissionSchemas(run: ResearchRun, baseline: StrategyPackage): {strategy: Record<string,Json>; fixture: Record<string,Json>; submission: Record<string,Json>} {
  const strategy: Record<string,Json>={type:'object',additionalProperties:false,required:['schemaVersion','strategyId','version','parentVersion','scope','stateProjection','questions','decision','provenance'],properties:{
    schemaVersion:{const:'2.0'},strategyId:{const:baseline.strategyId},version:{...textSchema,description:`A new nonempty STRING, different from baseline version ${JSON.stringify(baseline.version)}. Versions are not JSON numbers.`},parentVersion:{const:baseline.version},scope:{const:jsonValue(baseline.scope)},
    stateProjection:{type:'array',items:textSchema,uniqueItems:true},questions:{type:'array',minItems:1,maxItems:16,items:{type:'object'},description:'Complete Score dimension objects in the baseline format; read_strategy.strategyLanguage explains the supported language.'},
    decision:{type:'object',additionalProperties:false,required:['defaultWeights','branches','branchPolicy','aggregate','selection'],properties:{defaultWeights:{type:'object',additionalProperties:{type:'number'}},branches:{type:'array',items:{type:'object'}},branchPolicy:{const:'first_match'},aggregate:{const:'weighted_sum'},selection:{type:'object'}},description:'Complete model-answer combination policy. Weights must cover all dimension IDs. No confidence acceptance threshold or program takeover is supported.'},
    provenance:{type:'object',additionalProperties:false,required:['researchRunId','snapshotId','hypothesis'],properties:{researchRunId:{const:run.id},snapshotId:{const:run.researchSnapshotId},hypothesis:textSchema}},
  }};
  const caseProperties:Record<string,Json>={id:{...textSchema,description:'Unique across expectedBehaviorChanges and regressionCases.'},observation:observationSchema,candidates:{type:'array',minItems:2,items:actionSchema},answers:{type:'object',description:'One entry per dimension/candidate pair using the exact key dimensionId:candidateId; values must describe these exact rendered questions.',additionalProperties:scoreAnswerSchema},assertion:assertionSchema};
  const fixture:Record<string,Json>={type:'object',additionalProperties:false,required:['strategy',...Object.keys(caseProperties)],properties:{strategy,...caseProperties}};
  const behaviorCase:Record<string,Json>={type:'object',additionalProperties:false,required:[...Object.keys(caseProperties),'questionDigest'],properties:{...caseProperties,questionDigest:{...textSchema,description:'Use the value generated by register_behavior_fixture. Do not invent or copy a digest from different questions/input.'}}};
  const submission:Record<string,Json>={type:'object',additionalProperties:false,required:['submissionId','researchRunId','strategy','baseReleaseDigest','researchSnapshotId','evaluationProtocolDigest','hypothesis','evidenceRefs','expectedBehaviorChanges','regressionCases','knownRisks'],properties:{
    submissionId:{...textSchema,description:'Immutable unique submission ID. Any changed content requires a new submissionId.'},researchRunId:{const:run.id},strategy,baseReleaseDigest:{const:run.baseReleaseDigest},researchSnapshotId:{const:run.researchSnapshotId},evaluationProtocolDigest:{const:run.evaluationProtocolDigest},hypothesis:textSchema,
    evidenceRefs:{type:'array',minItems:1,items:textSchema,description:'Use exact allowed evidenceRefs returned by query_experience; never reference another snapshot.'},expectedBehaviorChanges:{type:'array',minItems:1,items:behaviorCase},regressionCases:{type:'array',minItems:1,items:behaviorCase},knownRisks:{type:'array',items:{type:'string'}},
  }};
  return {strategy,fixture,submission};
}

const terminal = new Set<RunStatus>(['cancelled','no_change','budget_exhausted','completed_passed','completed_failed','completed_inconclusive','error','waiting_protocol']);
export interface CandidateCheckPlan { changedSections: string[]; questionsChanged: boolean; requiresNewResponses: boolean; requiresRealModelEvaluation: boolean; behaviorCaseIds: string[] }
export function candidateCheckPlan(base: StrategyPackage, candidate: StrategyPackage): CandidateCheckPlan {
  const changedSections = (Object.keys(candidate) as (keyof StrategyPackage)[]).filter(key=>digest(base[key] ?? null)!==digest(candidate[key] ?? null));
  const questionsChanged = digest({ questions: base.questions, stateProjection: base.stateProjection, scope: base.scope }) !== digest({ questions: candidate.questions, stateProjection: candidate.stateProjection, scope: candidate.scope });
  return { changedSections, questionsChanged, requiresNewResponses: questionsChanged, requiresRealModelEvaluation: true, behaviorCaseIds: [] };
}
function checkDistribution(result: ReturnType<typeof evaluateAnswers>): void {
  const values = Object.values(result.probabilities);
  invariant(values.length && values.every(p=>Number.isFinite(p)&&p>=0&&p<=1) && Math.abs(values.reduce((a,b)=>a+b,0)-1) < 1e-8, 'VALIDATION_REJECTED', 'Invalid action probability distribution');
  invariant(result.action && result.probabilities[result.action.id]! > 0, 'VALIDATION_REJECTED', 'Selected action has no probability');
}
export function checkBehaviorCase(test: BehaviorCase, base: StrategyPackage, candidate: StrategyPackage, domain: DomainDefinition): void {
  invariant(test && typeof test.id === 'string' && test.id && test.assertion && Array.isArray(test.candidates) && test.candidates.length >= 2, 'VALIDATION_REJECTED', 'Invalid behavior case');
  const assertion = test.assertion, tolerance = assertion.tolerance ?? 1e-9;
  invariant(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= 0.01, 'VALIDATION_REJECTED', 'Invalid assertion tolerance');
  const questions = buildQuestions(candidate,test.observation,test.candidates,domain);
  invariant(questions.questionDigest === test.questionDigest, 'VALIDATION_REJECTED', 'Response fixture does not match candidate questions and rendered input', { caseId: test.id });
  const next = evaluateAnswers(candidate,test.observation,test.candidates,test.answers,seededRandom(test.id),test.observation.observedAt);
  checkDistribution(next);
  if (assertion.op === 'selected_action_is') {
    invariant(candidate.decision.selection.mode === 'argmax', 'VALIDATION_REJECTED', 'Randomized behavior requires probability assertions, not a selected-action assertion');
    invariant(next.action.id === assertion.actionId, 'VALIDATION_REJECTED', 'Selected action assertion failed', { caseId: test.id }); return;
  }
  const oldQuestions = buildQuestions(base,test.observation,test.candidates,domain);
  invariant(oldQuestions.questionDigest === test.questionDigest, 'VALIDATION_REJECTED', 'Comparative fixture assertions require unchanged question semantics; use fresh standalone candidate cases and independent model evaluation');
  const previous = evaluateAnswers(base,test.observation,test.candidates,test.answers,seededRandom(test.id),test.observation.observedAt);
  checkDistribution(previous);
  const action = assertion.actionId ?? '', other = assertion.otherActionId ?? '';
  if (assertion.op === 'utilities_equal') {
    invariant(Object.keys(previous.utilities).every(id=>Number.isFinite(next.utilities[id]) && Math.abs(next.utilities[id]!-previous.utilities[id]!)<=tolerance), 'VALIDATION_REJECTED', 'Regression utility assertion failed', { caseId: test.id });
  } else if (assertion.op === 'utility_margin_decreases') {
    invariant(action in next.utilities && other in next.utilities && next.utilities[action]!-next.utilities[other]! < previous.utilities[action]!-previous.utilities[other]!-tolerance, 'VALIDATION_REJECTED', 'Utility margin did not decrease', { caseId: test.id });
  } else if (assertion.op === 'action_probability_decreases') {
    invariant(action in next.probabilities && next.probabilities[action]! < previous.probabilities[action]!-tolerance, 'VALIDATION_REJECTED', 'Action probability did not decrease', { caseId: test.id });
  } else throw new DuelLoopError('VALIDATION_REJECTED','Unsupported behavior assertion');
}
export function validateSubmission(input: unknown, options: { run: ResearchRun; baseline: StrategyPackage; domain: DomainDefinition; evidenceRefs?: Set<string> }): { submission: CandidateSubmission; checkPlan: CandidateCheckPlan } {
  invariant(input && typeof input === 'object', 'VALIDATION_REJECTED', 'Candidate submission must be an object');
  const s = input as CandidateSubmission;
  for (const key of ['submissionId','researchRunId','baseReleaseDigest','researchSnapshotId','evaluationProtocolDigest','hypothesis'] as const) invariant(typeof s[key] === 'string' && s[key].trim(), 'VALIDATION_REJECTED', `Missing ${key}`);
  for (const key of ['researchRunId','baseReleaseDigest','researchSnapshotId','evaluationProtocolDigest'] as const) invariant(s[key] === (key === 'researchRunId' ? options.run.id : options.run[key]), 'VALIDATION_REJECTED', `Submission ${key} differs from immutable run binding`);
  invariant(Array.isArray(s.evidenceRefs) && s.evidenceRefs.length > 0 && s.evidenceRefs.every(x=>typeof x==='string' && x && (!options.evidenceRefs || options.evidenceRefs.has(x))), 'VALIDATION_REJECTED', 'Evidence references must belong to this research snapshot');
  invariant(Array.isArray(s.expectedBehaviorChanges) && s.expectedBehaviorChanges.length > 0 && Array.isArray(s.regressionCases) && s.regressionCases.length > 0 && Array.isArray(s.knownRisks) && s.knownRisks.every(x=>typeof x==='string'), 'VALIDATION_REJECTED', 'Submission requires behavior changes, regression cases and known risks');
  compileStrategy(s.strategy,options.domain);
  invariant(s.strategy.strategyId === options.baseline.strategyId && s.strategy.version !== options.baseline.version && s.strategy.parentVersion === options.baseline.version, 'VALIDATION_REJECTED', 'Candidate must be a new version of its bound baseline');
  invariant(s.strategy.provenance.researchRunId === options.run.id && s.strategy.provenance.snapshotId === options.run.researchSnapshotId, 'VALIDATION_REJECTED', 'Strategy provenance differs from submission');
  const checkPlan = candidateCheckPlan(options.baseline,s.strategy);
  invariant(checkPlan.changedSections.some(x=>['questions','stateProjection','decision'].includes(x)), 'VALIDATION_REJECTED', 'Candidate changes metadata only');
  const cases = [...s.expectedBehaviorChanges,...s.regressionCases];
  invariant(new Set(cases.map(c=>c.id)).size === cases.length, 'VALIDATION_REJECTED', 'Behavior case IDs must be unique');
  for (const c of cases) {
    invariant(c.observation.strategyScopeId === options.run.scopeId && c.observation.domainId === options.domain.id, 'VALIDATION_REJECTED', 'Case scope/domain mismatch');
    checkBehaviorCase(c,options.baseline,s.strategy,options.domain);
  }
  checkPlan.behaviorCaseIds = cases.map(c=>c.id);
  return { submission: structuredClone(s), checkPlan };
}
export interface ResearchBudget { maxWallTimeSeconds: number; maxTokensTotal: number; maxModelCalls: number; maxDecisionModelCalls: number; maxRepairAttempts: number }
export interface ResearchOrchestratorOptions {
  store: DuelLoopStore; domain: DomainDefinition; model: DecisionModel; evaluator: EvaluationAdapter;
  dependencies: BehaviorDependencies; providers: { researcher: ResearchProvider; adversary?: ResearchProvider; integrator?: ResearchProvider };
  mode?: 'single' | 'team'; budget?: Partial<ResearchBudget>; maxRounds?: number;
}
export interface ResearchResult { run: ResearchRun; submissionDigest?: string; validationDigest?: string; releaseDigest?: string; report?: ValidationReport }
export class ResearchOrchestrator {
  private readonly budget: ResearchBudget;
  private readonly maxRounds: number;
  private readonly controllers = new Map<string,AbortController>();
  constructor(private readonly options: ResearchOrchestratorOptions) {
    this.budget = { maxWallTimeSeconds: 600, maxTokensTotal: 60000, maxModelCalls: 12, maxDecisionModelCalls: 10000, maxRepairAttempts: 1, ...options.budget };
    for (const [key,value] of Object.entries(this.budget)) invariant(Number.isFinite(value) && Number.isSafeInteger(value) && value >= (key === 'maxRepairAttempts' ? 0 : 1), 'CONFIG_INVALID', `Invalid research budget ${key}`);
    this.maxRounds = options.maxRounds ?? 2;
    invariant(Number.isSafeInteger(this.maxRounds) && this.maxRounds > 0, 'CONFIG_INVALID', 'Invalid research round limit');
    invariant(options.dependencies.model === options.model.id && options.dependencies.modelKind === options.model.kind && options.dependencies.modelBehaviorDigest === modelBehaviorDigest(options.model) && options.domain.capabilities.evaluation, 'CONFIG_INVALID', 'Research requires matching evaluation model behavior and domain capability');
    if (options.mode === 'team') invariant(options.providers.adversary && options.providers.integrator, 'CONFIG_INVALID', 'Team mode requires all role providers');
  }
  /** Resource preflight does not claim the final holdout or create a research run. */
  protocolAvailability(input: EvaluationProtocol): {used:number;remaining:number} {
    const protocol=validateProtocol(input);
    invariant(protocol.domainId===this.options.domain.id,'CONFIG_INVALID','Protocol domain mismatch');
    this.options.store.registerHoldout(protocol);
    return this.options.store.holdoutAvailability(protocol.holdoutId,protocol.maxHoldoutUses);
  }
  private requireHoldout(protocol:EvaluationProtocol):void {
    const availability=this.protocolAvailability(protocol);
    invariant(availability.remaining>0,'HOLDOUT_UNAVAILABLE','Final evaluation resource exhausted; configure an independent new protocol before research',{holdoutId:protocol.holdoutId,...availability});
  }
  create(input: { id?: string; scopeId: string; protocol: EvaluationProtocol; developmentProtocol?: EvaluationProtocol; snapshotId?: string; snapshotOptions?:{maxDecisions?:number;maxFeedback?:number}; trigger?:{feedbackEventId:number;cutoff:number;settledTrajectories:number} }): ResearchRun {
    const { store, domain } = this.options;
    if(input.trigger)invariant(Number.isSafeInteger(input.trigger.feedbackEventId)&&input.trigger.feedbackEventId>0&&Number.isFinite(input.trigger.cutoff)&&Number.isSafeInteger(input.trigger.settledTrajectories)&&input.trigger.settledTrajectories>0,'CONFIG_INVALID','Invalid research trigger cursor');
    for(const limit of [input.snapshotOptions?.maxDecisions,input.snapshotOptions?.maxFeedback])invariant(limit===undefined||(Number.isSafeInteger(limit)&&limit>0&&limit<=10000),'CONFIG_INVALID','Snapshot limits must be positive integers up to 10000');
    const protocol = validateProtocol(input.protocol);
    invariant(protocol.domainId === domain.id, 'CONFIG_INVALID', 'Protocol domain mismatch');
    this.requireHoldout(protocol);
    const baseReleaseDigest = store.activeRelease(input.scopeId);
    invariant(baseReleaseDigest, 'NOT_FOUND', 'Research requires an active baseline release');
    invariant(digest(store.release(baseReleaseDigest).dependencies) === digest(this.options.dependencies), 'VERSION_INCOMPATIBLE', 'Baseline behavior dependencies differ from experimental dependencies');
    let developmentProtocolDigest: string | null = null;
    if (input.developmentProtocol) {
      const development = validateProtocol(input.developmentProtocol);
      invariant(development.domainId === domain.id && development.holdoutId !== protocol.holdoutId && !development.seeds.some(seed=>protocol.seeds.includes(seed)), 'CONFIG_INVALID', 'Development and holdout environments must be separate');
      developmentProtocolDigest = store.putArtifact('development_protocol',development);
    }
    const researchSnapshotId = input.snapshotId ?? store.snapshot(input.scopeId,input.trigger?.cutoff??Date.now(),input.snapshotOptions);
    const snapshot = store.getArtifact<{ scopeId?: string }>(researchSnapshotId);
    invariant(snapshot.scopeId === input.scopeId, 'ACCESS_DENIED', 'Research snapshot does not belong to this scope');
    return store.createRun({ id: input.id ?? randomUUID(), scopeId: input.scopeId, baseReleaseDigest, researchSnapshotId, evaluationProtocolDigest: store.putArtifact('evaluation_protocol',protocol,'private'), status: 'created', data: { developmentProtocolDigest, mode: this.options.mode ?? 'single', budget: jsonValue(this.budget), maxRounds: this.maxRounds,...(input.trigger?{trigger:jsonValue(input.trigger)}:{}) } });
  }
  cancel(id: string): ResearchRun {
    const run = this.options.store.cancelRun(id);
    this.controllers.get(id)?.abort();
    if (run.status === 'cancel_requested' && !this.controllers.has(id)) return this.options.store.transitionRun(id,['cancel_requested'],'cancelled');
    return run;
  }
  /** Interrupted remote work is not replayed: keep its budget spent and require a fresh run. */
  recover(id: string): ResearchRun {
    invariant(!this.controllers.has(id), 'CONFLICT', 'Cannot recover a running in-process research task');
    const { store } = this.options; const run = store.getRun(id);
    if(run.status==='validated_pending_release'||run.status==='completed_passed')return store.finalizeResearchPublication(id);
    if (run.status === 'cancel_requested') return store.transitionRun(id,['cancel_requested'],'cancelled');
    if (terminal.has(run.status) || run.status === 'created') return run;
    store.appendEvent('research.recovery_unknown_usage',run.scopeId,{runId:id,usage:{unknown:true}});
    return store.transitionRun(id,[run.status],'error',{error:'Interrupted experiment or model request cannot safely be replayed; spent budgets are retained'});
  }
  private assertRunning(id: string): ResearchRun {
    const run = this.options.store.getRun(id);
    const aborted = this.controllers.get(id)?.signal;
    if (aborted?.aborted) throw aborted.reason instanceof Error ? aborted.reason : new DuelLoopError('CANCELLED','Research cancelled');
    invariant(!terminal.has(run.status) && run.status !== 'cancel_requested', 'CANCELLED', 'Research is no longer active');
    invariant(Date.now() < run.createdAt + this.budget.maxWallTimeSeconds*1000, 'BUDGET_EXHAUSTED', 'Research wall clock budget exhausted');
    return run;
  }
  async run(id: string): Promise<ResearchResult> {
    const { store, domain, model, evaluator, dependencies, providers } = this.options;
    invariant(!this.controllers.has(id), 'CONFLICT', 'Research task is already running');
    const initial = store.getRun(id);
    invariant(initial.status === 'created', 'CONFLICT', 'Only a newly created task can start; recover interrupted tasks first');
    invariant(digest(initial.data.budget) === digest(this.budget) && initial.data.maxRounds === this.maxRounds && initial.data.mode === (this.options.mode ?? 'single'), 'CONFIG_INVALID', 'Research configuration changed after run creation');
    const controller = new AbortController();
    const deadline = initial.createdAt + this.budget.maxWallTimeSeconds*1000;
    const baseline = store.getArtifact<StrategyPackage>(store.release(initial.baseReleaseDigest).strategyDigest);
    const protocol = store.getArtifact<EvaluationProtocol>(initial.evaluationProtocolDigest,{allowPrivate:true});
    if(this.protocolAvailability(protocol).remaining===0) {
      const waiting=store.transitionRun(id,['created'],'waiting_protocol',{reason:'holdout_unavailable',requiresNewProtocol:true});
      return {run:waiting};
    }
    const snapshot = store.getArtifact<Json>(initial.researchSnapshotId);
    const evidence = collectEvidenceRefs(snapshot);
    // Claim outside the owner's cleanup catch: a losing worker must not fail the winner's run.
    store.transitionRun(id,['created'],'researching');
    this.controllers.set(id,controller);
    let outstandingProviderTokens=0,providerUsageUnknown=false,prechargedProviderTokens=0;
    const budgetedModel: DecisionModel = { id: model.id, kind: model.kind, behaviorIdentity:model.behaviorIdentity, score: async request => {
      try {
        const current = this.assertRunning(id);
        invariant(!providerUsageUnknown && (current.counters.tokens ?? 0)+outstandingProviderTokens < this.budget.maxTokensTotal,'BUDGET_EXHAUSTED','Joint research/evaluation token budget exhausted before model call');
        const callNumber=store.consumeBudget(id,'decisionModelCalls',this.budget.maxDecisionModelCalls);
        const account=(usage:unknown,outcome:'completed'|'failed'):void=>{
          const status=store.getRun(id).status;
          const late=controller.signal.aborted||status==='cancel_requested'||terminal.has(status);
          store.appendEvent('research.evaluation_model_usage',initial.scopeId,{runId:id,modelCallId:`${id}:evaluation:${callNumber}`,outcome,late,usage:jsonValue(usage??{unknown:true})},'private');
          invariant(knownTokenUsage(usage),'BUDGET_EXHAUSTED','Evaluation model token usage unknown; further paid calls stopped');
          if(status!=='cancel_requested'&&!terminal.has(status))store.consumeBudget(id,'tokens',this.budget.maxTokensTotal,usage.inputTokens+usage.outputTokens);
          invariant((store.getRun(id).counters.tokens??0)+outstandingProviderTokens<=this.budget.maxTokensTotal,'BUDGET_EXHAUSTED','Joint research/evaluation token budget exceeded');
        };
        let answer;
        try { answer=await model.score(request); }
        catch(error) { account(error instanceof DuelLoopError?error.context.usage:undefined,'failed');throw error; }
        account(answer.usage,'completed');
        this.assertRunning(id);
        return answer;
      } catch(error) { if(error instanceof DuelLoopError && error.code==='BUDGET_EXHAUSTED') controller.abort(error); throw error; }
    } };
    let latestSubmission: CandidateSubmission | undefined;
    let submissionDigest: string | undefined;
    let submissionRound=0;
    const sessions=new Map<ResearchProvider,Set<string>>(),pendingProviders=new Set<Promise<unknown>>();
    let shared: Json[] = [];
    const result = (): ResearchResult => ({ run: store.getRun(id), ...(submissionDigest ? {submissionDigest} : {}) });
    try {
      const submit = (input: unknown): Json => {
        this.assertRunning(id);
        invariant(store.getRun(id).status === 'researching', 'CONFLICT', 'Candidate cannot change after final lock or during evaluation');
        const checked = validateSubmission(input,{run:initial,baseline,domain,evidenceRefs:evidence});
        const existing = store.listArtifacts('candidate_submission').find(a=>(a.value as unknown as CandidateSubmission).submissionId===checked.submission.submissionId);
        invariant(!existing || existing.digest===digest(checked.submission), 'CONFLICT', 'A submission ID cannot be reused with different content');
        latestSubmission = checked.submission;
        submissionDigest = store.putArtifact('candidate_submission',latestSubmission);
        const checksDigest = store.putArtifact('candidate_checks',checked.checkPlan);
        store.appendEvent('research.candidate_submitted',initial.scopeId,{runId:id,submissionDigest,checksDigest,round:submissionRound});
        return jsonValue({submissionDigest,checkPlan:checked.checkPlan});
      };
      const schemas = submissionSchemas(initial,baseline);
      const tools: ResearchTool[] = [
        {name:'query_experience',description:'Browse the bound frozen research snapshot in small summary pages (default 5, maximum 20). Filter kind and use nextOffset to continue. Summaries are previews, not fixture input. Read one exact evidenceRef for the complete frozen record, optionally selecting fields such as observation, candidates and answers; questions are available explicitly when needed. Only returned evidenceRefs may support submission; no holdout data is accessible.',schema:experienceQuerySchema,execute:async(input)=>{this.assertRunning(id);return queryFrozenExperience(snapshot,initial.researchSnapshotId,input);}},
        {name:'read_strategy',description:'Read the bound baseline and public domain rules; no holdout data.',schema:{type:'object',properties:{},additionalProperties:false},execute:async()=>{this.assertRunning(id);return jsonValue({strategy:baseline,submissionContract:{schema:schemas.submission,fixtureSchema:schemas.fixture,assertionSchema,bindings:{researchRunId:id,baseReleaseDigest:initial.baseReleaseDigest,researchSnapshotId:initial.researchSnapshotId,evaluationProtocolDigest:initial.evaluationProtocolDigest},strategyBindings:{schemaVersion:'2.0',strategyId:baseline.strategyId,parentVersion:baseline.version,provenance:{researchRunId:id,snapshotId:initial.researchSnapshotId}},answerKeyTemplate:'{dimensionId}:{candidateId}',workflow:['Copy the full baseline strategy; choose your own supported modification and new string version. Set parentVersion and provenance from strategyBindings.','Browse query_experience summaries, then read an exact evidenceRef with fields [observation,candidates,answers] to obtain full development observations and legal actions. Define expected behavior and regression assertions using the declared operator schema.','Call register_behavior_fixture with candidate strategy, observation, candidates, exact-question answers and assertion. Copy its returned behaviorCase into the submission arrays.','Submit the full CandidateSubmission using bindings and exact evidenceRefs. Service-generated hashes remove any need to compute digests yourself.'],fixtureMeaning:'Hand-authored responses only check interpreter semantics; they do not establish real model quality.'},strategyLanguage:{unknownFields:'No undeclared fields are permitted in StrategyPackage or its objects.',versions:'schemaVersion, version, parentVersion and scope versions are strings. Choose a different version; keep strategyId, parentVersion, scope and provenance bindings as specified.',scoreDimension:{required:['id','type','forEach','instructions','criteria','normalization','semantics'],type:'score',forEach:'candidate',normalization:'divide_by_max_level',idPattern:'^[a-zA-Z0-9_-]+$',criteria:'2 through 10 nonempty, concrete grade descriptions. score is divided by criteria.length - 1.',semantics:{required:['target','horizon','continuation','overlap'],values:'Nonempty strings explaining objective, horizon, fixed continuation and intentional overlap.'}},decision:{required:['defaultWeights','branches','branchPolicy','aggregate','selection'],weights:'Every default and branch weight map must include exactly every question ID, with finite numeric values.',branchPolicy:'first_match',aggregate:'weighted_sum',branch:{required:['id','when','weights'],meaning:'Unique id; finite condition below; full weight map.'},selection:{argmax:{mode:'argmax',tieBreak:'domain_priority',temperature:'Omit this field entirely.'},softmax_sample:{mode:'softmax_sample',tieBreak:'domain_priority',temperature:'Required finite number in [0.000001, 1000000].'}}},conditions:{leaf:{required:['feature','op','value'],operators:['eq','gt','gte','lt','lte','in'],feature:'Known visible feature, or observation.isStale. Numeric comparisons require numeric features and values; in requires an array of compatible values.'},groups:['{all: [condition, ...]}','{any: [condition, ...]}','{not: condition}'],unknown:'Missing features remain unknown, including under not. Only true matches.'},modelAnswers:'Every action requires complete, valid model answers. Confidence is recorded, including zero; it never gates acceptance. Model failure stops execution without selecting an alternate action. Fixtures evaluate observation.isStale using observation.observedAt as their fixed clock, not the current wall clock.'},domain:{id:domain.id,rulesVersion:domain.rulesVersion,features:domain.features,context:domain.context}});}},
        {name:'query_research_history',description:'Read scope-local development history only. Earlier results are not current validation.',schema:{type:'object',properties:{},additionalProperties:false},execute:async()=>{this.assertRunning(id);return jsonValue(store.events({scopeId:initial.scopeId,types:['research.role_output','research.candidate_submitted','research.development_result'],limit:100,descending:true}).reverse());}},
        {name:'run_development_eval',description:'Evaluate a complete candidate strategy on the fixed development protocol, consuming one development budget.',schema:{type:'object',properties:{strategy:schemas.strategy},required:['strategy'],additionalProperties:false},execute:async(input)=>{
          this.assertRunning(id);
          invariant(input && typeof input==='object' && 'strategy' in input, 'CONFIG_INVALID','Missing development strategy');
          const strategy = compileStrategy((input as {strategy:StrategyPackage}).strategy,domain).strategy;
          const developmentDigest = initial.data.developmentProtocolDigest;
          invariant(typeof developmentDigest==='string', 'CAPABILITY_UNSUPPORTED','No development protocol configured');
          const development = store.getArtifact<EvaluationProtocol>(developmentDigest);
          store.consumeBudget(id,'developmentEvaluations',protocol.maxDevelopmentEvalRuns);
          store.transitionRun(id,['researching'],'development_evaluating');
          try {
            const report = await withDeadline(deadline,signal=>evaluateCandidate({candidate:strategy,baseline,protocol:development,adapter:evaluator,model:budgetedModel,dependencies,baseReleaseDigest:initial.baseReleaseDigest,stage:'development',signal,onEvidence:evidence=>{store.putArtifact('development_evaluation_evidence',{runId:id,...evidence});}}),controller.signal);
            this.assertRunning(id);
            const reportDigest = store.putArtifact('development_report',report);
            store.appendEvent('research.development_result',initial.scopeId,{runId:id,reportDigest,report});
            store.transitionRun(id,['development_evaluating'],'researching');
            return jsonValue(report);
          } catch(error) { if(store.getRun(id).status==='development_evaluating') store.transitionRun(id,['development_evaluating'],'researching'); throw error; }
        }},
        {name:'register_behavior_fixture',description:'Create a development behavior case without computing hashes yourself. Provide a complete candidate strategy, observation, legal candidates, hand-authored Score answers, finite assertion and case id. Service binds response fixtures to exact rendered questions. These fixtures test the interpreter, not model quality.',schema:schemas.fixture,execute:async(input)=>{
          this.assertRunning(id);
          invariant(input && typeof input==='object','CONFIG_INVALID','Expected fixture input');
          const value=input as BehaviorCase & {strategy:StrategyPackage};
          const strategy=compileStrategy(value.strategy,domain).strategy;
          const questionDigest=buildQuestions(strategy,value.observation,value.candidates,domain).questionDigest;
          const behaviorCase:BehaviorCase={id:value.id,observation:value.observation,candidates:value.candidates,answers:value.answers,assertion:value.assertion,questionDigest};
          invariant(value.observation.strategyScopeId===initial.scopeId && value.observation.domainId===domain.id,'ACCESS_DENIED','Fixture scope/domain mismatch');
          checkBehaviorCase(behaviorCase,baseline,strategy,domain);
          const fixtureDigest=store.putArtifact('development_behavior_fixture',{runId:id,source:'model_authored_fixture',strategyDigest:digest(strategy),behaviorCase});
          return jsonValue({fixtureDigest,behaviorCase});
        }},
        {name:'submit_candidate',description:'Submit the full CandidateSubmission with hypothesis, snapshot evidence, fresh bound response fixtures, behavior assertions and regression cases. No arbitrary test code.',schema:schemas.submission,execute:async(input)=>submit(input)}
      ];
      const publicGoal = {runId:id,scopeId:initial.scopeId,baseReleaseDigest:initial.baseReleaseDigest,researchSnapshotId:initial.researchSnapshotId,evaluationProtocolDigest:initial.evaluationProtocolDigest,metric:protocol.metric,minimumImprovement:protocol.minimumImprovement,maxGroupRegression:protocol.maxGroupRegression,maxP95DecisionComputeMs:protocol.maxP95DecisionComputeMs,budget:this.budget};
      for(let round=0;round<this.maxRounds;round++) {
        submissionRound=round;
        let reviseRequested = false;
        for(const role of ['researcher','adversary','integrator'] as const) {
          this.assertRunning(id);
          const provider = this.options.mode==='team' ? providers[role]! : providers.researcher;
          const sessionId = this.options.mode==='team' ? `${id}:${role}` : `${id}:single`;
          const providerSessions=sessions.get(provider)??new Set<string>();providerSessions.add(sessionId);sessions.set(provider,providerSessions);
          const allowedTools = this.options.mode==='team' && role!=='integrator' ? tools.filter(t=>t.name!=='submit_candidate') : tools;
          let completed = false;
          for(let repair=0;repair<=this.budget.maxRepairAttempts && !completed;repair++) {
            this.assertRunning(id);
            const spent = store.getRun(id).counters.tokens ?? 0;
            invariant(spent<this.budget.maxTokensTotal,'BUDGET_EXHAUSTED','Research token budget exhausted');
            this.requireHoldout(protocol);
            const callNumber = store.consumeBudget(id,'modelCalls',this.budget.maxModelCalls);
            const counters=store.getRun(id).counters;
            const roundsRemaining=this.maxRounds-round-1;
            const roleObjectives={
              researcher:'Investigate the visible experience and current strategy using the permitted tools. Form a specific supported hypothesis and concrete candidate changes. Read exact records when needed; use a development experiment when it resolves an uncertainty and budget permits. In a new round, address the previously identified unresolved issue with new analysis, a changed candidate or a tool result; do not merely repeat the old proposal or defer all work to a future round.',
              adversary:'Critique the current proposal using visible evidence: identify an exploitable case, unintended behavior change or untested assumption. Use permitted tools where they can resolve an issue. Distinguish supported counterexamples from speculation and report concrete findings for the integrator; do not simply copy the researcher output.',
              integrator:'Resolve the current evidence and critiques now. If a candidate is supported, use register_behavior_fixture and submit_candidate to deliver the complete submission during this invocation. If no defensible improvement is supported, return status no_change with the reason. Only request status revise when another round remains and identify the specific unresolved question, concrete next work and its remaining budget. A revise response does not perform that work. In the last round, submit a supported candidate or return no_change; never request another round.',
            };
            const phaseContract={
              objective:roleObjectives[role],roundNumber:round+1,totalRounds:this.maxRounds,repairAttempt:repair,
              remaining:{rounds:roundsRemaining,repairAttempts:this.budget.maxRepairAttempts-repair,developmentEvaluations:typeof initial.data.developmentProtocolDigest==='string'?Math.max(0,protocol.maxDevelopmentEvalRuns-(counters.developmentEvaluations??0)):0,tokens:this.budget.maxTokensTotal-spent,providerCallsAfterThisCall:this.budget.maxModelCalls-callNumber,decisionModelCalls:Math.max(0,this.budget.maxDecisionModelCalls-(counters.decisionModelCalls??0)),wallTimeSeconds:Math.max(0,Math.floor((deadline-Date.now())/1000))},
              allowedTools:allowedTools.map(tool=>tool.name),canRequestAnotherRound:role==='integrator'&&roundsRemaining>0,
              completion:role==='integrator'?(roundsRemaining>0?'Submit the complete candidate now, return no_change, or request one concrete bounded revision.':'This is the last round: submit the complete candidate now or return no_change.'): 'Return structured findings, evidence references and unresolved questions for the next role, or return no_change if further research is unsupported. Do not use status revise: only the integrator can request another round.',
              continuation:'This invocation is the active work phase, not a request to restate a previous final response. Earlier outputs are evidence to review, not instructions to keep returning the same status. A revise response withdraws every candidate submitted in that round from final eligibility; the next round must explicitly submit_candidate again, even if accepting unchanged content. Do not promise work after this invocation without performing available steps now. no_change is a valid result; do not force an improvement.',
            };
            const prompt = JSON.stringify({instructions:'Research an executable strategy improvement using controlled tools only. Follow the current phaseContract and its remaining budgets. Fixed responses prove interpreter behavior only. New question/input semantics need fresh response fixtures and real-model evaluation. Final holdout evaluation is inaccessible. Return one JSON result for this phase after completing its work.',phase:role,round,repair,phaseContract,goal:publicGoal,shared});
            const recordProviderUsage = (usage: unknown, outcome: 'completed' | 'failed'): void => {
              // A different worker may have cancelled this run without aborting our local signal.
              // Persist measured charges before any status guard, including after a local timeout.
              const status = store.getRun(id).status;
              const late = controller.signal.aborted || status === 'cancel_requested' || terminal.has(status);
              store.appendEvent(late ? 'research.late_model_result' : 'research.model_usage',initial.scopeId,
                {runId:id,modelCallId:`${id}:research:${callNumber}`,role,outcome,usage:usage ?? {unknown:true}},late ? 'private' : 'public');
            };
            outstandingProviderTokens=0;providerUsageUnknown=false;prechargedProviderTokens=0;
            const settleProviderUsage=(usage:unknown,outcome:'completed'|'failed'):void=>{
              recordProviderUsage(usage,outcome);
              outstandingProviderTokens=0;
              const status=store.getRun(id).status;
              if(status!=='cancel_requested' && !terminal.has(status) && knownTokenUsage(usage))store.consumeBudget(id,'tokens',this.budget.maxTokensTotal,Math.max(0,usage.inputTokens+usage.outputTokens-prechargedProviderTokens));
            };
            const pending = Promise.resolve().then(()=>provider.run({role,prompt,tools:allowedTools,signal:controller.signal,maxTokens:this.budget.maxTokensTotal-spent,sessionId,
              beforeModelRequest:()=>{try{this.assertRunning(id);}catch(error){controller.abort(error);throw error;}},
              getRemainingTokens:()=>Math.max(0,this.budget.maxTokensTotal-(store.getRun(id).counters.tokens??0)),
              onUsage:usage=>{
                if(!knownTokenUsage(usage)||usage.inputTokens+usage.outputTokens<outstandingProviderTokens)providerUsageUnknown=true;
                else outstandingProviderTokens=usage.inputTokens+usage.outputTokens;
                if(providerUsageUnknown || (store.getRun(id).counters.tokens??0)+outstandingProviderTokens>this.budget.maxTokensTotal)controller.abort(new DuelLoopError('BUDGET_EXHAUSTED',providerUsageUnknown?'Provider token usage unknown; further paid calls stopped':'Joint token budget exceeded'));
              },
            })).then(value=>{
              settleProviderUsage(value.usage,'completed'); return value;
            },error=>{
              const failedUsage = error instanceof DuelLoopError ? error.context.usage : undefined;
              settleProviderUsage(failedUsage,'failed');
              throw error;
            });
            pendingProviders.add(pending);void pending.then(()=>pendingProviders.delete(pending),()=>pendingProviders.delete(pending));
            // A synchronous onUsage abort can win before withDeadline enters its operation.
            // Observe pending immediately; its settlement still records measured late usage.
            void pending.catch(()=>{});
            const answer = await withDeadline(deadline,()=>pending,controller.signal);
            this.assertRunning(id);
            invariant(answer.usage && !answer.usage.unknown && Number.isSafeInteger(answer.usage.inputTokens) && Number.isSafeInteger(answer.usage.outputTokens) && answer.usage.inputTokens!>=0 && answer.usage.outputTokens!>=0,'BUDGET_EXHAUSTED','Provider token usage unknown; cannot enforce remaining budget');
            const output = jsonValue(answer.output);
            store.appendEvent('research.role_output',initial.scopeId,{runId:id,role,round,provider:provider.id,providerKind:provider.kind,output,usage:answer.usage});
            shared = [...shared,{role,round,output}].slice(-6);
            if(output && typeof output==='object' && !Array.isArray(output) && output.status==='no_change') { store.transitionRun(id,['researching'],'no_change'); return result(); }
            if(role==='integrator' && output && typeof output==='object' && !Array.isArray(output) && output.status==='revise') {
              if(submissionDigest)store.appendEvent('research.candidate_revision_requested',initial.scopeId,{runId:id,round,submissionDigest});
              latestSubmission=undefined;submissionDigest=undefined;
              invariant(round+1<this.maxRounds,'BUDGET_EXHAUSTED','Research round budget exhausted'); reviseRequested=true;completed=true;
            } else if(role==='integrator' && !latestSubmission) {
              if(repair===this.budget.maxRepairAttempts) throw new DuelLoopError('VALIDATION_REJECTED','Integrator did not submit a valid candidate or no_change');
              shared.push({error:'No accepted candidate: use submit_candidate, or return status no_change'});
            } else completed=true;
          }
        }
        if(latestSubmission && !reviseRequested) break;
      }
      this.assertRunning(id);
      invariant(latestSubmission && submissionDigest,'VALIDATION_REJECTED','No candidate was submitted');
      const locked = latestSubmission;
      store.transitionRun(id,['researching'],'candidate_locked',{submissionDigest});
      store.consumeBudget(id,'finalEvaluations',protocol.maxFinalEvaluationsPerRun);
      store.transitionRun(id,['candidate_locked'],'final_evaluating');
      store.claimHoldout(protocol.holdoutId,id,protocol.maxHoldoutUses);
      let evidenceDigest: string | undefined;
      const pending = evaluateCandidate({candidate:locked.strategy,baseline,protocol,adapter:evaluator,model:budgetedModel,dependencies,baseReleaseDigest:initial.baseReleaseDigest,stage:'final',signal:controller.signal,onEvidence:evidence=>{evidenceDigest=store.putArtifact('final_evaluation_evidence',{runId:id,...evidence},'private');}});
      pending.then(report=>{if(controller.signal.aborted) store.putArtifact('late_final_report',report,'private');},()=>{});
      const report = await withDeadline(deadline,()=>pending,controller.signal);
      this.assertRunning(id);
      const validated=store.recordFinalValidation(id,report,evidenceDigest);
      const validationDigest=validated.data.validationDigest as string;
      const releaseDigest=report.status==='passed'?store.finalizeResearchPublication(id).data.releaseDigest as string:undefined;
      return {...result(),validationDigest,report,...(releaseDigest?{releaseDigest}:{})};
    } catch(error) {
      if (!controller.signal.aborted) controller.abort(error);
      let run = store.getRun(id);
      if(run.status==='validated_pending_release') {
        store.appendEvent('research.publication_deferred',initial.scopeId,{runId:id,error:error instanceof DuelLoopError?error.code:'PUBLICATION_FAILURE'});
        throw error;
      }
      if(run.status!=='cancel_requested' && !terminal.has(run.status) && outstandingProviderTokens>0) {
        const charge=Math.min(outstandingProviderTokens,Math.max(0,this.budget.maxTokensTotal-(run.counters.tokens??0)));
        if(charge>0){store.consumeBudget(id,'tokens',this.budget.maxTokensTotal,charge);prechargedProviderTokens+=charge;outstandingProviderTokens-=charge;}
        run=store.getRun(id);
      }
      if(run.status==='cancel_requested') store.transitionRun(id,['cancel_requested'],'cancelled');
      else if(!terminal.has(run.status)) {
        const reason = controller.signal.reason;
        const exhausted = (error instanceof DuelLoopError && ['BUDGET_EXHAUSTED','MODEL_TIMEOUT'].includes(error.code)) || (reason instanceof DuelLoopError && reason.code === 'BUDGET_EXHAUSTED');
        store.transitionRun(id,[run.status],error instanceof DuelLoopError&&error.code==='HOLDOUT_UNAVAILABLE'?'waiting_protocol':exhausted?'budget_exhausted':'error',{error:error instanceof Error?error.message:'Unknown research failure',...(error instanceof DuelLoopError&&error.code==='HOLDOUT_UNAVAILABLE'?{reason:'holdout_unavailable',requiresNewProtocol:true}:{})});
      }
      store.appendEvent('research.ended',initial.scopeId,{runId:id,status:store.getRun(id).status,error:error instanceof DuelLoopError?error.code:'RESEARCH_FAILURE',usageUnknown:!knownTokenUsage(error instanceof DuelLoopError ? error.context.usage : undefined)});
      return result();
    } finally {
      this.controllers.delete(id);
      const releaseSessions=async()=>{
        for(const [provider,ids] of sessions)for(const sessionId of ids) {
          try{await provider.releaseSession?.(sessionId);}
          catch(error){try{store.appendEvent('research.session_release_failed',initial.scopeId,{runId:id,provider:provider.id,sessionId,error:error instanceof DuelLoopError?error.code:'SESSION_RELEASE_FAILURE'});}catch{}}
        }
      };
      // Return cancellation/timeouts promptly; release after late usage is accounted for.
      if(pendingProviders.size)void Promise.allSettled([...pendingProviders]).then(releaseSessions).catch(()=>{});
      else await releaseSessions();
    }
  }
}
function knownTokenUsage(value: unknown): value is {inputTokens:number;outputTokens:number} {
  if (!value || typeof value !== 'object') return false;
  const usage = value as {unknown?:boolean;inputTokens?:number;outputTokens?:number};
  return !usage.unknown && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens!>=0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens!>=0;
}
function collectEvidenceRefs(snapshot: Json): Set<string> {
  const refs = new Set<string>();
  if (snapshot && typeof snapshot==='object' && !Array.isArray(snapshot) && Array.isArray(snapshot.evidenceRefs)) {
    for (const ref of snapshot.evidenceRefs) if (typeof ref==='string') refs.add(ref);
    return refs;
  }
  const visit = (value: Json): void => {
    if(!value || typeof value!=='object') return;
    if(Array.isArray(value)) { value.forEach(visit); return; }
    if(typeof value.decisionId==='string') refs.add(value.decisionId);
    if(typeof value.feedbackId==='string' && typeof value.revision==='number') refs.add(`${value.feedbackId}@${value.revision}`);
    if(typeof value.id==='number' && typeof value.type==='string') refs.add(`event:${value.id}`);
    Object.values(value).forEach(visit);
  };
  visit(snapshot); return refs;
}


const experienceQuerySchema: Record<string, Json> = {
  type:'object',additionalProperties:false,properties:{
    kind:{type:'string',enum:['all','decision','feedback'],description:'Default all; decision records precede feedback in stable frozen-snapshot order.'},
    offset:{type:'integer',minimum:0,description:'Zero-based offset within the selected kind; use nextOffset from the previous page.'},
    limit:{type:'integer',minimum:1,maximum:20,description:'Summary page size, default 5. Full records are read one at a time by evidenceRef.'},
    evidenceRef:{type:'string',minLength:1,description:'Exact reference from a summary page. Returns that frozen decision or feedback revision, never current mutable state.'},
    fields:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'string',minLength:1,maxLength:100},description:'Only with evidenceRef. Optional top-level field selection, e.g. observation,candidates,answers; omitted returns the complete record.'},
  },
};
function queryFrozenExperience(snapshot: Json, snapshotId: string, input: unknown): Json {
  invariant(input && typeof input==='object' && !Array.isArray(input),'CONFIG_INVALID','Expected experience query object');
  const query=input as Record<string,unknown>;
  invariant(Object.keys(query).every(key=>['kind','offset','limit','evidenceRef','fields'].includes(key)),'CONFIG_INVALID','Unknown experience query field');
  const kind=query.kind??'all',offset=query.offset??0,limit=query.limit??5;
  invariant(['all','decision','feedback'].includes(kind as string),'CONFIG_INVALID','Unknown experience kind');
  invariant(Number.isSafeInteger(offset) && (offset as number)>=0,'CONFIG_INVALID','Experience offset must be a nonnegative integer');
  invariant(Number.isSafeInteger(limit) && (limit as number)>=1 && (limit as number)<=20,'CONFIG_INVALID','Experience limit must be between 1 and 20');
  invariant(snapshot && typeof snapshot==='object' && !Array.isArray(snapshot),'CONFIG_INVALID','Invalid frozen snapshot');
  const records: {kind:'decision'|'feedback';evidenceRef:string;record:Record<string,Json>}[]=[];
  for(const [recordKind,field] of [['decision','decisions'],['feedback','feedback']] as const) {
    const values=snapshot[field];
    invariant(values===undefined || Array.isArray(values),'CONFIG_INVALID','Invalid snapshot record collection');
    for(const value of values??[]) {
      invariant(value && typeof value==='object' && !Array.isArray(value),'CONFIG_INVALID','Invalid snapshot record');
      const ref=recordKind==='decision'?value.decisionId:`${value.feedbackId}@${value.revision}`;
      invariant(typeof ref==='string' && ref.length>0,'CONFIG_INVALID','Snapshot record has no evidence reference');
      records.push({kind:recordKind,evidenceRef:ref,record:value});
    }
  }
  const counts={decision:records.filter(item=>item.kind==='decision').length,feedback:records.filter(item=>item.kind==='feedback').length};
  const metadata={snapshotId,scopeId:snapshot.scopeId,cutoff:snapshot.cutoff,counts};
  if(query.evidenceRef!==undefined) {
    invariant(typeof query.evidenceRef==='string' && query.evidenceRef.length>0,'CONFIG_INVALID','Invalid evidence reference');
    invariant(query.offset===undefined && query.limit===undefined,'CONFIG_INVALID','An exact evidence lookup cannot also paginate');
    const item=records.find(item=>item.evidenceRef===query.evidenceRef && (kind==='all'||item.kind===kind));
    invariant(item,'ACCESS_DENIED','Evidence reference is not present in the selected frozen snapshot');
    let record=item.record;
    if(query.fields!==undefined) {
      invariant(Array.isArray(query.fields) && query.fields.length>=1 && query.fields.length<=20 && new Set(query.fields).size===query.fields.length && query.fields.every(field=>typeof field==='string' && field.length>=1 && field.length<=100 && Object.hasOwn(record,field)),'CONFIG_INVALID','Select existing top-level fields of the frozen record');
      record=Object.fromEntries(query.fields.map(field=>[field as string,record[field as string]!]));
    }
    return jsonValue({...metadata,kind:item.kind,evidenceRef:item.evidenceRef,evidenceRefs:[item.evidenceRef],record});
  }
  invariant(query.fields===undefined,'CONFIG_INVALID','Field selection requires an exact evidenceRef');
  const selected=records.filter(item=>kind==='all'||item.kind===kind);
  const page=selected.slice(offset as number,(offset as number)+(limit as number));
  const items=page.map(item=>{
    const keys=item.kind==='decision'?['decisionId','decisionSource','action','stopReason','observation','utilities','probabilities']:['feedbackId','revision','trajectoryId','eventTime','receivedAt','settled','metrics'];
    const preview=JSON.stringify(Object.fromEntries(keys.filter(key=>Object.hasOwn(item.record,key)).map(key=>[key,item.record[key]])));
    // The cap is per summary, regardless of the domain's feature/state size. Full data stays addressable.
    const summary=preview.length<=1600?JSON.parse(preview):{excerpt:preview.slice(0,1600),truncated:true};
    return {kind:item.kind,evidenceRef:item.evidenceRef,summary};
  });
  return jsonValue({...metadata,kind,offset,limit,total:selected.length,nextOffset:(offset as number)+page.length<selected.length?(offset as number)+page.length:null,items,evidenceRefs:page.map(item=>item.evidenceRef),readRecord:'Use evidenceRef to fetch one full frozen record; fields optionally selects its top-level fields. Summaries may be truncated and must not be used as complete fixture input.'});
}
