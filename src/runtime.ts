import { randomUUID } from 'node:crypto';
import { DuelLoopError, invariant } from './errors.js';
import { buildQuestions, compileStrategy, evaluateAnswers, validateScoreAnswer } from './strategy.js';
import { canonicalize, digest, seededRandom, withDeadline } from './utils.js';
import { normalizeModelUsage } from './usage.js';
import type { ActionCommand, BehaviorDependencies, CandidateAction, DecisionModel, DecisionOptions, DecisionRecord, DomainDefinition, DuelLoopStore, ExecutionMode, ExecutionReceipt, FeedbackEvent, JournalEvent, ModelMaintenanceOptions, ModelUsage, Observation, StrategyPackage, TrajectoryIdentity } from './types.js';

export interface DuelLoopOptions {
  applicationId: string; domain: DomainDefinition; model: DecisionModel; store: DuelLoopStore;
  mode?: ExecutionMode; executionOwner?: 'framework'|'host';
  maxDecisionMs?: number; executionReserveMs?: number; randomSeed?: string;
}
export const RUNTIME_VERSION = 'duelloop-runtime-5';
function measuredUsage(value:unknown):ModelUsage {
  return normalizeModelUsage(value&&typeof value==='object'?value as ModelUsage:undefined);
}
export function decisionPolicyRuntimeVersion(timing:{maxDecisionMs?:number;executionReserveMs?:number;randomSeed?:string}={}):string {
  const policy={maxDecisionMs:timing.maxDecisionMs??5000,executionReserveMs:timing.executionReserveMs??25,randomSeed:timing.randomSeed??null};
  return `${RUNTIME_VERSION}:${digest(policy)}`;
}
export function modelBehaviorDigest(model:DecisionModel):string {
  const identity=model.behaviorIdentity;
  invariant(identity&&['adapterVersion','deploymentVersion','protocolVersion','configurationDigest'].every(key=>typeof identity[key as keyof typeof identity]==='string'&&identity[key as keyof typeof identity].length>0),'CONFIG_INVALID','Decision models require an explicit, non-secret behaviorIdentity');
  return digest({id:model.id,kind:model.kind,...identity});
}
export function behaviorDependencies(domain:DomainDefinition,model:DecisionModel,timing:{maxDecisionMs?:number;executionReserveMs?:number;randomSeed?:string}={}):BehaviorDependencies {
  return {model:model.id,modelKind:model.kind,modelBehaviorDigest:modelBehaviorDigest(model),runtime:decisionPolicyRuntimeVersion(timing),rules:domain.rulesVersion,featureBuilder:domain.featureBuilderVersion,
    knowledgeUpdater:domain.knowledgeUpdaterVersion,
    continuationPolicy:domain.continuationVersion,contextDigest:digest(domain.context)};
}
export class DuelLoop {
  readonly domain:DomainDefinition; readonly model:DecisionModel; readonly store:DuelLoopStore;
  readonly applicationId:string; readonly mode:ExecutionMode; readonly executionOwner:'framework'|'host';
  private readonly ownerId=randomUUID(); private readonly owners=new Map<string,string>();
  private readonly listeners=new Set<(event:JournalEvent)=>void>(); private readonly busy=new Set<string>();
  private stopping=false; private closed=false; private readonly pending=new Set<Promise<unknown>>();
  private lifecycle=new AbortController(); private closing=false;
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
    modelBehaviorDigest(this.model);
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
  /** Operator-only model maintenance. The host must close other writers and finish all old trajectories first. */
  async rebindBootstrapModel(scopeId:string,options:ModelMaintenanceOptions):Promise<string> {
    this.ensureOpen();
    invariant(this.stopping&&!this.closing&&this.pending.size===0&&this.busy.size===0,'CONFLICT','Maintenance requires a stopped, fully drained runtime');
    invariant(this.store.rebindBootstrapModel,'CAPABILITY_UNSUPPORTED','Store does not support explicit model maintenance');
    return this.track(async()=>{
      this.ensureOpen();
      this.store.bindScope(scopeId,this.applicationId);
      const previous=this.store.release(options.expectedReleaseDigest);
      compileStrategy(this.store.getArtifact<StrategyPackage>(previous.strategyDigest),this.domain);
      if(this.domain.capabilities.activationBoundary==='scope') {
        invariant(this.domain.canActivate,'CAPABILITY_UNSUPPORTED','Scope-wide boundary check required');
        invariant(await this.domain.canActivate(scopeId),'ACTIVATION_DEFERRED','Maintenance requires an activation checkpoint',{reason:'scope_boundary'});
      }
      this.ensureOpen();
      invariant(this.stopping&&!this.closing&&this.pending.size===1&&this.busy.size===0,'CONFLICT','Runtime changed while checking maintenance boundary');
      return this.store.rebindBootstrapModel!(scopeId,this.dependencies,options);
    });
  }
  activate(releaseDigest:string,explicit=false):Promise<void> {return this.track(()=>this.activateInternal(releaseDigest,explicit));}
  private async activateInternal(releaseDigest:string,explicit=false):Promise<void> {
    const binding=this.store.release(releaseDigest);
    this.ensureOpen();this.store.bindScope(binding.scopeId,this.applicationId);
    this.assertUsableRelease(releaseDigest);
    try {
      if(this.domain.capabilities.activationBoundary==='scope') {
        invariant(this.domain.canActivate,'CAPABILITY_UNSUPPORTED','Scope-wide boundary check required');
        invariant(await this.domain.canActivate(binding.scopeId),'ACTIVATION_DEFERRED','Scope activation boundary unavailable',{reason:'scope_boundary'});
      }
      this.store.activate(releaseDigest,this.dependencies,{explicit});
    } catch(error) {
      if(error instanceof DuelLoopError&&error.code==='ACTIVATION_DEFERRED')this.emit('release.deferred',binding.scopeId,{releaseDigest,reason:error.context.reason??error.code});
      throw error;
    }
    this.emit('runtime.activated',binding.scopeId,{releaseDigest});
  }
  rollback(scopeId:string,target:string):Promise<void> {return this.track(()=>this.rollbackInternal(scopeId,target));}
  private async rollbackInternal(scopeId:string,target:string):Promise<void> {
    this.ensureOpen();this.store.bindScope(scopeId,this.applicationId);
    const binding=this.store.release(target);invariant(binding.scopeId===scopeId,'CONFLICT','Wrong rollback scope');
    this.assertUsableRelease(target);
    if(this.domain.capabilities.activationBoundary==='scope'){
      invariant(this.domain.canActivate,'CAPABILITY_UNSUPPORTED','Scope-wide boundary check required');
      invariant(await this.domain.canActivate(scopeId),'ACTIVATION_DEFERRED','Rollback requires an activation checkpoint',{reason:'scope_boundary'});
    }
    this.store.rollback(scopeId,target,this.dependencies);
    this.emit('runtime.rolled_back',scopeId,{releaseDigest:target});
  }
  lookupTrajectoryRelease(identity:TrajectoryIdentity):string|undefined {
    this.ensureOpen();this.validateTrajectory(identity);
    return this.store.lookupTrajectoryRelease(identity.strategyScopeId,identity.streamId,identity.actorId,identity.trajectoryId);
  }
  private validateTrajectory(identity:TrajectoryIdentity):void {
    for(const key of ['strategyScopeId','streamId','actorId','trajectoryId'] as const)
      invariant(typeof identity[key]==='string'&&identity[key].length>0,'CONFIG_INVALID',`Missing trajectory.${key}`);
  }
  pinTrajectory(identity:TrajectoryIdentity):string {
    this.ensureOpen();invariant(!this.stopping,'CANCELLED','Runtime stopped accepting trajectory pins');
    this.validateTrajectory(identity);
    this.store.bindScope(identity.strategyScopeId,this.applicationId);
    const release=this.store.trajectoryRelease(identity.strategyScopeId,identity.streamId,identity.actorId,identity.trajectoryId);
    this.assertUsableRelease(release);return release;
  }
  decide(observation:Observation,candidates?:CandidateAction[],options:DecisionOptions={}):Promise<DecisionRecord> {return this.track(()=>this.decideInternal(observation,candidates,options));}
  private async decideInternal(observation:Observation,candidates?:CandidateAction[],options:DecisionOptions={}):Promise<DecisionRecord> {
    invariant(!this.failure,'DECISION_STOPPED','Runtime failed; inspect the stopped decision before creating a new instance',this.failure);
    this.ensureOpen();invariant(!this.stopping,'CANCELLED','Runtime stopped accepting decisions');
    const startedAt=Date.now();
    invariant(options.modelDeadline===undefined||Number.isFinite(options.modelDeadline),'CONFIG_INVALID','Invalid model deadline');
    const modelDeadline=Math.min(observation.deadline-this.reserve,startedAt+this.maxDecisionMs-this.reserve,options.modelDeadline??Infinity);
    const signal=options.signal?AbortSignal.any([this.lifecycle.signal,options.signal]):this.lifecycle.signal;
    invariant(!signal.aborted,'CANCELLED','Decision cancelled before preparation');
    this.validateObservation(observation);
    this.store.bindScope(observation.strategyScopeId,this.applicationId);
    invariant(observation.deadline>Date.now(),'STATE_STALE','Observation deadline expired');
    const actions=candidates??await this.decisionDeadline(modelDeadline,()=>this.domain.candidates(observation),signal);this.validateCandidates(actions,observation);
    const releaseDigest=this.store.trajectoryRelease(observation.strategyScopeId,observation.streamId,observation.actorId,observation.trajectoryId);
    const binding=this.store.release(releaseDigest);
    this.assertUsableRelease(releaseDigest);
    const strategy=compileStrategy(this.store.getArtifact<StrategyPackage>(binding.strategyDigest),this.domain).strategy;
    const record:DecisionRecord={decisionId:randomUUID(),observation:structuredClone(observation),modelDeadline,candidates:structuredClone(actions),releaseDigest,strategyDigest:binding.strategyDigest,
      decisionSource:'stopped',action:null,questions:[],answers:{},utilities:{},probabilities:{},startedAt,finishedAt:startedAt};
    try {
        invariant(actions.length>0,'DECISION_STOPPED','No legal candidate; no action was selected',{reason:'NO_LEGAL_ACTION'});
        const request=buildQuestions(strategy,observation,actions,this.domain);record.questions=request.questions;
        record.modelKind=this.model.kind;record.model=this.model.id;
        const modelStartedAt=Date.now();
        const response=await this.decisionDeadline(modelDeadline,signal=>{
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
        },signal).finally(()=>{record.modelLatencyMs=Date.now()-modelStartedAt;});
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
        invariant(!this.stopping&&!signal.aborted,'CANCELLED','Decision cancelled while the model was answering');
        invariant(Date.now()<modelDeadline,'MODEL_TIMEOUT','Decision expired before model answers could be used');
        this.assertUsableRelease(releaseDigest);
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
      const naturallyCancelled=failure.code==='CANCELLED'&&options.signal?.aborted&&!this.lifecycle.signal.aborted;
      if(!naturallyCancelled){this.stopping=true;this.failure??={decisionId:record.decisionId,code:record.stopReason};}
      this.store.putArtifact('decision',record);this.emit('decision',observation.strategyScopeId,record);
      this.emit(naturallyCancelled?'decision.cancelled':'runtime.stopped',observation.strategyScopeId,{decisionId:record.decisionId,reason:record.stopReason});
      throw new DuelLoopError(failure.code,failure.message,{...failure.context,decisionId:record.decisionId,stopReason:record.stopReason});
    }
    record.finishedAt=Date.now();this.store.putArtifact('decision',record);this.emit('decision',observation.strategyScopeId,record);return record;
  }
  async step(streamId:string):Promise<{decision:DecisionRecord;receipt:ExecutionReceipt|null}> {
    this.ensureOpen();invariant(!this.stopping,'CANCELLED','Runtime stopping');invariant(!this.busy.has(streamId),'CONFLICT','Concurrent decision on same stream');
    this.busy.add(streamId);
    const task=(async()=>{
      const started=Date.now();const deadline=started+this.maxDecisionMs;
      let effectiveDeadline=deadline;let scopeId:string|undefined;let decision:DecisionRecord|undefined;
      let decisionEndToEndLatencyMs:number|undefined;let executionAckLatencyMs:number|undefined;
      try {
        const observation=await this.deadline(deadline,()=>this.domain.observe(streamId));scopeId=observation.strategyScopeId;
        effectiveDeadline=observation.deadline;
        const unresolved=this.store.unresolvedIntents(observation.strategyScopeId,streamId);
        invariant(this.executionOwner==='host'||this.mode==='shadow'||unresolved.length===0,'EXECUTION_UNKNOWN','Unresolved prior execution requires reconciliation');
        decision=await this.decide(observation,undefined,{modelDeadline:deadline-this.reserve});decisionEndToEndLatencyMs=Date.now()-started;
        let receipt:ExecutionReceipt|null=null;
        if(this.mode!=='shadow'&&this.executionOwner==='framework'&&decision.action) {
          const executionStarted=Date.now();receipt=await this.executeDecision(decision);executionAckLatencyMs=Date.now()-executionStarted;
        }
        await this.submitFeedback();await this.activatePending(observation.strategyScopeId);
        this.emit('runtime.step_completed',scopeId,{streamId,decisionId:decision.decisionId,modelLatencyMs:decision.modelLatencyMs??0,
          decisionEndToEndLatencyMs,...(executionAckLatencyMs===undefined?{}:{executionAckLatencyMs}),stepLatencyMs:Date.now()-started,deadlineMiss:Date.now()>effectiveDeadline});
        return {decision,receipt};
      } catch(error) {
        // Failure telemetry must never replace the original error, including a storage failure.
        try {this.emit('runtime.step_failed',scopeId??'',{streamId,...(decision?{decisionId:decision.decisionId,modelLatencyMs:decision.modelLatencyMs??0}:{}),
          ...(decisionEndToEndLatencyMs===undefined?{}:{decisionEndToEndLatencyMs}),...(executionAckLatencyMs===undefined?{}:{executionAckLatencyMs}),
          stepLatencyMs:Date.now()-started,deadlineMiss:Date.now()>effectiveDeadline,reason:error instanceof DuelLoopError?error.code:'RUNTIME_FAILURE'});}catch{}
        throw error;
      }
    })();
    this.pending.add(task);try{return await task;}finally{this.busy.delete(streamId);this.pending.delete(task);}
  }
  executeDecision(decision:DecisionRecord):Promise<ExecutionReceipt> {return this.track(()=>this.executeDecisionInternal(decision));}
  private async executeDecisionInternal(decision:DecisionRecord):Promise<ExecutionReceipt> {
    this.ensureOpen();invariant(this.mode!=='shadow'&&this.executionOwner==='framework','ACCESS_DENIED','This runtime does not own execution');
    this.validateObservation(decision.observation);this.store.bindScope(decision.observation.strategyScopeId,this.applicationId);
    const existing=this.store.intent(decision.decisionId);
    if(existing?.receipt)return existing.receipt;
    const command=await this.prepareExecution(decision);
    let receipt:ExecutionReceipt;let sent=false;
    try {receipt=await this.deadline(command.deadline,()=>{
      invariant(!this.stopping,'CANCELLED','Runtime stopped before sending the action');
      this.assertUsableRelease(decision.releaseDigest);
      sent=true;return this.domain.execute!(command);
    });}
    catch(error){
      receipt={decisionId:decision.decisionId,idempotencyKey:decision.decisionId,status:sent?'unknown':'rejected',timestamp:Date.now(),
        ...(!sent?{details:{reason:error instanceof DuelLoopError&&error.code==='CANCELLED'?'STOPPED_BEFORE_SEND':'PRE_SEND_REJECTED',code:error instanceof DuelLoopError?error.code:'RUNTIME_FAILURE'}}:{})};
      if(!sent){this.store.recordReceipt(receipt);throw error;}
    }
    invariant(receipt.decisionId===decision.decisionId&&receipt.idempotencyKey===decision.decisionId,'EXECUTION_UNKNOWN','Receipt does not match intent');
    this.store.recordReceipt(receipt);return receipt;
  }
  prepareHostExecution(decision:DecisionRecord):Promise<ActionCommand> {return this.track(()=>this.prepareHostExecutionInternal(decision));}
  private async prepareHostExecutionInternal(decision:DecisionRecord):Promise<ActionCommand>{
    this.ensureOpen();invariant(this.executionOwner==='host'&&this.mode!=='shadow','ACCESS_DENIED','Host execution is disabled');
    return this.prepareExecution(decision);
  }
  resumeHostExecution(decision:DecisionRecord,options:{signal?:AbortSignal}={}):Promise<ActionCommand> {
    return this.track(()=>this.resumeHostExecutionInternal(decision,options));
  }
  private async resumeHostExecutionInternal(decision:DecisionRecord,options:{signal?:AbortSignal}):Promise<ActionCommand> {
    this.ensureOpen();invariant(this.executionOwner==='host'&&this.mode!=='shadow','ACCESS_DENIED','Host recovery is disabled');
    invariant(!this.stopping,'CANCELLED','Runtime stopped accepting execution recovery');
    invariant(decision.decisionSource==='strategy'&&!decision.stopReason&&decision.action&&decision.model&&decision.questions.length>0,'ACCESS_DENIED','Only a successful model decision may resume');
    const obs=decision.observation;this.validateObservation(obs);this.store.bindScope(obs.strategyScopeId,this.applicationId);
    const saved=this.store.getArtifact<DecisionRecord>(digest(decision));invariant(saved.decisionId===decision.decisionId,'CONFIG_INVALID','Decision not issued by this store');
    const existing=this.store.intent(decision.decisionId);
    invariant(existing,'NOT_FOUND','Host recovery requires an existing intent');
    invariant(!existing.receipt||!['completed','rejected'].includes(existing.receipt.status),'EXECUTION_UNKNOWN','Terminal execution cannot be resumed');
    const command=existing.command;
    invariant(command.decisionId===decision.decisionId&&command.idempotencyKey===decision.decisionId&&command.expectedStateRevision===obs.revision&&
      command.deadline===obs.deadline&&canonicalize(command.observation)===canonicalize(obs)&&canonicalize(command.action)===canonicalize(decision.action)&&
      existing.scopeId===obs.strategyScopeId&&existing.streamId===obs.streamId,'CONFLICT','Stored intent differs from immutable decision');
    this.assertUsableRelease(decision.releaseDigest);
    const signal=options.signal?AbortSignal.any([this.lifecycle.signal,options.signal]):this.lifecycle.signal;
    invariant(!signal.aborted,'CANCELLED','Execution recovery cancelled');
    invariant(Date.now()<command.deadline,'STATE_STALE','Original execution authority expired');
    const fresh=await this.decisionDeadline(command.deadline,()=>this.domain.observe(obs.streamId),signal);
    this.validateObservation(fresh);
    invariant(fresh.strategyScopeId===obs.strategyScopeId&&fresh.streamId===obs.streamId&&fresh.revision===obs.revision&&fresh.trajectoryId===obs.trajectoryId&&fresh.actorId===obs.actorId,'STATE_STALE','Environment changed before execution recovery');
    invariant(Date.now()<fresh.deadline,'STATE_STALE','Current execution authority expired');
    const legal=await this.decisionDeadline(command.deadline,()=>this.domain.candidates(fresh),signal);this.validateCandidates(legal,fresh);
    invariant(legal.some(action=>canonicalize(action)===canonicalize(decision.action)),'STATE_STALE','Recovered action is no longer legal');
    invariant(!this.stopping&&!signal.aborted,'CANCELLED','Execution recovery cancelled');
    invariant(Date.now()<command.deadline,'STATE_STALE','Original execution authority expired');
    this.assertUsableRelease(decision.releaseDigest);
    const token=this.store.reclaimIntentOwner(decision.decisionId,this.ownerId);
    this.owners.set(`${obs.strategyScopeId}\0${obs.streamId}`,token);
    this.store.assertOwner(obs.strategyScopeId,obs.streamId,token);
    invariant(!this.stopping&&!signal.aborted,'CANCELLED','Execution recovery cancelled');
    invariant(Date.now()<Math.min(command.deadline,fresh.deadline),'STATE_STALE','Execution authority expired while ownership was reclaimed');
    return {...command,ownerToken:token};
  }
  private async prepareExecution(decision:DecisionRecord):Promise<ActionCommand>{
    invariant(!this.stopping,'CANCELLED','Runtime stopped accepting execution');
    invariant(decision.decisionSource==='strategy'&&!decision.stopReason&&decision.model&&decision.questions.length>0,'ACCESS_DENIED','Only a successful model decision may execute');
    invariant(decision.action,'CONFIG_INVALID','No action to execute');
    const obs=decision.observation;this.validateObservation(obs);this.store.bindScope(obs.strategyScopeId,this.applicationId);
    this.assertUsableRelease(decision.releaseDigest);
    const saved=this.store.getArtifact<DecisionRecord>(digest(decision));invariant(saved.decisionId===decision.decisionId,'CONFIG_INVALID','Decision not issued by this store');
    const existing=this.store.intent(decision.decisionId);
    invariant(!existing,'EXECUTION_UNKNOWN','Prior intent must be reconciled before another submission');
    invariant(Date.now()<obs.deadline,'STATE_STALE','Decision expired before execution');
    const fresh=await this.deadline(obs.deadline,()=>this.domain.observe(obs.streamId));
    invariant(fresh.revision===obs.revision&&fresh.trajectoryId===obs.trajectoryId&&fresh.actorId===obs.actorId,'STATE_STALE','Environment changed before execution');
    const legal=await this.deadline(obs.deadline,()=>this.domain.candidates(fresh));
    invariant(legal.some(a=>canonicalize(a)===canonicalize(decision.action)),'STATE_STALE','Action no longer legal');
    invariant(!this.stopping&&Date.now()<obs.deadline,'STATE_STALE','Execution stopped or decision expired');
    const key=`${obs.strategyScopeId}\0${obs.streamId}`;
    let token=this.owners.get(key);if(!token){token=this.store.acquireOwner(obs.strategyScopeId,obs.streamId,this.ownerId);this.owners.set(key,token);}
    this.store.assertOwner(obs.strategyScopeId,obs.streamId,token);
    const command={decisionId:decision.decisionId,idempotencyKey:decision.decisionId,expectedStateRevision:obs.revision,observation:obs,action:decision.action,deadline:obs.deadline,ownerToken:token};
    this.assertUsableRelease(decision.releaseDigest);
    this.store.saveIntent({decisionId:decision.decisionId,scopeId:obs.strategyScopeId,streamId:obs.streamId,ownerToken:token,command,receipt:null});
    this.store.assertOwner(obs.strategyScopeId,obs.streamId,token);
    return command;
  }
  recordHostReceipt(decision:DecisionRecord,receipt:ExecutionReceipt):void {
    this.ensureOpen();this.validateObservation(decision.observation);this.store.bindScope(decision.observation.strategyScopeId,this.applicationId);
    invariant(this.executionOwner==='host'&&this.mode!=='shadow','ACCESS_DENIED','Host receipt unavailable in this mode');
    invariant(decision.action&&receipt.decisionId===decision.decisionId&&receipt.idempotencyKey===decision.decisionId,'CONFIG_INVALID','Host receipt must refer to decision ID');
    this.store.getArtifact(digest(decision));
    if(this.store.recordReceipt(receipt))this.emit('host.execution.receipt',decision.observation.strategyScopeId,receipt);
  }
  activatePending(scopeId:string):Promise<string|null> {return this.track(()=>this.activatePendingInternal(scopeId));}
  private async activatePendingInternal(scopeId:string):Promise<string|null> {
    this.ensureOpen();this.store.bindScope(scopeId,this.applicationId);
    for(const {digest:releaseDigest} of this.store.pendingReleases(scopeId)) {
      try {await this.activate(releaseDigest);return releaseDigest;}
      catch(error){
        if(error instanceof DuelLoopError&&error.code==='ACTIVATION_DEFERRED')continue;
        if(error instanceof DuelLoopError&&['CONFLICT','VALIDATION_REJECTED','VERSION_INCOMPATIBLE'].includes(error.code)) {
          this.emit('release.invalid',scopeId,{releaseDigest,reason:error.code});continue;
        }
        throw error;
      }
    }return null;
  }
  submitFeedback(input?:FeedbackEvent|FeedbackEvent[]):Promise<void> {return this.track(()=>this.submitFeedbackInternal(input));}
  private async submitFeedbackInternal(input?:FeedbackEvent|FeedbackEvent[]):Promise<void> {
    const feedback=input?(Array.isArray(input)?input:[input]):await this.domain.feedback?.()??[];
    this.ensureOpen();
    for(const f of feedback){invariant(f.applicationId===this.applicationId,'ACCESS_DENIED','Feedback application mismatch');this.store.bindScope(f.strategyScopeId,this.applicationId);this.store.recordFeedback(f);}
  }
  reconcile(scopeId?:string):Promise<ExecutionReceipt[]> {return this.track(()=>this.reconcileInternal(scopeId));}
  private async reconcileInternal(scopeId?:string):Promise<ExecutionReceipt[]> {
    this.ensureOpen();if(scopeId)this.store.bindScope(scopeId,this.applicationId);
    invariant(this.domain.capabilities.statusQuery&&this.domain.executionStatus,'CAPABILITY_UNSUPPORTED','Domain cannot query unknown executions');
    const receipts:ExecutionReceipt[]=[];
    for(const intent of this.store.unresolvedIntents(scopeId)) {
      if(!scopeId&&(intent.command.observation.applicationId!==this.applicationId||intent.command.observation.domainId!==this.domain.id))continue;
      this.validateObservation(intent.command.observation);
      this.store.bindScope(intent.scopeId,this.applicationId);
      const receipt=await this.deadline(Date.now()+this.maxDecisionMs,()=>this.domain.executionStatus!(intent.command.idempotencyKey),false);
      invariant(receipt.decisionId===intent.decisionId&&receipt.idempotencyKey===intent.command.idempotencyKey,'EXECUTION_UNKNOWN','Reconciliation response mismatch');
      this.store.recordReceipt(receipt);receipts.push(receipt);
    }return receipts;
  }
  async start(options:{streamIds:string[];maxSteps?:number;intervalMs?:number;signal?:AbortSignal}):Promise<void> {
    invariant(!this.failure,'DECISION_STOPPED','Runtime failure cannot be cleared by restarting the loop',this.failure);
    this.ensureOpen();invariant(!this.closing&&this.pending.size===0,'CONFLICT','Cannot restart while operations are draining');
    invariant(options.streamIds.length>0,'CONFIG_INVALID','At least one stream required');this.lifecycle=new AbortController();this.stopping=false;
    const abort=()=>{this.stopping=true;this.lifecycle.abort();};
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    try {
      for(let n=0;n<(options.maxSteps??Infinity)&&!this.stopping;n++) {
        for(const stream of options.streamIds){if(this.stopping)break;await this.step(stream);}
        if(options.intervalMs&&!this.stopping)await new Promise(r=>setTimeout(r,Math.min(options.intervalMs!,1000)));
      }
    } finally {options.signal?.removeEventListener('abort',abort);}
  }
  async stop(options:{drain?:boolean;timeoutMs?:number}={}):Promise<void> {
    this.stopping=true;this.lifecycle.abort();
    if(options.drain!==false)await withDeadline(Date.now()+(options.timeoutMs??this.maxDecisionMs),async()=>{
      while(this.pending.size)await Promise.allSettled([...this.pending]);
    });
  }
  subscribe(listener:(event:JournalEvent)=>void):()=>void{this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  status(){return {applicationId:this.applicationId,domainId:this.domain.id,mode:this.mode,executionOwner:this.executionOwner,stopping:this.stopping,...(this.failure?{failure:{...this.failure}}:{}),pendingSteps:this.busy.size,pendingOperations:this.pending.size,unresolvedExecutions:this.store.unresolvedIntents().filter(i=>i.command.observation.applicationId===this.applicationId&&i.command.observation.domainId===this.domain.id).length};}
  async close():Promise<void>{if(this.closed)return;this.closing=true;await this.stop();for(const [key,token] of this.owners){const [scope,stream]=key.split('\0');this.store.releaseOwner(scope!,stream!,token);}this.closed=true;this.listeners.clear();}
  private assertUsableRelease(releaseDigest:string):void {
    this.store.assertUsableRelease(releaseDigest,{dependencies:this.dependencies,executionMode:this.mode});
  }
  private track<T>(operation:()=>Promise<T>):Promise<T> {
    const task=Promise.resolve().then(operation);this.pending.add(task);
    void task.then(()=>this.pending.delete(task),()=>this.pending.delete(task));return task;
  }
  private decisionDeadline<T>(deadline:number,operation:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T> {
    return withDeadline(deadline,current=>this.track(()=>operation(current)),signal);
  }
  private deadline<T>(deadline:number,operation:(signal:AbortSignal)=>Promise<T>,cancellable=true):Promise<T> {
    return withDeadline(deadline,signal=>this.track(()=>operation(signal)),cancellable?this.lifecycle.signal:undefined);
  }
  private emit(type:string,scopeId:string,data:unknown){
    const event=this.store.appendEvent(type,scopeId,data);
    for(const listener of this.listeners){
      try{
        const result=listener(event) as unknown;
        // TypeScript permits async functions where a void callback is expected.
        // Their rejection must not escape as an unhandled process-level failure.
        if(result&&typeof (result as PromiseLike<unknown>).then==='function')void Promise.resolve(result).catch(()=>{});
      }catch{/* Observer failures never trigger action retries. */}
    }
  }
  private ensureOpen(){invariant(!this.closed,'CONFIG_INVALID','Runtime closed');}
  private validateObservation(o:Observation){
    for(const k of ['applicationId','domainId','strategyScopeId','streamId','actorId','trajectoryId','revision'] as const)invariant(typeof o[k]==='string'&&o[k].length>0,'CONFIG_INVALID',`Missing observation.${k}`);
    invariant(o.applicationId===this.applicationId&&o.domainId===this.domain.id,'ACCESS_DENIED','Observation application/domain mismatch');
    invariant(Number.isFinite(o.observedAt)&&Number.isFinite(o.deadline)&&o.features&&typeof o.features==='object','CONFIG_INVALID','Invalid observation');canonicalize(o.features);
  }
  private validateCandidates(a:CandidateAction[],o:Observation){invariant(Array.isArray(a)&&new Set(a.map(v=>v.id)).size===a.length,'CONFIG_INVALID','Candidate IDs must be unique');for(const v of a){invariant(v.id.length>0&&typeof v.kind==='string'&&v.revision===o.revision&&!!v.parameters,'STATE_STALE','Invalid/stale candidate');canonicalize(v.parameters);}}
}
