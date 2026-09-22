export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Features = Record<string, Json>;
export type ExecutionMode = 'offline' | 'simulation' | 'shadow' | 'live';
export type DecisionSource = 'strategy' | 'domain_baseline' | 'forced_action' | 'abstain';
export interface Observation {
  applicationId: string; domainId: string; strategyScopeId: string; streamId: string;
  actorId: string; trajectoryId: string; revision: string; observedAt: number;
  deadline: number; features: Features; terminal?: boolean;
}
export interface CandidateAction { id: string; kind: string; parameters: Features; revision: string }
export interface FeatureSpec { type: 'number' | 'string' | 'boolean' | 'object'; required: boolean }
export interface ActionCommand {
  decisionId: string; idempotencyKey: string; expectedStateRevision: string;
  observation: Observation; action: CandidateAction; deadline: number; ownerToken?: string;
}
export interface ExecutionReceipt {
  decisionId: string; idempotencyKey: string;
  status: 'accepted' | 'completed' | 'rejected' | 'unknown';
  timestamp: number; environmentActionId?: string; details?: Features;
}
export interface FeedbackEvent {
  feedbackId: string; revision: number; eventTime: number; receivedAt: number;
  applicationId: string; strategyScopeId: string; trajectoryId: string;
  decisionId?: string; metrics: Record<string, number>; settled: boolean;
}
export interface DomainDefinition {
  id: string; rulesVersion: string; featureContract: string;
  featureBuilderVersion: string; knowledgeUpdaterVersion: string;
  baselineVersion: string; continuationVersion: string;
  features: Record<string, FeatureSpec>; context: Features;
  capabilities: {
    execution: boolean; idempotency: boolean; statusQuery: boolean;
    delayedFeedback: boolean; revisedFeedback: boolean;
    activationBoundary: 'trajectory' | 'scope'; evaluation: boolean;
  };
  observe(streamId: string): Promise<Observation>;
  candidates(observation: Observation): Promise<CandidateAction[]>;
  fallback(observation: Observation, reason: string): Promise<CandidateAction | null>;
  execute?(command: ActionCommand): Promise<ExecutionReceipt>;
  executionStatus?(idempotencyKey: string): Promise<ExecutionReceipt>;
  feedback?(): Promise<FeedbackEvent[]>;
  canActivate?(scopeId: string): Promise<boolean>;
}
export type Condition =
  | { feature: string; op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'; value: Json }
  | { all: Condition[] } | { any: Condition[] } | { not: Condition };
export interface ScoreDimension {
  id: string; type: 'score'; forEach: 'candidate'; instructions: string;
  criteria: string[]; normalization: 'divide_by_max_level';
  semantics: { target: string; horizon: string; continuation: string; overlap: string };
}
export interface StrategyPackage {
  schemaVersion: '1.0'; strategyId: string; version: string; parentVersion?: string;
  scope: { domain: string; rulesVersion: string; featureContract: string };
  stateProjection: string[]; questions: ScoreDimension[];
  decision: {
    defaultWeights: Record<string, number>;
    branches: { id: string; when: Condition; weights: Record<string, number> }[];
    branchPolicy: 'first_match'; aggregate: 'weighted_sum';
    selection: { mode: 'argmax' | 'softmax_sample'; tieBreak: 'domain_priority'; temperature?: number };
    minRequiredConfidence: number;
  };
  exitConditions: Condition[]; fallback: { mode: 'domain_baseline' };
  provenance: { researchRunId: string; snapshotId: string; hypothesis: string };
}
export interface ScoreQuestion { id: string; actionId: string; dimensionId: string; instructions: string; criteria: string[] }
export interface ScoreAnswer { score: number; confidence: number; probabilities: Record<string, number> }
export interface ModelUsage { inputTokens?: number; outputTokens?: number; costUsd?: number; unknown?: boolean }
export interface DecisionModel {
  id: string; kind: 'real' | 'fixture';
  score(request: { state: Features; questions: ScoreQuestion[]; signal: AbortSignal }): Promise<{
    answers: Record<string, ScoreAnswer>; model: string; usage?: ModelUsage;
  }>;
}
export interface BehaviorDependencies {
  model: string; runtime: string; rules: string; featureBuilder: string;
  knowledgeUpdater: string; fallbackBaseline: string; continuationPolicy: string; contextDigest: string;
}
export interface ReleaseBinding {
  strategyDigest: string; dependencies: BehaviorDependencies; scopeId: string;
  expectedActiveDigest: string | null; validationDigest: string | null;
  source: 'bootstrap' | 'research'; researchRunId?: string;
}
export interface DecisionRecord {
  decisionId: string; observation: Observation; candidates: CandidateAction[];
  releaseDigest: string; strategyDigest: string; decisionSource: DecisionSource;
  action: CandidateAction | null; fallbackReason?: string; fallbackBaselineDigest?: string;
  branchId?: string; questions: ScoreQuestion[]; answers: Record<string, ScoreAnswer>;
  utilities: Record<string, number>; probabilities: Record<string, number>;
  model?: string; modelKind?: 'real' | 'fixture'; usage?: ModelUsage;
  startedAt: number; finishedAt: number; randomSeed?: string;
}
export type RunStatus = 'created' | 'researching' | 'development_evaluating' | 'candidate_locked'
  | 'final_evaluating' | 'cancel_requested' | 'cancelled' | 'no_change' | 'budget_exhausted'
  | 'completed_passed' | 'completed_failed' | 'completed_inconclusive' | 'error';
export interface ResearchRun {
  id: string; scopeId: string; baseReleaseDigest: string; researchSnapshotId: string;
  evaluationProtocolDigest: string; status: RunStatus; revision: number;
  counters: Record<string, number>; createdAt: number; updatedAt: number;
  data: Record<string, Json>;
}
export interface BehaviorCase {
  id: string; observation: Observation; candidates: CandidateAction[];
  answers: Record<string, ScoreAnswer>; questionDigest: string;
  assertion: { op: 'selected_action_is' | 'utility_margin_decreases' | 'utilities_equal' | 'action_probability_decreases'; actionId?: string; otherActionId?: string; tolerance?: number };
}
export interface CandidateSubmission {
  submissionId: string; researchRunId: string; strategy: StrategyPackage;
  baseReleaseDigest: string; researchSnapshotId: string; evaluationProtocolDigest: string;
  hypothesis: string; evidenceRefs: string[]; expectedBehaviorChanges: BehaviorCase[];
  regressionCases: BehaviorCase[]; knownRisks: string[];
}
export interface EvaluationProtocol {
  version: '1.0'; id: string; domainId: string; seeds: number[];
  opponentIds: string[]; trajectoriesPerSeed: number;
  knowledgeStateMode: 'frozen' | 'online_update'; initialKnowledge: Features;
  metric: { name: string; direction: 'maximize' | 'minimize'; unit: string };
  minSamples: number; minimumImprovement: number; maxGroupRegression: number;
  confidenceLevel: number; maxFallbackRate: number; maxP95LatencyMs: number;
  maxDevelopmentEvalRuns: number; maxFinalEvaluationsPerRun: number;
  holdoutId: string; maxHoldoutUses: number;
}
export interface EvaluationEpisode {
  reward: number; decisions: number; fallbacks: number; latenciesMs: number[];
  modelCalls: number; usage?: ModelUsage;
}
export interface DecisionPolicy {
  maxDecisionMs: number; executionReserveMs: number; randomSeed?: string;
}
export interface EvaluationAdapter {
  id: string;
  /** Policy actually executed by the evaluator; must match the release runtime binding. */
  readonly decisionPolicy: DecisionPolicy;
  /** Rules, feature/knowledge builders, baseline, continuation and context actually simulated. */
  readonly domainDependencies: Omit<BehaviorDependencies, 'model' | 'runtime'>;
  episode(input: { strategy: StrategyPackage; model: DecisionModel; seed: number;
    opponentId: string; trajectories: number; knowledge: Features;
    knowledgeStateMode: 'frozen' | 'online_update'; signal: AbortSignal }): Promise<EvaluationEpisode>;
}
export interface ValidationReport {
  evaluationAdapterId?: string;
  candidateDigest: string; baseReleaseDigest: string; protocolDigest: string;
  dependencies: BehaviorDependencies; status: 'passed' | 'failed' | 'inconclusive';
  reasons: string[]; modelKind: 'real' | 'fixture'; stage: 'development' | 'final';
  sampleCount: number; meanDifference: number; lowerBound: number;
  groups: Record<string, { meanDifference: number; lowerBound: number }>;
  fallbackRate: number; p95LatencyMs: number; createdAt: number;
}
export interface ResearchTool { name: string; description: string; schema: Record<string, Json>; execute(input: unknown): Promise<Json> }
export interface ResearchProvider {
  id: string; kind: 'real' | 'fixture';
  run(input: { role: string; prompt: string; tools: ResearchTool[]; signal: AbortSignal;
    maxTokens: number; sessionId: string;
    /** Current framework budget excluding this call's uncommitted cumulative usage; providers subtract their own usage. */
    getRemainingTokens?: () => number;
    /** Reports this call's cumulative usage after each response; notification does not commit budget counters. */
    onUsage?: (usage: ModelUsage) => void;
  }): Promise<{ output: Json; usage: ModelUsage }>;
  dispose?(): Promise<void>;
}
export interface JournalEvent { id: number; type: string; scopeId: string; timestamp: number; data: Json; visibility: 'public' | 'private' }
export interface Artifact { digest: string; kind: string; visibility: 'public' | 'private'; value: Json }
export interface Intent { decisionId: string; scopeId: string; streamId: string; ownerToken: string; command: ActionCommand; receipt: ExecutionReceipt | null }
export interface ScopeStatus {
  scopeId: string; activeReleaseDigest: string | null; activationPaused: boolean;
  activationMode: 'candidate_only' | 'automatic_after_validation' | 'explicit';
  dependenciesChecked: boolean;
  releases: Array<ReleaseBinding & { digest: string; active: boolean; state: 'active' | 'pending' | 'retired' | 'blocked'; blockers: string[]; boundaryStatus: 'not_checked'; lastDeferral?: { timestamp: number; reason: string } }>;
}
export interface DuelLoopStore {
  bindScope(scopeId: string, applicationId: string): void;
  putArtifact(kind: string, value: unknown, visibility?: 'public' | 'private'): string;
  getArtifact<T>(digest: string, options?: { allowPrivate?: boolean }): T;
  listArtifacts(kind?: string, allowPrivate?: boolean): Artifact[];
  appendEvent(type: string, scopeId: string, data: unknown, visibility?: 'public' | 'private'): JournalEvent;
  events(options?: { scopeId?: string; afterId?: number; allowPrivate?: boolean }): JournalEvent[];
  registerRelease(binding: ReleaseBinding): string;
  activeRelease(scopeId: string): string | null;
  scopeStatus(scopeId: string, dependencies?: BehaviorDependencies): ScopeStatus;
  release(digest: string): ReleaseBinding;
  assertReleaseEligible(digest: string, dependencies: BehaviorDependencies): void;
  activate(digest: string, dependencies: BehaviorDependencies, options?: { explicit?: boolean }): void;
  rollback(scopeId: string, target: string, dependencies: BehaviorDependencies): void;
  setActivationMode(scopeId: string, mode: 'candidate_only' | 'automatic_after_validation' | 'explicit'): void;
  pauseActivation(scopeId: string, paused: boolean): void;
  invalidateValidation(validationDigest: string, reason: string): void;
  trajectoryRelease(scopeId: string, streamId: string, actorId: string, trajectoryId: string): string;
  createRun(run: Omit<ResearchRun, 'revision' | 'createdAt' | 'updatedAt' | 'counters'>): ResearchRun;
  getRun(id: string): ResearchRun;
  listRuns(scopeId?: string): ResearchRun[];
  transitionRun(id: string, expected: RunStatus[], next: RunStatus, data?: Record<string, Json>): ResearchRun;
  consumeBudget(id: string, counter: string, limit: number, amount?: number): number;
  cancelRun(id: string): ResearchRun;
  claimHoldout(id: string, runId: string, limit: number): void;
  recordFeedback(feedback: FeedbackEvent): void;
  snapshot(scopeId: string, cutoff: number): string;
  acquireOwner(scopeId: string, streamId: string, ownerId: string): string;
  releaseOwner(scopeId: string, streamId: string, ownerToken: string): void;
  assertOwner(scopeId: string, streamId: string, ownerToken: string): void;
  /** Atomically claim a new submission. Reject duplicate or unresolved stream intents. */
  saveIntent(intent: Intent): void;
  recordReceipt(receipt: ExecutionReceipt): void;
  intents(scopeId?: string): Intent[];
  close(): void;
}
