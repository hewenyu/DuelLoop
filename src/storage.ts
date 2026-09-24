import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, copyFileSync, statSync, openSync, readSync, closeSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { invariant, DuelLoopError } from './errors.js';
import { canonicalize, digest, jsonValue } from './utils.js';
import type { Artifact, BehaviorDependencies, DecisionRecord, DuelLoopStore, EvaluationProtocol, ExecutionMode, ExecutionReceipt, FeedbackEvent, Intent, JournalEvent, Json, ReleaseBinding, ResearchRun, RunStatus, ScopeStatus, ValidationReport } from './types.js';

const TERMINAL = new Set<RunStatus>(['cancelled','no_change','budget_exhausted','completed_passed','completed_failed','completed_inconclusive','error','waiting_protocol']);
const ACTIVE_RUN_SQL="status IN ('created','researching','development_evaluating','candidate_locked','final_evaluating','cancel_requested')";
const TRANSITIONS: Record<string, string[]> = {
  created:['researching','cancel_requested','error','waiting_protocol'], researching:['development_evaluating','candidate_locked','no_change','budget_exhausted','cancel_requested','error','waiting_protocol'],
  development_evaluating:['researching','candidate_locked','budget_exhausted','cancel_requested','error','waiting_protocol'],
  candidate_locked:['final_evaluating','cancel_requested','budget_exhausted','error','waiting_protocol'],
  final_evaluating:['completed_passed','completed_failed','completed_inconclusive','cancel_requested','budget_exhausted','error','waiting_protocol'], cancel_requested:['cancelled'],
};
export interface SqliteStoreOptions {
  /** Logical SQLite database page limit for this connection; excludes WAL and temporary files. No default quota. */
  maxDatabaseBytes?: number;
  /** Maximum canonical JSON UTF-8 bytes per artifact. No default quota. */
  maxArtifactBytes?: number;
}
export class SqliteStore implements DuelLoopStore {
  private db: DatabaseSync;
  private depth = 0;
  private readonly transactionMetrics={writeTransactions:0,writeLockWaitMs:0,maxWriteLockWaitMs:0};
  private readonly maxArtifactBytes?:number;
  private readonly maxDatabaseBytes?:number;
  readonly path: string;
  constructor(path = ':memory:', options:SqliteStoreOptions = {}) {
    invariant(options&&typeof options==='object'&&!Array.isArray(options),'CONFIG_INVALID','Storage options must be an object');
    for(const key of Object.keys(options))invariant(['maxDatabaseBytes','maxArtifactBytes'].includes(key),'CONFIG_INVALID','Unknown storage option',{key});
    for(const [key,value] of Object.entries(options))invariant(value===undefined||Number.isSafeInteger(value)&&value>0,'CONFIG_INVALID','Storage byte limits must be positive safe integers',{key});
    this.maxArtifactBytes=options.maxArtifactBytes;this.maxDatabaseBytes=options.maxDatabaseBytes;
    this.path = path === ':memory:' ? path : resolve(path);
    if (this.path !== ':memory:') mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
    this.db = new DatabaseSync(this.path);
    try {
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    invariant(version <= 2, 'VERSION_INCOMPATIBLE', 'Database is newer than this runtime', {version});
    if(this.maxDatabaseBytes!==undefined){
      const pageSize=Number((this.db.prepare('PRAGMA page_size').get() as {page_size:number}).page_size);
      const pageCount=Number((this.db.prepare('PRAGMA page_count').get() as {page_count:number}).page_count);
      const maxPages=Math.floor(this.maxDatabaseBytes/pageSize);
      invariant(maxPages>=1&&maxPages>=pageCount,'STORAGE_FAILURE','Database byte limit cannot fit the current SQLite database',{maxDatabaseBytes:this.maxDatabaseBytes,currentDatabaseBytes:pageCount*pageSize,pageSize});
      this.db.exec(`PRAGMA max_page_count=${maxPages};`);
    }
    this.db.exec(`PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS artifacts (digest TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, scope_id TEXT NOT NULL, timestamp INTEGER NOT NULL, visibility TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, active TEXT, paused INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'automatic_after_validation');
      CREATE TABLE IF NOT EXISTS scope_owners (scope_id TEXT PRIMARY KEY, application_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases (digest TEXT PRIMARY KEY, scope_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invalid_validations (digest TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trajectories (scope_id TEXT NOT NULL, stream_id TEXT NOT NULL, actor_id TEXT NOT NULL, trajectory_id TEXT NOT NULL, release_digest TEXT NOT NULL, PRIMARY KEY(scope_id,stream_id,actor_id,trajectory_id));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS holdout_uses (holdout_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(holdout_id,run_id));
      CREATE TABLE IF NOT EXISTS feedback (scope_id TEXT NOT NULL, feedback_id TEXT NOT NULL, revision INTEGER NOT NULL, received_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope_id,feedback_id,revision));
      CREATE TABLE IF NOT EXISTS owners (scope_id TEXT NOT NULL, stream_id TEXT NOT NULL, owner_id TEXT NOT NULL, token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL, PRIMARY KEY(scope_id,stream_id));
      CREATE TABLE IF NOT EXISTS intents (decision_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, stream_id TEXT NOT NULL, idem TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      COMMIT;`);
    this.migrate(version);
    if (this.path !== ':memory:') chmodSync(this.path,0o600);
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}this.db.close();throw this.storageError(error);}
  }
  private migrate(version:number):void {
    if(version===2)return;
    this.transaction(()=>{
      // Another process may have completed migration while this connection waited for the write lock.
      const lockedVersion=Number((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
      invariant(lockedVersion<=2,'VERSION_INCOMPATIBLE','Database is newer than this runtime',{version:lockedVersion});
      if(lockedVersion===2)return;
      this.db.exec(`
        ALTER TABLE intents ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
        UPDATE intents SET status=COALESCE(json_extract(data,'$.receipt.status'),'pending');
        ALTER TABLE releases ADD COLUMN activated INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE releases ADD COLUMN invalid_reason TEXT;
        ALTER TABLE releases ADD COLUMN expected_active TEXT;
        ALTER TABLE releases ADD COLUMN validation_digest TEXT;
        ALTER TABLE releases ADD COLUMN last_deferral_id INTEGER;
        CREATE INDEX migration_release_events ON events(json_extract(data,'$.releaseDigest'),id) WHERE type='release.deferred';
        CREATE INDEX migration_feedback_events ON events(scope_id,json_extract(data,'$.feedbackId'),json_extract(data,'$.revision'),id) WHERE type='feedback.received';
        UPDATE releases SET expected_active=json_extract(data,'$.expectedActiveDigest'),validation_digest=json_extract(data,'$.validationDigest');
        UPDATE releases SET activated=1 WHERE digest IN (SELECT json_extract(data,'$.releaseDigest') FROM events WHERE type IN ('release.activated','release.rolled_back'));
        UPDATE releases SET last_deferral_id=(SELECT MAX(id) FROM events WHERE type='release.deferred' AND json_extract(events.data,'$.releaseDigest')=releases.digest);
        CREATE TABLE holdout_resources (id TEXT PRIMARY KEY,domain_id TEXT NOT NULL,protocol_digest TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE holdout_caps (id TEXT PRIMARY KEY,cap INTEGER NOT NULL);
        CREATE TABLE holdout_seeds (domain_id TEXT NOT NULL,seed INTEGER NOT NULL,holdout_id TEXT NOT NULL,PRIMARY KEY(domain_id,seed));
        CREATE TABLE feedback_latest (scope_id TEXT NOT NULL,feedback_id TEXT NOT NULL,revision INTEGER NOT NULL,received_at INTEGER NOT NULL,event_id INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope_id,feedback_id));
        INSERT INTO feedback_latest SELECT f.scope_id,f.feedback_id,f.revision,f.received_at,COALESCE((SELECT MAX(e.id) FROM events e WHERE e.scope_id=f.scope_id AND e.type='feedback.received' AND json_extract(e.data,'$.feedbackId')=f.feedback_id AND json_extract(e.data,'$.revision')=f.revision),0),f.data FROM feedback f WHERE NOT EXISTS(SELECT 1 FROM feedback newer WHERE newer.scope_id=f.scope_id AND newer.feedback_id=f.feedback_id AND newer.revision>f.revision);
        DROP INDEX migration_release_events;
        DROP INDEX migration_feedback_events;
        CREATE INDEX events_scope_id ON events(scope_id,id);
        CREATE INDEX events_scope_type_id ON events(scope_id,type,id);
        CREATE INDEX events_scope_type_timestamp ON events(scope_id,type,timestamp,id);
        CREATE INDEX artifacts_kind_visibility ON artifacts(kind,visibility);
        CREATE INDEX runs_scope_status ON runs(scope_id,status);
        CREATE INDEX intents_scope_stream_status ON intents(scope_id,stream_id,status);
        CREATE INDEX intents_unresolved ON intents(scope_id,stream_id) WHERE status IN ('pending','accepted','unknown');
        CREATE INDEX releases_pending ON releases(scope_id,activated,expected_active) WHERE invalid_reason IS NULL;
        CREATE INDEX releases_validation ON releases(validation_digest);
        CREATE INDEX feedback_scope_received ON feedback(scope_id,received_at DESC,feedback_id);
        CREATE INDEX feedback_latest_cursor ON feedback_latest(scope_id,event_id);
        CREATE INDEX feedback_latest_received ON feedback_latest(scope_id,received_at DESC,feedback_id);
        PRAGMA user_version=2;
      `);
      // Import old registrations once, without erasing usage or refusing historical conflicts.
      for(const row of this.db.prepare("SELECT data FROM artifacts WHERE kind='evaluation_protocol' ORDER BY rowid").all() as {data:string}[]) {
        const protocol=JSON.parse(row.data) as EvaluationProtocol;
        if(typeof protocol.holdoutId!=='string'||typeof protocol.domainId!=='string'||!Array.isArray(protocol.seeds)||!Number.isSafeInteger(protocol.maxHoldoutUses))continue;
        this.db.prepare('INSERT OR IGNORE INTO holdout_resources VALUES(?,?,?,?)').run(protocol.holdoutId,protocol.domainId,digest(protocol),row.data);
        this.db.prepare('INSERT INTO holdout_caps VALUES(?,?) ON CONFLICT(id) DO UPDATE SET cap=MIN(cap,excluded.cap)').run(protocol.holdoutId,protocol.maxHoldoutUses);
        for(const seed of protocol.seeds)this.db.prepare('INSERT OR IGNORE INTO holdout_seeds VALUES(?,?,?)').run(protocol.domainId,seed,protocol.holdoutId);
      }
    });
  }
  private storageError(error:unknown):unknown {
    if(error&&typeof error==='object'&&'errcode' in error&&error.errcode===13)return new DuelLoopError('STORAGE_FAILURE','SQLite database is full; existing evidence was not pruned',{...(this.maxDatabaseBytes===undefined?{}:{maxDatabaseBytes:this.maxDatabaseBytes})});
    return error;
  }
  private write<T>(operation:()=>T):T {try{return operation();}catch(error){throw this.storageError(error);}}
  private transaction<T>(fn:()=>T): T {
    if (this.depth) return fn();
    const begin=performance.now();
    try{this.write(()=>this.db.exec('BEGIN IMMEDIATE'));}finally{const elapsed=performance.now()-begin;this.transactionMetrics.writeTransactions++;this.transactionMetrics.writeLockWaitMs+=elapsed;this.transactionMetrics.maxWriteLockWaitMs=Math.max(this.transactionMetrics.maxWriteLockWaitMs,elapsed);}
    this.depth++;
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { try{this.db.exec('ROLLBACK');}catch{}throw this.storageError(error); }
    finally { this.depth--; }
  }
  private readTransaction<T>(fn:()=>T):T {
    if(this.depth)return fn();
    this.db.exec('BEGIN DEFERRED');this.depth++;
    try{const result=fn();this.db.exec('COMMIT');return result;}
    catch(error){try{this.db.exec('ROLLBACK');}catch{}throw this.storageError(error);}
    finally{this.depth--;}
  }
  bindScope(scopeId:string,applicationId:string):void {
    invariant(typeof scopeId==='string'&&scopeId.length>0&&typeof applicationId==='string'&&applicationId.length>0,'CONFIG_INVALID','Scope and application IDs required');
    this.transaction(()=>{
      const owner=this.db.prepare('SELECT application_id FROM scope_owners WHERE scope_id=?').get(scopeId) as any;
      invariant(!owner||owner.application_id===applicationId,'ACCESS_DENIED','Scope belongs to another application');
      this.db.prepare('INSERT OR IGNORE INTO scope_owners VALUES(?,?)').run(scopeId,applicationId);
    });
  }
  putArtifact(kind: string, value: unknown, visibility: 'public'|'private' = 'public'): string {
    const data = canonicalize(value);const bytes=Buffer.byteLength(data,'utf8');
    invariant(this.maxArtifactBytes===undefined||bytes<=this.maxArtifactBytes,'STORAGE_FAILURE','Artifact exceeds its configured UTF-8 byte limit',{artifactBytes:bytes,...(this.maxArtifactBytes===undefined?{}:{maxArtifactBytes:this.maxArtifactBytes})});
    const hash = createHash('sha256').update(data).digest('hex');
    this.transaction(()=>this.db.prepare('INSERT INTO artifacts(digest,kind,visibility,data) VALUES(?,?,?,?) ON CONFLICT(digest) DO UPDATE SET visibility=CASE WHEN artifacts.visibility=\'private\' OR excluded.visibility=\'private\' THEN \'private\' ELSE \'public\' END').run(hash,kind,visibility,data));
    return hash;
  }
  getArtifact<T>(hash: string, options: {allowPrivate?:boolean} = {}): T {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE digest=?').get(hash) as any;
    invariant(row, 'NOT_FOUND', 'Artifact missing', {digest:hash});
    invariant(row.visibility !== 'private' || options.allowPrivate, 'ACCESS_DENIED', 'Private artifact is not available to research tools');
    const value = JSON.parse(row.data); invariant(digest(value) === hash, 'STORAGE_FAILURE', 'Artifact digest mismatch', {digest:hash}); return value as T;
  }
  listArtifacts(kind?:string, allowPrivate=false): Artifact[] {
    const where:string[]=[];const parameters:string[]=[];
    if(kind!==undefined){where.push('kind=?');parameters.push(kind);}if(!allowPrivate)where.push("visibility='public'");
    const rows=this.db.prepare(`SELECT * FROM artifacts ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY rowid`).all(...parameters) as any[];
    return rows.map(r=>{const value=JSON.parse(r.data);invariant(digest(value)===r.digest,'STORAGE_FAILURE','Artifact digest mismatch',{digest:r.digest});return {digest:r.digest,kind:r.kind,visibility:r.visibility,value};});
  }
  appendEvent(type:string,scopeId:string,data:unknown,visibility:'public'|'private'='public'): JournalEvent {
    return this.transaction(()=>{
      const timestamp=Date.now(); const encoded=canonicalize(data);
      const result=this.db.prepare('INSERT INTO events(type,scope_id,timestamp,visibility,data) VALUES(?,?,?,?,?)').run(type,scopeId,timestamp,visibility,encoded);
      const event={id:Number(result.lastInsertRowid),type,scopeId,timestamp,data:JSON.parse(encoded),visibility};
      if(type==='release.activated'||type==='release.rolled_back')this.db.prepare('UPDATE releases SET activated=1 WHERE digest=? AND scope_id=?').run(event.data.releaseDigest,scopeId);
      if(type==='release.invalid')this.db.prepare('UPDATE releases SET invalid_reason=? WHERE digest=? AND scope_id=?').run(String(event.data.reason??'invalid'),event.data.releaseDigest,scopeId);
      if(type==='release.deferred')this.db.prepare('UPDATE releases SET last_deferral_id=? WHERE digest=? AND scope_id=?').run(event.id,event.data.releaseDigest,scopeId);
      return event;
    });
  }
  events(options:{scopeId?:string;afterId?:number;allowPrivate?:boolean;types?:string[];limit?:number;descending?:boolean}={}):JournalEvent[] {
    invariant(options.limit===undefined||Number.isSafeInteger(options.limit)&&options.limit>0,'CONFIG_INVALID','Event limit must be positive');
    if(options.types?.length===0)return [];
    const where=['id>?'];const parameters:(string|number)[]=[options.afterId??0];
    if(options.scopeId!==undefined){where.push('scope_id=?');parameters.push(options.scopeId);}
    if(!options.allowPrivate)where.push("visibility='public'");
    if(options.types){where.push(`type IN (${options.types.map(()=>'?').join(',')})`);parameters.push(...options.types);}
    if(options.limit!==undefined)parameters.push(options.limit);
    const rows=this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id ${options.descending?'DESC':'ASC'} ${options.limit===undefined?'':'LIMIT ?'}`).all(...parameters) as any[];
    return rows.map(r=>({id:r.id,type:r.type,scopeId:r.scope_id,timestamp:r.timestamp,visibility:r.visibility,data:JSON.parse(r.data)}));
  }
  latestEvent(scopeId:string,type:string,options:{allowPrivate?:boolean}={}):JournalEvent|undefined {return this.events({scopeId,types:[type],limit:1,descending:true,...options})[0];}
  registerRelease(binding:ReleaseBinding):string {
    return this.transaction(()=>{
      this.getArtifact(binding.strategyDigest);
      if (binding.source==='research') {
        invariant(binding.researchRunId && binding.validationDigest, 'VALIDATION_REJECTED', 'Research release needs run and validation');
        const run=this.getRun(binding.researchRunId);
        invariant(run.status==='completed_passed', 'CANCELLED', 'Only completed successful runs may register release');
        invariant(run.scopeId===binding.scopeId && run.baseReleaseDigest===binding.expectedActiveDigest,'VALIDATION_REJECTED','Release run binding mismatch');
      }
      const hash=this.putArtifact('release',binding);
      this.db.prepare('INSERT OR IGNORE INTO releases(digest,scope_id,data,expected_active,validation_digest) VALUES(?,?,?,?,?)').run(hash,binding.scopeId,canonicalize(binding),binding.expectedActiveDigest,binding.validationDigest??null);
      this.db.prepare('INSERT OR IGNORE INTO scopes(id) VALUES(?)').run(binding.scopeId);
      return hash;
    });
  }
  release(hash:string):ReleaseBinding {
    const row=this.db.prepare('SELECT data FROM releases WHERE digest=?').get(hash) as any;
    invariant(row,'NOT_FOUND','Release missing',{digest:hash});
    const value=JSON.parse(row.data) as ReleaseBinding; invariant(digest(value)===hash,'STORAGE_FAILURE','Release digest mismatch'); return value;
  }
  activeRelease(scopeId:string):string|null { return (this.db.prepare('SELECT active FROM scopes WHERE id=?').get(scopeId) as any)?.active??null; }
  scopeStatus(scopeId:string,dependencies?:BehaviorDependencies):ScopeStatus {
    return this.transaction(()=>{
      const scope=this.db.prepare('SELECT * FROM scopes WHERE id=?').get(scopeId) as any;
      const active=scope?.active??null;
      const activationMode=scope?.mode??'automatic_after_validation';const activationPaused=!!scope?.paused;
      const releases=(this.db.prepare('SELECT digest,activated,last_deferral_id,invalid_reason FROM releases WHERE scope_id=? ORDER BY rowid').all(scopeId) as {digest:string;activated:number;last_deferral_id:number|null;invalid_reason:string|null}[]).map(({digest:hash,activated,last_deferral_id,invalid_reason})=>{
        const binding=this.release(hash);const isActive=hash===active;const blockers:string[]=invalid_reason?[invalid_reason]:[];
        const retired=!isActive&&!!activated;
        try {this.assertReleaseEligible(hash,dependencies??binding.dependencies);}catch(error){blockers.push(error instanceof DuelLoopError?error.code:'STORAGE_FAILURE');}
        if(!isActive){
          if(activationPaused)blockers.push('activation_paused');
          if(activationMode==='candidate_only')blockers.push('candidate_only');
          if(activationMode==='explicit')blockers.push('explicit_activation_required');
          if(retired)blockers.push('previously_activated_requires_explicit_reactivation');
          if(binding.expectedActiveDigest!==active)blockers.push('baseline_changed');
        }
        const last=last_deferral_id===null?undefined:this.db.prepare('SELECT timestamp,data FROM events WHERE id=?').get(last_deferral_id) as {timestamp:number;data:string}|undefined;
        return {...binding,digest:hash,active:isActive,state:isActive?'active' as const:retired?'retired' as const:blockers.length?'blocked' as const:'pending' as const,blockers,boundaryStatus:'not_checked' as const,
          ...(last?{lastDeferral:{timestamp:last.timestamp,reason:String(JSON.parse(last.data).reason??'unknown')}}:{})};
      });
      return {scopeId,activeReleaseDigest:active,activationPaused,activationMode,dependenciesChecked:!!dependencies,releases};
    });
  }
  pendingReleases(scopeId:string):{digest:string;binding:ReleaseBinding}[] {
    const rows=this.db.prepare(`SELECT r.digest,r.data FROM releases r JOIN scopes s ON s.id=r.scope_id WHERE r.scope_id=? AND r.activated=0 AND r.invalid_reason IS NULL AND r.expected_active IS s.active AND r.digest IS NOT s.active AND NOT EXISTS(SELECT 1 FROM invalid_validations v WHERE v.digest=r.validation_digest) ORDER BY r.rowid`).all(scopeId) as {digest:string;data:string}[];
    return rows.map(row=>{const binding=JSON.parse(row.data) as ReleaseBinding;invariant(digest(binding)===row.digest,'STORAGE_FAILURE','Release digest mismatch');return {digest:row.digest,binding};});
  }
  assertUsableRelease(hash:string,options:{dependencies:BehaviorDependencies;executionMode:ExecutionMode}):void {
    this.assertReleaseEligible(hash,options.dependencies);
    const binding=this.release(hash);
    if(binding.source==='research'&&options.executionMode==='live') {
      invariant(binding.validationDigest,'VALIDATION_REJECTED','Research release requires validation');
      const report=this.getArtifact<ValidationReport>(binding.validationDigest,{allowPrivate:true});
      invariant(report.modelKind==='real','VALIDATION_REJECTED','Live execution requires real-model final validation');
    }
  }
  assertReleaseEligible(hash:string,dependencies:BehaviorDependencies):void {
    const binding=this.release(hash);
    invariant(digest(dependencies)===digest(binding.dependencies),'VERSION_INCOMPATIBLE','Behavior dependencies changed');
    this.getArtifact(binding.strategyDigest);
    if(binding.validationDigest){
      invariant(!this.db.prepare('SELECT 1 FROM invalid_validations WHERE digest=?').get(binding.validationDigest),'VALIDATION_REJECTED','Validation eligibility revoked');
      const report=this.getArtifact<ValidationReport>(binding.validationDigest,{allowPrivate:true});
      invariant(report.status==='passed'&&report.stage==='final'&&report.candidateDigest===binding.strategyDigest&&report.baseReleaseDigest===binding.expectedActiveDigest&&digest(report.dependencies)===digest(dependencies),'VALIDATION_REJECTED','Validation binding mismatch');
    }else invariant(binding.source==='bootstrap','VALIDATION_REJECTED','Research release requires validation');
  }
  activate(hash:string,dependencies:BehaviorDependencies,options:{explicit?:boolean}={}):void {
    this.transaction(()=>{
      const binding=this.release(hash); const scope=this.db.prepare('SELECT * FROM scopes WHERE id=?').get(binding.scopeId) as any;
      invariant(scope,'NOT_FOUND','Activation scope missing');
      invariant(!scope.paused,'ACTIVATION_DEFERRED','Activation paused',{reason:'activation_paused'});
      invariant(scope.mode!=='candidate_only','ACTIVATION_DEFERRED','Candidate-only mode does not activate releases',{reason:'candidate_only'});
      invariant(scope.mode!=='explicit'||options.explicit,'ACTIVATION_DEFERRED','Explicit activation required',{reason:'explicit_activation_required'});
      invariant(options.explicit||!(this.db.prepare('SELECT activated FROM releases WHERE digest=?').get(hash) as {activated:number}).activated,'CONFLICT','Previously activated release requires explicit reactivation');
      invariant(scope.active===binding.expectedActiveDigest,'CONFLICT','Current release differs from evaluated baseline');
      this.assertReleaseEligible(hash,dependencies);
      invariant(digest(dependencies)===digest(binding.dependencies),'VERSION_INCOMPATIBLE','Behavior dependencies changed');
      this.getArtifact(binding.strategyDigest);
      if(binding.source==='research') {
        invariant(binding.validationDigest,'VALIDATION_REJECTED','Missing validation');
        invariant(!this.db.prepare('SELECT 1 FROM invalid_validations WHERE digest=?').get(binding.validationDigest),'VALIDATION_REJECTED','Validation eligibility revoked');
        const report=this.getArtifact<ValidationReport>(binding.validationDigest,{allowPrivate:true});
        invariant(report.status==='passed' && report.stage==='final' && report.candidateDigest===binding.strategyDigest && report.baseReleaseDigest===binding.expectedActiveDigest && digest(report.dependencies)===digest(dependencies),'VALIDATION_REJECTED','Validation binding mismatch');
        invariant(binding.researchRunId && this.getRun(binding.researchRunId).status==='completed_passed','CANCELLED','Research did not complete');
      } else invariant(scope.active===null,'CONFLICT','Bootstrap only allowed for empty scope');
      this.db.prepare('UPDATE scopes SET active=? WHERE id=?').run(hash,binding.scopeId);
      this.appendEvent('release.activated',binding.scopeId,{releaseDigest:hash,previous:binding.expectedActiveDigest});
    });
  }
  rollback(scopeId:string,target:string,dependencies:BehaviorDependencies):void {
    this.transaction(()=>{
      const binding=this.release(target); invariant(binding.scopeId===scopeId,'CONFLICT','Wrong rollback scope');
      this.assertReleaseEligible(target,dependencies);
      invariant(digest(binding.dependencies)===digest(dependencies),'VERSION_INCOMPATIBLE','Rollback dependencies incompatible');
      this.getArtifact(binding.strategyDigest);
      if(binding.validationDigest) {
        invariant(!this.db.prepare('SELECT 1 FROM invalid_validations WHERE digest=?').get(binding.validationDigest),'VALIDATION_REJECTED','Rollback validation revoked');
        const report=this.getArtifact<ValidationReport>(binding.validationDigest,{allowPrivate:true}); invariant(report.status==='passed','VALIDATION_REJECTED','Rollback needs valid report');
      }
      const previous=this.activeRelease(scopeId); invariant(previous,'NOT_FOUND','Scope not initialized');
      this.db.prepare('UPDATE scopes SET active=? WHERE id=?').run(target,scopeId);
      this.appendEvent('release.rolled_back',scopeId,{previous,releaseDigest:target});
    });
  }
  setActivationMode(scopeId:string,mode:'candidate_only'|'automatic_after_validation'|'explicit'):void {
    invariant(['candidate_only','automatic_after_validation','explicit'].includes(mode),'CONFIG_INVALID','Invalid activation mode');
    this.write(()=>this.db.prepare('INSERT INTO scopes(id,mode) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode').run(scopeId,mode));
  }
  pauseActivation(scopeId:string,paused:boolean):void {
    this.transaction(()=>{
    this.db.prepare('INSERT INTO scopes(id,paused) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET paused=excluded.paused').run(scopeId,paused?1:0);
    this.appendEvent('activation.paused',scopeId,{paused});
    });
  }
  invalidateValidation(hash:string,reason:string):void {
    this.transaction(()=>{
      this.getArtifact(hash,{allowPrivate:true});
      this.db.prepare('INSERT OR REPLACE INTO invalid_validations VALUES(?,?)').run(hash,reason);
      const affected = new Map<string,string[]>();
      for(const row of this.db.prepare('SELECT digest,scope_id FROM releases WHERE validation_digest=?').all(hash) as {digest:string;scope_id:string}[]) {
        const releases=affected.get(row.scope_id)??[];releases.push(row.digest);affected.set(row.scope_id,releases);
      }
      if(!affected.size)this.appendEvent('validation.invalidated','system',{validationDigest:hash,reason});
      else for(const [scopeId,releaseDigests] of affected)this.appendEvent('validation.invalidated',scopeId,{validationDigest:hash,reason,releaseDigests});
    });
  }
  trajectoryRelease(scopeId:string,streamId:string,actorId:string,trajectoryId:string):string {
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT release_digest FROM trajectories WHERE scope_id=? AND stream_id=? AND actor_id=? AND trajectory_id=?').get(scopeId,streamId,actorId,trajectoryId) as any;
      if(row) return row.release_digest;
      const active=this.activeRelease(scopeId); invariant(active,'NOT_FOUND','Scope has no initial release',{scopeId});
      this.db.prepare('INSERT INTO trajectories VALUES(?,?,?,?,?)').run(scopeId,streamId,actorId,trajectoryId,active); return active;
    });
  }
  createRun(input:Omit<ResearchRun,'revision'|'createdAt'|'updatedAt'|'counters'>):ResearchRun {
    return this.transaction(()=>{
      invariant(!this.db.prepare('SELECT 1 FROM runs WHERE id=?').get(input.id),'CONFLICT','Run ID already exists');
      invariant(!this.db.prepare(`SELECT 1 FROM runs WHERE scope_id=? AND ${ACTIVE_RUN_SQL} LIMIT 1`).get(input.scopeId),'CONFLICT','Research already active for scope');
      invariant(this.activeRelease(input.scopeId)===input.baseReleaseDigest,'CONFLICT','Research baseline not current');
      const now=Date.now(); const run={...input,revision:0,createdAt:now,updatedAt:now,counters:{}};
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(run.id,run.scopeId,run.status,0,canonicalize(run));return run;
    });
  }
  getRun(id:string):ResearchRun { const row=this.db.prepare('SELECT data FROM runs WHERE id=?').get(id) as any; invariant(row,'NOT_FOUND','Research run missing',{researchRunId:id}); return JSON.parse(row.data); }
  listRuns(scopeId?:string):ResearchRun[] { return (this.db.prepare(`SELECT data FROM runs ${scopeId===undefined?'':'WHERE scope_id=?'} ORDER BY rowid`).all(...(scopeId===undefined?[]:[scopeId])) as {data:string}[]).map(r=>JSON.parse(r.data)); }
  activeRun(scopeId:string):ResearchRun|undefined {
    const row=this.db.prepare(`SELECT data FROM runs WHERE scope_id=? AND ${ACTIVE_RUN_SQL} LIMIT 1`).get(scopeId) as {data:string}|undefined;
    return row?JSON.parse(row.data):undefined;
  }
  transitionRun(id:string,expected:RunStatus[],next:RunStatus,data:Record<string,Json>={}):ResearchRun {
    return this.transaction(()=>{
      const run=this.getRun(id); invariant(expected.includes(run.status),'CONFLICT','Run changed before transition',{researchRunId:id,status:run.status});
      invariant(next===run.status&&!TERMINAL.has(next)||TRANSITIONS[run.status]?.includes(next),'CONFLICT','Invalid run transition',{from:run.status,to:next});
      const updated={...run,status:next,revision:run.revision+1,updatedAt:Date.now(),data:{...run.data,...data}};
      this.db.prepare('UPDATE runs SET status=?,revision=?,data=? WHERE id=?').run(next,updated.revision,canonicalize(updated),id);
      this.appendEvent('research.transition',run.scopeId,{researchRunId:id,from:run.status,to:next});return updated;
    });
  }
  consumeBudget(id:string,counter:string,limit:number,amount=1):number {
    return this.transaction(()=>{
      invariant(Number.isFinite(limit)&&limit>=0&&Number.isFinite(amount)&&amount>=0,'CONFIG_INVALID','Invalid budget');
      const run=this.getRun(id); invariant(!TERMINAL.has(run.status)&&run.status!=='cancel_requested','CANCELLED','Run not accepting work');
      const previousCount=run.counters[counter]??0;const n=previousCount+amount; invariant(n<=limit,'BUDGET_EXHAUSTED',`Budget exceeded: ${counter}`,{researchRunId:id});
      run.counters[counter]=n;run.revision++;run.updatedAt=Date.now(); this.db.prepare('UPDATE runs SET revision=?,data=? WHERE id=?').run(run.revision,canonicalize(run),id);
      if(counter==='modelCalls'&&previousCount===0&&n===1&&run.data.trigger&&typeof run.data.trigger==='object'&&!Array.isArray(run.data.trigger))this.appendEvent('research.triggered',run.scopeId,{...run.data.trigger,runId:id});
      return n;
    });
  }
  cancelRun(id:string):ResearchRun { return this.transaction(()=>{const r=this.getRun(id); if(TERMINAL.has(r.status)||r.status==='cancel_requested')return r;return this.transitionRun(id,[r.status],'cancel_requested');}); }
  registerHoldout(protocol:EvaluationProtocol):void {
    this.transaction(()=>{
      invariant(typeof protocol.holdoutId==='string'&&protocol.holdoutId.length>0&&typeof protocol.domainId==='string'&&protocol.domainId.length>0&&Number.isSafeInteger(protocol.maxHoldoutUses)&&protocol.maxHoldoutUses>0&&Array.isArray(protocol.seeds)&&protocol.seeds.length>0&&protocol.seeds.every(Number.isSafeInteger),'CONFIG_INVALID','Invalid holdout registration');
      const hash=digest(protocol);const old=this.db.prepare('SELECT protocol_digest FROM holdout_resources WHERE id=?').get(protocol.holdoutId) as {protocol_digest:string}|undefined;
      invariant(!old||old.protocol_digest===hash,'HOLDOUT_UNAVAILABLE','Registered holdout protocol cannot be changed',{holdoutId:protocol.holdoutId});
      const cap=this.db.prepare('SELECT cap FROM holdout_caps WHERE id=?').get(protocol.holdoutId) as {cap:number}|undefined;
      invariant(!cap||cap.cap===protocol.maxHoldoutUses,'HOLDOUT_UNAVAILABLE','Registered holdout allowance cannot be changed',{holdoutId:protocol.holdoutId});
      for(const seed of protocol.seeds){
        const used=this.db.prepare('SELECT holdout_id FROM holdout_seeds WHERE domain_id=? AND seed=?').get(protocol.domainId,seed) as {holdout_id:string}|undefined;
        invariant(!used||used.holdout_id===protocol.holdoutId,'HOLDOUT_UNAVAILABLE','Final evaluation seeds cannot be reused under another holdout ID',{holdoutId:protocol.holdoutId});
      }
      this.db.prepare('INSERT OR IGNORE INTO holdout_resources VALUES(?,?,?,?)').run(protocol.holdoutId,protocol.domainId,hash,canonicalize(protocol));
      this.db.prepare('INSERT OR IGNORE INTO holdout_caps VALUES(?,?)').run(protocol.holdoutId,protocol.maxHoldoutUses);
      for(const seed of protocol.seeds)this.db.prepare('INSERT OR IGNORE INTO holdout_seeds VALUES(?,?,?)').run(protocol.domainId,seed,protocol.holdoutId);
    });
  }
  holdoutAvailability(id:string,limit:number):{used:number;remaining:number} {
    invariant(Number.isSafeInteger(limit)&&limit>=0,'CONFIG_INVALID','Holdout limit must be a nonnegative integer');
    const cap=this.db.prepare('SELECT cap FROM holdout_caps WHERE id=?').get(id) as {cap:number}|undefined;
    invariant(!cap||cap.cap===limit,'HOLDOUT_UNAVAILABLE','Registered holdout allowance cannot be changed',{holdoutId:id});
    const used=Number((this.db.prepare('SELECT count(*) AS n FROM holdout_uses WHERE holdout_id=?').get(id) as {n:number}).n);
    return {used,remaining:Math.max(0,(cap?.cap??limit)-used)};
  }
  claimHoldout(id:string,runId:string,limit:number):void {
    this.transaction(()=>{
      invariant(Number.isSafeInteger(limit)&&limit>0,'CONFIG_INVALID','Holdout limit must be positive');
      const availability=this.holdoutAvailability(id,limit);
      this.db.prepare('INSERT OR IGNORE INTO holdout_caps VALUES(?,?)').run(id,limit);
      const r=this.getRun(runId); invariant(r.status==='final_evaluating','CONFLICT','Holdout only in final stage');
      if(this.db.prepare('SELECT 1 FROM holdout_uses WHERE holdout_id=? AND run_id=?').get(id,runId))return;
      invariant(availability.remaining>0,'HOLDOUT_UNAVAILABLE','Holdout access budget exhausted',{holdoutId:id});
      this.db.prepare('INSERT INTO holdout_uses VALUES(?,?)').run(id,runId);
    });
  }
  recordFeedback(f:FeedbackEvent):void {
    invariant(Number.isInteger(f.revision)&&f.revision>=1&&Number.isFinite(f.receivedAt)&&Number.isFinite(f.eventTime),'CONFIG_INVALID','Invalid feedback revision or time');
    invariant(Object.values(f.metrics).every(Number.isFinite),'CONFIG_INVALID','Feedback metrics must be finite');
    this.transaction(()=>{
    const previous=this.db.prepare('SELECT data FROM feedback WHERE scope_id=? AND feedback_id=? AND revision=?').get(f.strategyScopeId,f.feedbackId,f.revision) as any;
    if(previous) { invariant(previous.data===canonicalize(f),'CONFLICT','Conflicting feedback revision');return; }
    this.db.prepare('INSERT INTO feedback VALUES(?,?,?,?,?)').run(f.strategyScopeId,f.feedbackId,f.revision,f.receivedAt,canonicalize(f));
    const event=this.appendEvent('feedback.received',f.strategyScopeId,f);
    this.db.prepare('INSERT INTO feedback_latest VALUES(?,?,?,?,?,?) ON CONFLICT(scope_id,feedback_id) DO UPDATE SET revision=excluded.revision,received_at=excluded.received_at,event_id=excluded.event_id,data=excluded.data WHERE excluded.revision>feedback_latest.revision').run(f.strategyScopeId,f.feedbackId,f.revision,f.receivedAt,event.id,canonicalize(f));
    });
  }
  feedbackProgress(scopeId:string,afterEventId:number):{eventId:number;receivedAt:number;settledTrajectories:number} {
    invariant(Number.isSafeInteger(afterEventId)&&afterEventId>=0,'CONFIG_INVALID','Feedback cursor must be a nonnegative integer');
    const row=this.db.prepare(`SELECT MAX(event_id) AS event_id,MAX(received_at) AS received_at,COUNT(DISTINCT CASE WHEN json_extract(data,'$.settled')=1 THEN json_extract(data,'$.trajectoryId') END) AS settled FROM feedback_latest WHERE scope_id=? AND event_id>?`).get(scopeId,afterEventId) as {event_id:number|null;received_at:number|null;settled:number};
    return {eventId:row.event_id??afterEventId,receivedAt:row.received_at??0,settledTrajectories:row.settled};
  }
  latestFeedback(scopeId:string,options:{afterEventId?:number;cutoff?:number}={}):{eventId:number;feedback:FeedbackEvent}[] {
    const rows=this.db.prepare('SELECT event_id,data FROM feedback_latest WHERE scope_id=? AND event_id>? AND received_at<=? ORDER BY event_id').all(scopeId,options.afterEventId??0,options.cutoff??Number.MAX_SAFE_INTEGER) as {event_id:number;data:string}[];
    return rows.map(row=>({eventId:row.event_id,feedback:JSON.parse(row.data)}));
  }
  snapshot(scopeId:string,cutoff:number,options:{maxDecisions?:number;maxFeedback?:number}={}):string {
    const maxDecisions=options.maxDecisions??1000;const maxFeedback=options.maxFeedback??1000;
    invariant(Number.isFinite(cutoff)&&[maxDecisions,maxFeedback].every(n=>Number.isSafeInteger(n)&&n>0&&n<=10000),'CONFIG_INVALID','Snapshot limits must be positive integers up to 10000');
    const {rows,feedbackRows,feedbackReadMode,decisionsTruncated,feedbackTruncated}=this.readTransaction(()=>{
      const rows=this.db.prepare("SELECT id,data FROM events WHERE scope_id=? AND type='decision' AND visibility='public' AND timestamp<=? ORDER BY timestamp DESC,id DESC LIMIT ?").all(scopeId,cutoff,maxDecisions+1) as {id:number;data:string}[];
      // Ordinary current snapshots use the latest-revision projection, so one heavily
      // revised feedback item cannot make every research round scan its revision history.
      const historical=!!this.db.prepare('SELECT 1 FROM feedback_latest WHERE scope_id=? AND received_at>? LIMIT 1').get(scopeId,cutoff);
      const feedbackRows=(historical
        ?this.db.prepare(`SELECT f.data FROM feedback f WHERE f.scope_id=? AND f.received_at<=? AND NOT EXISTS(SELECT 1 FROM feedback newer WHERE newer.scope_id=f.scope_id AND newer.feedback_id=f.feedback_id AND newer.revision>f.revision AND newer.received_at<=?) ORDER BY f.received_at DESC,f.feedback_id LIMIT ?`).all(scopeId,cutoff,cutoff,maxFeedback+1)
        :this.db.prepare('SELECT data FROM feedback_latest WHERE scope_id=? ORDER BY event_id DESC LIMIT ?').all(scopeId,maxFeedback+1)) as {data:string}[];
      return {rows:rows.slice(0,maxDecisions),feedbackRows:feedbackRows.slice(0,maxFeedback),decisionsTruncated:rows.length>maxDecisions,feedbackTruncated:feedbackRows.length>maxFeedback,feedbackReadMode:historical?'historical_revisions':'latest_projection'};
    });
    // Parsing, serialization and hashing happen after releasing the read transaction.
    // Only the final artifact INSERT takes the write lock.
    const decisions=rows.reverse().map(row=>JSON.parse(row.data) as DecisionRecord);
    const feedback=feedbackRows.reverse().map(row=>JSON.parse(row.data) as FeedbackEvent);
    return this.putArtifact('snapshot',{scopeId,cutoff,window:{mode:'latest_bounded',maxDecisions,maxFeedback,feedbackReadMode,decisionsTruncated,feedbackTruncated,firstDecisionEventId:rows[0]?.id??null,lastDecisionEventId:rows.at(-1)?.id??null},decisions,feedback,evidenceRefs:[...decisions.map(d=>d.decisionId),...feedback.map(f=>`${f.feedbackId}@${f.revision}`)]});
  }

  acquireOwner(scopeId:string,streamId:string,ownerId:string):string {
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT * FROM owners WHERE scope_id=? AND stream_id=?').get(scopeId,streamId) as any;
      if(old) {
        if(old.owner_id===ownerId&&old.pid===process.pid)return old.token;
        let alive=true;
        if(old.host===hostname()) {try{process.kill(old.pid,0);}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}}
        invariant(!alive,'CONFLICT','Stream already has an execution owner',{scopeId,streamId});
        invariant(this.unresolvedIntents(scopeId,streamId).length===0,'EXECUTION_UNKNOWN','Reconcile pending actions before owner takeover');
        this.db.prepare('DELETE FROM owners WHERE scope_id=? AND stream_id=?').run(scopeId,streamId);
      }
      const token=randomUUID();this.db.prepare('INSERT INTO owners VALUES(?,?,?,?,?,?)').run(scopeId,streamId,ownerId,token,process.pid,hostname());return token;
    });
  }
  assertOwner(scopeId:string,streamId:string,token:string):void {const row=this.db.prepare('SELECT token FROM owners WHERE scope_id=? AND stream_id=?').get(scopeId,streamId) as any; invariant(row?.token===token,'CONFLICT','Execution ownership lost');}
  releaseOwner(scopeId:string,streamId:string,token:string):void {this.db.prepare('DELETE FROM owners WHERE scope_id=? AND stream_id=? AND token=?').run(scopeId,streamId,token);}
  saveIntent(intent:Intent):void {
    this.transaction(()=>{
      this.assertOwner(intent.scopeId,intent.streamId,intent.ownerToken);
      const old=this.db.prepare('SELECT data FROM intents WHERE decision_id=? OR idem=?').get(intent.decisionId,intent.command.idempotencyKey) as any;
      invariant(!old,'EXECUTION_UNKNOWN','Intent already claimed; reconcile instead of submitting again');
      invariant(this.unresolvedIntents(intent.scopeId,intent.streamId).length===0,'EXECUTION_UNKNOWN','Stream has an unresolved execution intent');
      this.db.prepare('INSERT INTO intents(decision_id,scope_id,stream_id,idem,data,status) VALUES(?,?,?,?,?,?)').run(intent.decisionId,intent.scopeId,intent.streamId,intent.command.idempotencyKey,canonicalize(intent),intent.receipt?.status??'pending');
      this.appendEvent('execution.intent',intent.scopeId,{decisionId:intent.decisionId,idempotencyKey:intent.command.idempotencyKey});
    });
  }
  recordReceipt(receipt:ExecutionReceipt):void {
    this.transaction(()=>{
      invariant(['accepted','completed','rejected','unknown'].includes(receipt.status)&&Number.isFinite(receipt.timestamp),'CONFIG_INVALID','Invalid receipt');
      const row=this.db.prepare('SELECT data FROM intents WHERE decision_id=? AND idem=?').get(receipt.decisionId,receipt.idempotencyKey) as any;
      invariant(row,'NOT_FOUND','No matching execution intent'); const intent=JSON.parse(row.data) as Intent;
      if(intent.receipt&&['completed','rejected'].includes(intent.receipt.status)) {invariant(intent.receipt.status===receipt.status,'CONFLICT','Cannot change terminal execution status');return;}
      intent.receipt=receipt;this.db.prepare('UPDATE intents SET data=?,status=? WHERE decision_id=?').run(canonicalize(intent),receipt.status,receipt.decisionId);
      this.appendEvent('execution.receipt',intent.scopeId,receipt);
    });
  }
  intent(decisionId:string):Intent|undefined {const row=this.db.prepare('SELECT data FROM intents WHERE decision_id=?').get(decisionId) as {data:string}|undefined;return row?JSON.parse(row.data):undefined;}
  unresolvedIntents(scopeId?:string,streamId?:string):Intent[] {
    const where=["status IN ('pending','accepted','unknown')"];const parameters:string[]=[];
    if(scopeId!==undefined){where.push('scope_id=?');parameters.push(scopeId);}if(streamId!==undefined){where.push('stream_id=?');parameters.push(streamId);}
    return (this.db.prepare(`SELECT data FROM intents WHERE ${where.join(' AND ')} ORDER BY rowid`).all(...parameters) as {data:string}[]).map(row=>JSON.parse(row.data));
  }
  intents(scopeId?:string):Intent[] {return (this.db.prepare(`SELECT data FROM intents ${scopeId===undefined?'':'WHERE scope_id=?'} ORDER BY rowid`).all(...(scopeId===undefined?[]:[scopeId])) as {data:string}[]).map(r=>JSON.parse(r.data));}
  async backup(destination:string):Promise<void> {
    invariant(!existsSync(destination),'CONFLICT','Backup destination exists');mkdirSync(dirname(resolve(destination)),{recursive:true,mode:0o700});await sqliteBackup(this.db,destination);chmodSync(destination,0o600);
  }
  static restore(source:string,destination:string):SqliteStore {
    invariant(existsSync(source)&&!existsSync(destination),'CONFLICT','Restore needs existing backup and a new destination');
    let check:DatabaseSync|undefined;
    try {
      invariant(statSync(source).isFile()&&statSync(source).size>=100,'STORAGE_FAILURE','Backup must be an existing SQLite database, not an empty file');
      const header=Buffer.alloc(16);const descriptor=openSync(source,'r');
      try {readSync(descriptor,header,0,16,0);}finally{closeSync(descriptor);}
      invariant(header.equals(Buffer.from('SQLite format 3\0')),'STORAGE_FAILURE','Backup is not a SQLite database');
      invariant(!existsSync(`${source}-wal`)||statSync(`${source}-wal`).size===0,'STORAGE_FAILURE','Restore requires a standalone consistent backup, not a database with pending WAL data');
      check=new DatabaseSync(source,{readOnly:true});
      const version=Number((check.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
      invariant(version===1||version===2,'VERSION_INCOMPATIBLE','Backup schema is not supported',{version});
      const required:Record<string,string[]>={
        artifacts:['digest','kind','visibility','data'],events:['id','type','scope_id','timestamp','visibility','data'],
        scopes:['id','active','paused','mode'],scope_owners:['scope_id','application_id'],releases:['digest','scope_id','data'],
        invalid_validations:['digest','reason'],trajectories:['scope_id','stream_id','actor_id','trajectory_id','release_digest'],
        runs:['id','scope_id','status','revision','data'],holdout_uses:['holdout_id','run_id'],
        feedback:['scope_id','feedback_id','revision','received_at','data'],owners:['scope_id','stream_id','owner_id','token','pid','host'],
        intents:['decision_id','scope_id','stream_id','idem','data'],
      };
      if(version===2){required.intents!.push('status');required.releases!.push('activated','invalid_reason','expected_active','validation_digest','last_deferral_id');required.feedback_latest=['scope_id','feedback_id','revision','received_at','event_id','data'];required.holdout_resources=['id','domain_id','protocol_digest','data'];required.holdout_caps=['id','cap'];required.holdout_seeds=['domain_id','seed','holdout_id'];}
      for(const [table,columns] of Object.entries(required)) {
        const actual=new Set((check.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name));
        invariant(columns.every(column=>actual.has(column)),'STORAGE_FAILURE','Backup lacks required DuelLoop schema',{table});
      }
      invariant((check.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check==='ok','STORAGE_FAILURE','Backup failed SQLite integrity check');
      const artifacts=new Set<string>();
      for(const row of check.prepare('SELECT digest,data FROM artifacts').all() as {digest:string;data:string}[]) {
        invariant(digest(JSON.parse(row.data))===row.digest,'STORAGE_FAILURE','Backup artifact digest mismatch',{digest:row.digest});artifacts.add(row.digest);
      }
      for(const row of check.prepare('SELECT digest,data FROM releases').all() as {digest:string;data:string}[]) {
        const binding=JSON.parse(row.data) as ReleaseBinding;
        invariant(digest(binding)===row.digest&&artifacts.has(binding.strategyDigest)&&(!binding.validationDigest||artifacts.has(binding.validationDigest)),'STORAGE_FAILURE','Backup release evidence is incomplete',{digest:row.digest});
      }
    }catch(error){if(error instanceof DuelLoopError)throw error;throw new DuelLoopError('STORAGE_FAILURE','Backup could not be read or validated');}
    finally{check?.close();}
    mkdirSync(dirname(resolve(destination)),{recursive:true,mode:0o700});copyFileSync(source,destination,constants.COPYFILE_EXCL);return new SqliteStore(destination);
  }
  integrity():{ok:boolean;issues:string[]} {
    const issues:string[]=[];
    const result=this.db.prepare('PRAGMA integrity_check').get() as any;if(result.integrity_check!=='ok')issues.push(String(result.integrity_check));
    for(const r of this.db.prepare('SELECT digest,data FROM artifacts').all() as any[])try{if(digest(JSON.parse(r.data))!==r.digest)issues.push(`artifact:${r.digest}`);}catch{issues.push(`artifact:${r.digest}`);}
    for(const r of this.db.prepare('SELECT digest FROM releases').all() as any[])try{const b=this.release(r.digest);this.getArtifact(b.strategyDigest);if(b.validationDigest)this.getArtifact(b.validationDigest,{allowPrivate:true});}catch{issues.push(`release:${r.digest}`);}
    return {ok:issues.length===0,issues};
  }
  pruneUnreferencedArtifacts(options:{dryRun?:boolean;kinds?:string[]}={}):{dryRun:boolean;digests:string[]} {
    return this.transaction(()=>{
      const artifacts=this.db.prepare('SELECT digest,kind,data FROM artifacts').all() as any[];
      const byId=new Map(artifacts.map(a=>[a.digest,a]));const reachable=new Set<string>();
      const visit=(value:unknown):void=>{
        if(typeof value==='string'&&byId.has(value)&&!reachable.has(value)){reachable.add(value);visit(JSON.parse(byId.get(value)!.data));}
        else if(Array.isArray(value))value.forEach(visit);
        else if(value&&typeof value==='object')Object.values(value).forEach(visit);
      };
      for(const table of ['events','runs','releases','intents'])for(const row of this.db.prepare(`SELECT data FROM ${table}`).all() as any[])visit(JSON.parse(row.data));
      for(const row of this.db.prepare('SELECT active FROM scopes').all() as any[])visit(row.active);
      for(const row of this.db.prepare('SELECT release_digest FROM trajectories').all() as any[])visit(row.release_digest);
      for(const row of this.db.prepare('SELECT digest FROM invalid_validations').all() as any[])visit(row.digest);
      const kinds=options.kinds??['snapshot','behavior_fixture'];
      const digests=artifacts.filter(a=>kinds.includes(a.kind)&&!reachable.has(a.digest)).map(a=>a.digest as string);
      if(options.dryRun===false)for(const hash of digests)this.db.prepare('DELETE FROM artifacts WHERE digest=?').run(hash);
      return {dryRun:options.dryRun!==false,digests};
    });
  }
  /** BEGIN IMMEDIATE elapsed time includes SQLite statement overhead and lock acquisition/wait. */
  diagnostics():{writeTransactions:number;writeLockWaitMs:number;maxWriteLockWaitMs:number} {return {...this.transactionMetrics};}
  close():void {this.db.close();}
}
