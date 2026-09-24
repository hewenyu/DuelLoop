import { DuelLoopError, invariant } from './errors.js';
import { validateProtocol } from './evaluation.js';
import { digest } from './utils.js';
import type { DuelLoopStore, EvaluationProtocol } from './types.js';
import { ResearchOrchestrator, type ResearchResult } from './research.js';

type WorkerState='idle'|'running'|'waiting_protocol'|'stopped'|'error';
export interface ResearchWorkerOptions {
  orchestrator:ResearchOrchestrator; store:DuelLoopStore; scopeId:string;
  protocol:EvaluationProtocol; developmentProtocol:EvaluationProtocol;
  settledTrajectories:number; cooldownMs:number;
  /** Rolling evidence window; older feedback outside this window is coalesced. */
  snapshotOptions?:{maxDecisions?:number;maxFeedback?:number};
  /** Notification only. The runtime independently schedules registered pending releases. */
  onRelease?:(releaseDigest:string)=>Promise<void>;
}
/** Trigger progress uses the persistent journal cursor, not wall-clock ordering or full-history scans. */
export class ResearchWorker {
  private stopping=false;private running=false;private activeRun?:string;
  private protocols:{protocol:EvaluationProtocol;developmentProtocol:EvaluationProtocol};
  private state:WorkerState='idle';
  constructor(private readonly options:ResearchWorkerOptions){
    invariant(Number.isSafeInteger(options.settledTrajectories)&&options.settledTrajectories>0&&Number.isFinite(options.cooldownMs)&&options.cooldownMs>=0,'CONFIG_INVALID','Invalid research trigger');
    for(const limit of [options.snapshotOptions?.maxDecisions,options.snapshotOptions?.maxFeedback])invariant(limit===undefined||(Number.isSafeInteger(limit)&&limit>0&&limit<=10000),'CONFIG_INVALID','Snapshot limits must be positive integers up to 10000');
    this.protocols=this.validateProtocols(options);
  }
  private validateProtocols(input:{protocol:EvaluationProtocol;developmentProtocol:EvaluationProtocol}) {
    const protocol=validateProtocol(input.protocol),developmentProtocol=validateProtocol(input.developmentProtocol);
    invariant(protocol.domainId===developmentProtocol.domainId&&protocol.holdoutId!==developmentProtocol.holdoutId&&!developmentProtocol.seeds.some(seed=>protocol.seeds.includes(seed)),'CONFIG_INVALID','Development and holdout environments must be separate');
    return {protocol,developmentProtocol};
  }
  /** Affects future runs only; immutable bindings of an existing run never change. */
  updateProtocols(input:{protocol:EvaluationProtocol;developmentProtocol:EvaluationProtocol}):void {
    const next=this.validateProtocols(input);
    this.options.orchestrator.protocolAvailability(next.protocol);
    this.protocols=next;
    if(!this.running&&!this.stopping)this.state='idle';
    this.options.store.appendEvent('research.protocol_updated',this.options.scopeId,{protocolDigest:digest(next.protocol)},'private');
  }
  status():{state:WorkerState;activeRun?:string;protocolDigest:string} {
    return {state:this.state,...(this.activeRun?{activeRun:this.activeRun}:{}),protocolDigest:digest(this.protocols.protocol)};
  }
  private waiting(protocol:EvaluationProtocol):void {
    this.state=this.stopping?'stopped':'waiting_protocol';
    const {store,scopeId}=this.options,protocolDigest=digest(protocol);
    const previous=store.latestEvent(scopeId,'research.worker_state',{allowPrivate:true});
    const data=previous?.data as {state?:string;protocolDigest?:string}|undefined;
    if(data?.state!=='waiting_protocol'||data.protocolDigest!==protocolDigest)
      store.appendEvent('research.worker_state',scopeId,{state:'waiting_protocol',reason:'holdout_unavailable',protocolDigest},'private');
  }
  async tick():Promise<ResearchResult|null>{
    if(this.stopping||this.running)return null;
    this.running=true;
    const protocols=this.protocols;
    try{
      const {store,scopeId,orchestrator}=this.options;
      if(store.activeRun(scopeId))return null;
      if(orchestrator.protocolAvailability(protocols.protocol).remaining===0){this.waiting(protocols.protocol);return null;}
      if(this.state==='waiting_protocol')store.appendEvent('research.worker_state',scopeId,{state:'idle',protocolDigest:digest(protocols.protocol)},'private');
      this.state='idle';
      const previous=store.latestEvent(scopeId,'research.triggered');
      if(previous&&Date.now()-previous.timestamp<this.options.cooldownMs)return null;
      // Old trigger events did not carry a cursor. Their journal position still excludes
      // already committed feedback without loading their historical snapshots.
      const previousData=previous?.data as {feedbackEventId?:number}|undefined;
      const afterEventId=typeof previousData?.feedbackEventId==='number'?previousData.feedbackEventId:previous?.id??0;
      const progress=store.feedbackProgress(scopeId,afterEventId);
      if(progress.settledTrajectories<this.options.settledTrajectories)return null;
      // receivedAt belongs to the host. The journal cursor decides freshness even when
      // timestamps repeat or arrive out of order; include every already committed input.
      const cutoff=Math.max(Date.now(),progress.receivedAt);
      const feedbackEventId=progress.eventId;
      const run=orchestrator.create({scopeId,...protocols,snapshotOptions:this.options.snapshotOptions,trigger:{feedbackEventId,cutoff,settledTrajectories:progress.settledTrajectories}});
      this.activeRun=run.id;this.state='running';
      const result=await orchestrator.run(run.id);
      if(result.run.status==='waiting_protocol'){this.waiting(protocols.protocol);return result;}
      this.state=this.stopping?'stopped':'idle';
      if(result.releaseDigest&&!this.stopping&&this.options.onRelease) {
        try {await this.options.onRelease(result.releaseDigest);}
        catch(error) {
          const code=error instanceof DuelLoopError?error.code:'RELEASE_NOTIFICATION_ERROR';
          const state=code==='ACTIVATION_DEFERRED'?'deferred':['CONFLICT','VALIDATION_REJECTED','VERSION_INCOMPATIBLE'].includes(code)?'invalid':'error';
          store.appendEvent('research.release_notification',scopeId,{releaseDigest:result.releaseDigest,state,reason:code});
          if(state==='invalid')store.appendEvent('release.invalid',scopeId,{releaseDigest:result.releaseDigest,reason:code});
          if(state==='error')throw error;
        }
      }
      return result;
    }catch(error){
      if(error instanceof DuelLoopError&&error.code==='HOLDOUT_UNAVAILABLE'){this.waiting(protocols.protocol);return null;}
      if(error instanceof DuelLoopError&&error.code==='CONFLICT'&&this.options.store.activeRun(this.options.scopeId))return null;
      this.state='error';throw error;
    }finally{this.running=false;this.activeRun=undefined;}
  }
  async run(options:{signal?:AbortSignal;pollIntervalMs?:number}={}):Promise<void>{
    const delay=options.pollIntervalMs??5000;
    invariant(Number.isFinite(delay)&&delay>=10&&delay<=60000,'CONFIG_INVALID','Poll interval must be 10–60000 ms');
    this.stopping=false;const stop=()=>this.stop();options.signal?.addEventListener('abort',stop,{once:true});
    try{
      while(!this.stopping&&!options.signal?.aborted){await this.tick();if(!this.stopping)await new Promise<void>(resolve=>{
        const done=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,delay);options.signal?.addEventListener('abort',done,{once:true});
      });}
    }finally{options.signal?.removeEventListener('abort',stop);}
  }
  stop():void{this.stopping=true;this.state='stopped';if(this.activeRun)this.options.orchestrator.cancel(this.activeRun);}
}
