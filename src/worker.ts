import { invariant } from './errors.js';
import type { DuelLoopStore, EvaluationProtocol, FeedbackEvent } from './types.js';
import { ResearchOrchestrator, type ResearchResult } from './research.js';

export interface ResearchWorkerOptions {
  orchestrator:ResearchOrchestrator; store:DuelLoopStore; scopeId:string;
  protocol:EvaluationProtocol; developmentProtocol:EvaluationProtocol;
  settledTrajectories:number; cooldownMs:number;
  onRelease?:(releaseDigest:string)=>Promise<void>;
}
/** Persistent triggers are derived from feedback revisions and completed claims, not a process-local counter. */
export class ResearchWorker {
  private stopping=false;private running=false;private activeRun?:string;
  constructor(private readonly options:ResearchWorkerOptions){
    invariant(Number.isSafeInteger(options.settledTrajectories)&&options.settledTrajectories>0&&Number.isFinite(options.cooldownMs)&&options.cooldownMs>=0,'CONFIG_INVALID','Invalid research trigger');
  }
  async tick():Promise<ResearchResult|null>{
    if(this.stopping||this.running)return null;
    this.running=true;
    try{
      const {store,scopeId,orchestrator}=this.options;
      const terminal=new Set(['cancelled','no_change','budget_exhausted','completed_passed','completed_failed','completed_inconclusive','error']);
      if(store.listRuns(scopeId).some(r=>!terminal.has(r.status)))return null;
      const previous=store.events({scopeId}).filter(e=>e.type==='research.triggered').at(-1);
      if(previous&&Date.now()-previous.timestamp<this.options.cooldownMs)return null;
      // Evidence identity, rather than a timestamp watermark, survives equal timestamps,
      // late arrivals and feedback revisions. Reuse the last run's immutable snapshot.
      const priorRunId=(previous?.data as {runId?:string}|undefined)?.runId;
      const prior=priorRunId?store.getArtifact<{feedback:FeedbackEvent[]}>(store.getRun(priorRunId).researchSnapshotId).feedback:[];
      const seen=new Set(prior.map(f=>JSON.stringify([f.feedbackId,f.revision])));
      const newSettled=(feedback:FeedbackEvent[])=>new Set(feedback.filter(f=>f.settled&&!seen.has(JSON.stringify([f.feedbackId,f.revision]))).map(f=>f.trajectoryId));
      const cutoffTime=Date.now();const latest=new Map<string,FeedbackEvent>();
      for(const event of store.events({scopeId}))if(event.type==='feedback.received'){
        const f=event.data as unknown as FeedbackEvent;
        if(f.receivedAt<=cutoffTime&&f.revision>(latest.get(f.feedbackId)?.revision??0))latest.set(f.feedbackId,f);
      }
      // Do not persist a new historical snapshot on every idle poll.
      if(newSettled([...latest.values()]).size<this.options.settledTrajectories)return null;
      const snapshotId=store.snapshot(scopeId,cutoffTime);
      const snapshot=store.getArtifact<{feedback:FeedbackEvent[]}>(snapshotId);
      const settled=newSettled(snapshot.feedback);
      if(settled.size<this.options.settledTrajectories)return null;
      const cutoff=Math.max(...snapshot.feedback.map(f=>f.receivedAt));
      const run=orchestrator.create({scopeId,protocol:this.options.protocol,developmentProtocol:this.options.developmentProtocol,snapshotId});
      store.appendEvent('research.triggered',scopeId,{runId:run.id,cutoff,settledTrajectories:settled.size});
      this.activeRun=run.id;const result=await orchestrator.run(run.id);
      if(result.releaseDigest&&!this.stopping&&this.options.onRelease)await this.options.onRelease(result.releaseDigest);
      return result;
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
  stop():void{this.stopping=true;if(this.activeRun)this.options.orchestrator.cancel(this.activeRun);}
}
