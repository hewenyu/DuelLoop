import { randomUUID } from 'node:crypto';
import { DuelLoopError, invariant } from './errors.js';
import { buildQuestions, compileStrategy, evaluateAnswers, validateScoreAnswer } from './strategy.js';
import { canonicalize, digest, seededRandom, withDeadline } from './utils.js';
import type { ActionCommand, BehaviorDependencies, CandidateAction, DecisionModel, DecisionRecord, DomainDefinition, DuelLoopStore, ExecutionMode, ExecutionReceipt, FeedbackEvent, JournalEvent, ModelUsage, Observation, StrategyPackage, ValidationReport } from './types.js';

export interface DuelLoopOptions {
  applicationId: string; domain: DomainDefinition; model: DecisionModel; store: DuelLoopStore;
  mode?: ExecutionMode; executionOwner?: 'framework'|'host';
  maxDecisionMs?: number; executionReserveMs?: number; randomSeed?: string;
}
export const RUNTIME_VERSION = 'duelloop-runtime-3';
function measuredUsage(value:unknown):ModelUsage {
  const usage=value&&typeof value==='object'?value as Record<string,unknown>:{};
  const known=(key:string)=>Number.isSafeInteger(usage[key])&&(usage[key] as number)>=0;
  return {unknown:usage.unknown===true||!known('inputTokens')||!known('outputTokens'),
    ...(known('inputTokens')?{inputTokens:usage.inputTokens as number}:{}),
    ...(known('outputTokens')?{outputTokens:usage.outputTokens as number}:{}),
    ...(typeof usage.costUsd==='number'&&Number.isFinite(usage.costUsd)&&usage.costUsd>=0?{costUsd:usage.costUsd}:{})};
}
export function decisionPolicyRuntimeVersion(timing:{maxDecisionMs?:number;executionReserveMs?:number;randomSeed?:string}={}):string {
  const policy={maxDecisionMs:timing.maxDecisionMs??5000,executionReserveMs:timing.executionReserveMs??25,randomSeed:timing.randomSeed??null};
  return `${RUNTIME_VERSION}:${digest(policy)}`;
}
export function behaviorDependencies(domain:DomainDefinition,model:DecisionModel,timing:{maxDecisionMs?:number;executionReserveMs?:number;randomSeed?:string}={}):BehaviorDependencies {
  return {model:model.id,runtime:decisionPolicyRuntimeVersion(timing),rules:domain.rulesVersion,featureBuilder:domain.featureBuilderVersion,
    knowledgeUpdater:domain.knowledgeUpdaterVersion,
    continuationPolicy:domain.continuationVersion,contextDigest:digest(domain.context)};
}
export class DuelLoop {
  readonly domain:DomainDefinition; readonly model:DecisionModel; readonly store:DuelLoopStore;
  readonly applicationId:string; readonly mode:ExecutionMode; readonly executionOwner:'framework'|'host';
  private readonly ownerId=randomUUID(); private readonly owners=new Map<string,string>();
  private readonly listeners=new Set<(event:JournalEvent)=>void>(); private readonly busy=new Set<string>();
  private stopping=false; private closed=false; private readonly pending=new Set<Promise<unknown>>();
  private failure?:{decisionId:string;code:string};
  private maxDecisionMs:number; private reserve:number; private randomSeed?:string;
  constructor(options:DuelLoopOptions) {
    invariant(options.applicationId?.length>0,'CONFIG_INVALID','applicationId required');
    this.applicationId=options.applicationId;this.domain=options.domain;this.model=options.model;this.store=options.store;
    this.mode=options.mode??'offline';this.executionOwner=options.executionOwner??'host';
    invariant(['offline','simulation','shadow','live'].includes(this.mode),'CONFIG_INVALID','Unsupported execution mode');
    invariant(['framework','host'].includes(this.executionOwner),'CONFIG_INVALID','Unsupported execution owner');
    invariant(this.mode!=='offline'||this.model.kind==='fixture','CONFIG_INVALID','Offline mode cannot call a real model');
    invariant(this.mode!=='live'||this.model.kind==='real','CONFIG_INVALID','Live execution requires a real decision model');
    invariant(this.executionOwner==='host'||this.mode==='shadow'||!!this.domain.execute&&this.domain.capabilities.execution,'CAPABILITY_UNSUPPORTED','Domain cannot execute');
    this.maxDecisionMs=options.maxDecisionMs??5000;this.reserve=options.executionReserveMs??25;this.randomSeed=options.randomSeed;
    invariant(Number.isFinite(this.maxDecisionMs)&&this.maxDecisionMs>0&&Number.isFinite(this.reserve)&&this.reserve>=0&&this.reserve<this.maxDecisionMs,'CONFIG_INVALID','Invalid time budget');
  }
  get dependencies():BehaviorDependencies{return behaviorDependencies(this.domain,this.model,{maxDecisionMs:this.maxDecisionMs,executionReserveMs:this.reserve,randomSeed:this.randomSeed});}
  bootstrap(strategy:StrategyPackage,scopeId:string):string {
    this.ensureOpen();this.store.bindScope(scopeId,this.applicationId);const compiled=compileStrategy(strategy,this.domain);
    const strategyDigest=this.store.putArtifact('strategy',compiled.strategy);
    const releaseDigest=this.store.registerRelease({strategyDigest,dependencies:this.dependencies,scopeId,expectedActiveDigest:null,validationDigest:null,source:'bootstrap'});
    this.store.activate(releaseDigest,this.dependencies,{explicit:true});this.emit('runtime.bootstrap',scopeId,{releaseDigest});return releaseDigest;
  }
  async activate(releaseDigest:string,explicit=false):Promise<void> {
    const binding=this.store.release(releaseDigest);
    this.ensureOpen();this.store.bindScope(binding.scopeId,this.applicationId);
    if(this.mode==='live'&&binding.validationDigest){const report=this.store.getArtifact<ValidationReport>(binding.validationDigest,{allowPrivate:true});invariant(report.modelKind==='real','VALIDATION_REJECTED','Fixture evaluation cannot authorize live activation');}
    if(this.domain.capabilities.activationBoundary==='scope') {
      invariant(this.domain.canActivate,'CAPABILITY_UNSUPPORTED','Scope-wide boundary check required');
      if(!await this.domain.canActivate(binding.scopeId)){this.emit('release.deferred',binding.scopeId,{releaseDigest,reason:'scope_boundary'});throw new DuelLoopError('CONFLICT','Scope activation boundary unavailable');}
    }
    this.store.activate(releaseDigest,this.dependencies,{explicit});this.emit('runtime.activated',binding.scopeId,{releaseDigest});
  }
  async rollback(scopeId:string,target:string):Promise<void> {
    this.ensureOpen();this.store.bindScope(scopeId,this.applicationId);
    const binding=this.store.release(target);invariant(binding.scopeId===scopeId,'CONFLICT','Wrong rollback scope');
    if(this.mode==='live'&&binding.validationDigest){const report=this.store.getArtifact<ValidationReport>(binding.validationDigest,{allowPrivate:true});invariant(report.modelKind==='real','VALIDATION_REJECTED','Fixture evaluation cannot authorize live rollback');}
    if(this.domain.capabilities.activationBoundary==='scope'){
      invariant(this.domain.canActivate,'CAPABILITY_UNSUPPORTED','Scope-wide boundary check required');
      invariant(await this.domain.canActivate(scopeId),'CONFLICT','Rollback requires an activation checkpoint');
    }
    this.store.rollback(scopeId,target,this.dependencies);
    this.emit('runtime.rolled_back',scopeId,{releaseDigest:target});
  }
  async decide(observation:Observation,candidates?:CandidateAction[]):Promise<DecisionRecord> {
    invariant(!this.failure,'DECISION_STOPPED','Runtime failed; inspect the stopped decision before creating a new instance',this.failure);
    this.ensureOpen();invariant(!this.stopping,'CANCELLED','Runtime stopped accepting decisions');
    const startedAt=Date.now();const deadline=Math.min(observation.deadline,startedAt+this.maxDecisionMs);
    this.validateObservation(observation);
    this.store.bindScope(observation.strategyScopeId,this.applicationId);
    invariant(deadline>Date.now(),'STATE_STALE','Observation deadline expired');
    const actions=candidates??await withDeadline(deadline,()=>this.domain.candidates(observation));this.validateCandidates(actions,observation);
    const releaseDigest=this.store.trajectoryRelease(observation.strategyScopeId,observation.streamId,observation.actorId,observation.trajectoryId);
    const binding=this.store.release(releaseDigest);
    this.store.assertReleaseEligible(releaseDigest,this.dependencies);
    invariant(digest(binding.dependencies)===digest(this.dependencies),'VERSION_INCOMPATIBLE','Bound release is incompatible with current runtime');
    const strategy=compileStrategy(this.store.getArtifact<StrategyPackage>(binding.strategyDigest),this.domain).strategy;
    const record:DecisionRecord={decisionId:randomUUID(),observation:{...structuredClone(observation),deadline},candidates:structuredClone(actions),releaseDigest,strategyDigest:binding.strategyDigest,
      decisionSource:'stopped',action:null,questions:[],answers:{},utilities:{},probabilities:{},startedAt,finishedAt:startedAt};
    try {
        invariant(actions.length>0,'DECISION_STOPPED','No legal candidate; no action was selected',{reason:'NO_LEGAL_ACTION'});
        const request=buildQuestions(strategy,observation,actions,this.domain);record.questions=request.questions;
        record.modelKind=this.model.kind;record.model=this.model.id;
        const response=await withDeadline(deadline-this.reserve,signal=>{
          invariant(!this.stopping,'CANCELLED','Runtime stopped before model request');
          const pending=this.model.score({...request,signal});
          const late=(usage:unknown,outcome:'completed'|'failed')=>{
            if(!signal.aborted)return;
            // Late accounting never mutates the immutable stopped decision or resumes execution.
            try{this.emit('decision.late_model_result',observation.strategyScopeId,{decisionId:record.decisionId,model:this.model.id,outcome,usage:measuredUsage(usage)});}
            catch{/* The host may already have closed the store after the failed step. */}
          };
          void pending.then(value=>late(value?.usage,'completed'),error=>late(error instanceof DuelLoopError?error.context.usage:undefined,'failed'));
          return pending;
        });
        record.usage=measuredUsage(response?.usage);
        invariant(response&&typeof response.model==='string'&&response.model.length>0,'MODEL_INVALID','Model response identity is missing');
        record.model=response.model;
        invariant(response.model===this.model.id || this.model.kind==='fixture','VERSION_INCOMPATIBLE','Model returned a different version; rebind and revalidate before use',{requested:this.model.id,actual:response.model});
        invariant(response.answers&&typeof response.answers==='object'&&!Array.isArray(response.answers),'MODEL_INVALID','Missing model answers');
        invariant(Object.keys(response.answers).length===request.questions.length,'MODEL_INVALID','Model answer count differs from requested questions');
        for(const question of request.questions){
          const answer=response.answers[question.id];validateScoreAnswer(answer,question.criteria.length);
          // Persist only validated JSON fields, including valid answers preceding a malformed one.
          record.answers[question.id]={score:answer.score,confidence:answer.confidence,probabilities:{...answer.probabilities}};
        }
        invariant(!this.stopping,'CANCELLED','Runtime stopped while the model was answering');
        invariant(Date.now()<deadline,'MODEL_TIMEOUT','Decision expired before model answers could be used');
        const seed=this.randomSeed===undefined?undefined:`${this.randomSeed}:${observation.trajectoryId}:${observation.revision}`;
        const result=evaluateAnswers(strategy,observation,actions,record.answers,seed===undefined?undefined:seededRandom(seed));
        Object.assign(record,result,{decisionSource:'strategy'});if(seed!==undefined)record.randomSeed=seed;
    } catch(error) {
      const failure=error instanceof DuelLoopError?error:new DuelLoopError('MODEL_INVALID','Decision model failed');
      record.decisionSource='stopped';record.action=null;record.utilities={};record.probabilities={};
      record.stopReason=typeof failure.context.reason==='string'?failure.context.reason:failure.code;
      if(!record.usage&&failure.context.usage)record.usage=measuredUsage(failure.context.usage);
      if(record.model&&!record.usage)record.usage={unknown:true};
      record.finishedAt=Date.now();
      this.stopping=true;this.failure??={decisionId:record.decisionId,code:record.stopReason};
      this.store.putArtifact('decision',record);this.emit('decision',observation.strategyScopeId,record);
      this.emit('runtime.stopped',observation.strategyScopeId,{decisionId:record.decisionId,reason:record.stopReason});
      throw new DuelLoopError(failure.code,failure.message,{...failure.context,decisionId:record.decisionId,stopReason:record.stopReason});
    }
    record.finishedAt=Date.now();this.store.putArtifact('decision',record);this.emit('decision',observation.strategyScopeId,record);return record;
  }
  async step(streamId:string):Promise<{decision:DecisionRecord;receipt:ExecutionReceipt|null}> {
    this.ensureOpen();invariant(!this.stopping,'CANCELLED','Runtime stopping');invariant(!this.busy.has(streamId),'CONFLICT','Concurrent decision on same stream');
    this.busy.add(streamId);
    const task=(async()=>{
      const started=Date.now();const deadline=started+this.maxDecisionMs;
      const observation=await withDeadline(deadline,()=>this.domain.observe(streamId));
      observation.deadline=Math.min(observation.deadline,deadline);
      const unresolved=this.store.intents(observation.strategyScopeId).filter(i=>i.streamId===streamId&&(!i.receipt||['unknown','accepted'].includes(i.receipt.status)));
      invariant(this.executionOwner==='host'||this.mode==='shadow'||unresolved.length===0,'EXECUTION_UNKNOWN','Unresolved prior execution requires reconciliation');
      const decision=await this.decide(observation);let receipt:ExecutionReceipt|null=null;
      if(this.mode!=='shadow'&&this.executionOwner==='framework'&&decision.action)receipt=await this.executeDecision(decision);
      await this.submitFeedback();await this.activatePending(observation.strategyScopeId);return {decision,receipt};
    })();
    this.pending.add(task);try{return await task;}finally{this.busy.delete(streamId);this.pending.delete(task);}
  }
  async executeDecision(decision:DecisionRecord):Promise<ExecutionReceipt> {
    this.ensureOpen();invariant(this.mode!=='shadow'&&this.executionOwner==='framework','ACCESS_DENIED','This runtime does not own execution');
    this.validateObservation(decision.observation);this.store.bindScope(decision.observation.strategyScopeId,this.applicationId);
    const existing=this.store.intents(decision.observation.strategyScopeId).find(i=>i.decisionId===decision.decisionId);
    if(existing?.receipt)return existing.receipt;
    const command=await this.prepareExecution(decision);
    let receipt:ExecutionReceipt;let sent=false;
    try {receipt=await withDeadline(command.deadline,()=>{
      invariant(!this.stopping,'CANCELLED','Runtime stopped before sending the action');
      sent=true;return this.domain.execute!(command);
    });}
    catch(error){
      receipt={decisionId:decision.decisionId,idempotencyKey:decision.decisionId,status:sent?'unknown':'rejected',timestamp:Date.now(),
        ...(!sent?{details:{reason:'STOPPED_BEFORE_SEND'}}:{})};
      if(!sent){this.store.recordReceipt(receipt);throw error;}
    }
    invariant(receipt.decisionId===decision.decisionId&&receipt.idempotencyKey===decision.decisionId,'EXECUTION_UNKNOWN','Receipt does not match intent');
    this.store.recordReceipt(receipt);return receipt;
  }
  async prepareHostExecution(decision:DecisionRecord):Promise<ActionCommand>{
    this.ensureOpen();invariant(this.executionOwner==='host'&&this.mode!=='shadow','ACCESS_DENIED','Host execution is disabled');
    return this.prepareExecution(decision);
  }
  private async prepareExecution(decision:DecisionRecord):Promise<ActionCommand>{
    invariant(!this.stopping,'CANCELLED','Runtime stopped accepting execution');
    invariant(decision.decisionSource==='strategy'&&!decision.stopReason&&decision.model&&decision.questions.length>0,'ACCESS_DENIED','Only a successful model decision may execute');
    invariant(decision.action,'CONFIG_INVALID','No action to execute');
    const obs=decision.observation;this.validateObservation(obs);this.store.bindScope(obs.strategyScopeId,this.applicationId);
    this.store.assertReleaseEligible(decision.releaseDigest,this.dependencies);
    const saved=this.store.getArtifact<DecisionRecord>(digest(decision));invariant(saved.decisionId===decision.decisionId,'CONFIG_INVALID','Decision not issued by this store');
    const existing=this.store.intents(obs.strategyScopeId).find(i=>i.decisionId===decision.decisionId);
    invariant(!existing,'EXECUTION_UNKNOWN','Prior intent must be reconciled before another submission');
    invariant(Date.now()<obs.deadline,'STATE_STALE','Decision expired before execution');
    const fresh=await withDeadline(obs.deadline,()=>this.domain.observe(obs.streamId));
    invariant(fresh.revision===obs.revision&&fresh.trajectoryId===obs.trajectoryId&&fresh.actorId===obs.actorId,'STATE_STALE','Environment changed before execution');
    const legal=await withDeadline(obs.deadline,()=>this.domain.candidates(fresh));
    invariant(legal.some(a=>canonicalize(a)===canonicalize(decision.action)),'STATE_STALE','Action no longer legal');
    invariant(!this.stopping&&Date.now()<obs.deadline,'STATE_STALE','Execution stopped or decision expired');
    const key=`${obs.strategyScopeId}\0${obs.streamId}`;
    let token=this.owners.get(key);if(!token){token=this.store.acquireOwner(obs.strategyScopeId,obs.streamId,this.ownerId);this.owners.set(key,token);}
    this.store.assertOwner(obs.strategyScopeId,obs.streamId,token);
    const command={decisionId:decision.decisionId,idempotencyKey:decision.decisionId,expectedStateRevision:obs.revision,observation:obs,action:decision.action,deadline:obs.deadline,ownerToken:token};
    this.store.saveIntent({decisionId:decision.decisionId,scopeId:obs.strategyScopeId,streamId:obs.streamId,ownerToken:token,command,receipt:null});
    this.store.assertOwner(obs.strategyScopeId,obs.streamId,token);
    return command;
  }
  recordHostReceipt(decision:DecisionRecord,receipt:ExecutionReceipt):void {
    this.ensureOpen();this.validateObservation(decision.observation);this.store.bindScope(decision.observation.strategyScopeId,this.applicationId);
    invariant(this.executionOwner==='host'&&this.mode!=='shadow','ACCESS_DENIED','Host receipt unavailable in this mode');
    invariant(decision.action&&receipt.decisionId===decision.decisionId&&receipt.idempotencyKey===decision.decisionId,'CONFIG_INVALID','Host receipt must refer to decision ID');
    this.store.getArtifact(digest(decision));
    this.store.recordReceipt(receipt);
    this.emit('host.execution.receipt',decision.observation.strategyScopeId,receipt);
  }
  async activatePending(scopeId:string):Promise<string|null> {
    this.ensureOpen();this.store.bindScope(scopeId,this.applicationId);
    const current=this.store.activeRelease(scopeId);
    const activated=new Set(this.store.events({scopeId}).filter(e=>e.type==='release.activated').map(e=>(e.data as {releaseDigest:string}).releaseDigest));
    for(const artifact of this.store.listArtifacts('release')) {
      const binding=this.store.release(artifact.digest);
      if(binding.scopeId!==scopeId||binding.source!=='research'||binding.expectedActiveDigest!==current||artifact.digest===current||activated.has(artifact.digest))continue;
      try {await this.activate(artifact.digest);return artifact.digest;}
      catch(error){if(!(error instanceof DuelLoopError)||!['CONFLICT','VALIDATION_REJECTED','VERSION_INCOMPATIBLE'].includes(error.code))throw error;}
    }return null;
  }
  async submitFeedback(input?:FeedbackEvent|FeedbackEvent[]):Promise<void> {
    const feedback=input?(Array.isArray(input)?input:[input]):await this.domain.feedback?.()??[];
    this.ensureOpen();
    for(const f of feedback){invariant(f.applicationId===this.applicationId,'ACCESS_DENIED','Feedback application mismatch');this.store.bindScope(f.strategyScopeId,this.applicationId);this.store.recordFeedback(f);}
  }
  async reconcile(scopeId?:string):Promise<ExecutionReceipt[]> {
    this.ensureOpen();if(scopeId)this.store.bindScope(scopeId,this.applicationId);
    invariant(this.domain.capabilities.statusQuery&&this.domain.executionStatus,'CAPABILITY_UNSUPPORTED','Domain cannot query unknown executions');
    const receipts:ExecutionReceipt[]=[];
    for(const intent of this.store.intents(scopeId).filter(i=>!i.receipt||['unknown','accepted'].includes(i.receipt.status))) {
      if(!scopeId&&(intent.command.observation.applicationId!==this.applicationId||intent.command.observation.domainId!==this.domain.id))continue;
      this.validateObservation(intent.command.observation);
      this.store.bindScope(intent.scopeId,this.applicationId);
      const receipt=await withDeadline(Date.now()+this.maxDecisionMs,()=>this.domain.executionStatus!(intent.command.idempotencyKey));
      invariant(receipt.decisionId===intent.decisionId&&receipt.idempotencyKey===intent.command.idempotencyKey,'EXECUTION_UNKNOWN','Reconciliation response mismatch');
      this.store.recordReceipt(receipt);receipts.push(receipt);
    }return receipts;
  }
  async start(options:{streamIds:string[];maxSteps?:number;intervalMs?:number;signal?:AbortSignal}):Promise<void> {
    invariant(!this.failure,'DECISION_STOPPED','Runtime failure cannot be cleared by restarting the loop',this.failure);
    invariant(options.streamIds.length>0,'CONFIG_INVALID','At least one stream required');this.stopping=false;
    for(let n=0;n<(options.maxSteps??Infinity)&&!this.stopping&&!options.signal?.aborted;n++) {
      for(const stream of options.streamIds){if(this.stopping||options.signal?.aborted)break;await this.step(stream);}
      if(options.intervalMs)await new Promise(r=>setTimeout(r,Math.min(options.intervalMs!,1000)));
    }
  }
  async stop(options:{drain?:boolean;timeoutMs?:number}={}):Promise<void> {
    this.stopping=true;if(options.drain!==false&&this.pending.size)await withDeadline(Date.now()+(options.timeoutMs??this.maxDecisionMs),()=>Promise.allSettled([...this.pending]));
  }
  subscribe(listener:(event:JournalEvent)=>void):()=>void{this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  status(){return {applicationId:this.applicationId,domainId:this.domain.id,mode:this.mode,executionOwner:this.executionOwner,stopping:this.stopping,...(this.failure?{failure:{...this.failure}}:{}),pendingSteps:this.pending.size,unresolvedExecutions:this.store.intents().filter(i=>i.command.observation.applicationId===this.applicationId&&i.command.observation.domainId===this.domain.id&&(!i.receipt||['accepted','unknown'].includes(i.receipt.status))).length};}
  async close():Promise<void>{if(this.closed)return;await this.stop();for(const [key,token] of this.owners){const [scope,stream]=key.split('\0');this.store.releaseOwner(scope!,stream!,token);}this.closed=true;this.listeners.clear();}
  private emit(type:string,scopeId:string,data:unknown){const event=this.store.appendEvent(type,scopeId,data);for(const listener of this.listeners){try{listener(event);}catch{/* Observer failures never trigger action retries. */}}}
  private ensureOpen(){invariant(!this.closed,'CONFIG_INVALID','Runtime closed');}
  private validateObservation(o:Observation){
    for(const k of ['applicationId','domainId','strategyScopeId','streamId','actorId','trajectoryId','revision'] as const)invariant(typeof o[k]==='string'&&o[k].length>0,'CONFIG_INVALID',`Missing observation.${k}`);
    invariant(o.applicationId===this.applicationId&&o.domainId===this.domain.id,'ACCESS_DENIED','Observation application/domain mismatch');
    invariant(Number.isFinite(o.observedAt)&&Number.isFinite(o.deadline)&&o.features&&typeof o.features==='object','CONFIG_INVALID','Invalid observation');canonicalize(o.features);
  }
  private validateCandidates(a:CandidateAction[],o:Observation){invariant(Array.isArray(a)&&new Set(a.map(v=>v.id)).size===a.length,'CONFIG_INVALID','Candidate IDs must be unique');for(const v of a){invariant(v.id.length>0&&typeof v.kind==='string'&&v.revision===o.revision&&!!v.parameters,'STATE_STALE','Invalid/stale candidate');canonicalize(v.parameters);}}
}
