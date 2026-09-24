import { randomUUID } from 'node:crypto';
import { invariant } from './errors.js';
import { digest, seededRandom, withDeadline } from './utils.js';
import { buildQuestions, compileStrategy, evaluateAnswers } from './strategy.js';
import type { ActionCommand, CandidateAction, DecisionPolicy, DomainDefinition, EvaluationAdapter, EvaluationEpisode, ExecutionReceipt, Features, FeedbackEvent, Observation, StrategyPackage } from './types.js';

export interface SimulationOptions {
  applicationId?: string; scopeId?: string; seed?: number; opponentId?: string; sessionId?: string;
  knowledge?: Features; knowledgeStateMode?: 'frozen' | 'online_update'; decisionTimeoutMs?: number;
}
interface BaseState { index: number; revision: number; done: boolean; lastDecision?: string }
abstract class SimulationDomain<S extends BaseState> {
  abstract readonly id: string;
  readonly rulesVersion = '1';
  abstract readonly featureContract: string;
  readonly featureBuilderVersion = '1'; readonly knowledgeUpdaterVersion = '1';
  readonly continuationVersion = '1';
  protected readonly states = new Map<string, S>();
  protected readonly receipts = new Map<string, { commandDigest: string; receipt: ExecutionReceipt }>();
  protected readonly pending: FeedbackEvent[] = [];
  protected readonly random: () => number;
  protected readonly knowledge: Features;
  readonly applicationId: string; readonly scopeId: string; readonly sessionId: string;
  constructor(protected readonly options: SimulationOptions = {}) {
    invariant(options.seed === undefined || Number.isFinite(options.seed), 'CONFIG_INVALID', 'Simulation seed must be finite');
    invariant(options.decisionTimeoutMs === undefined || (Number.isFinite(options.decisionTimeoutMs) && options.decisionTimeoutMs > 0), 'CONFIG_INVALID', 'Decision timeout must be positive');
    invariant(options.knowledgeStateMode === undefined || ['frozen', 'online_update'].includes(options.knowledgeStateMode), 'CONFIG_INVALID', 'Unknown knowledge state mode');
    this.applicationId = options.applicationId ?? 'duelloop-demo'; this.scopeId = options.scopeId ?? 'default'; this.sessionId = options.sessionId ?? randomUUID();
    this.random = seededRandom(options.seed ?? 1); this.knowledge = structuredClone(options.knowledge ?? {});
  }
  protected observation(streamId: string, state: S, features: Features): Observation {
    const now = Date.now();
    return { applicationId: this.applicationId, domainId: this.id, strategyScopeId: this.scopeId,
      streamId, actorId: 'self', trajectoryId: `${this.sessionId}:${streamId}:${state.index}`, revision: String(state.revision),
      observedAt: now, deadline: now + (this.options.decisionTimeoutMs ?? 30_000), features, terminal: state.done };
  }
  protected current(observation: Observation): S {
    const state = this.states.get(observation.streamId);
    invariant(observation.applicationId === this.applicationId && observation.domainId === this.id && observation.strategyScopeId === this.scopeId && observation.actorId === 'self', 'ACCESS_DENIED', 'Observation belongs to a different application, domain, scope or actor');
    invariant(state && observation.trajectoryId === `${this.sessionId}:${observation.streamId}:${state.index}` && observation.revision === String(state.revision), 'STATE_STALE', 'Observation revision is no longer current');
    return state;
  }
  protected previous(command: ActionCommand): ExecutionReceipt | undefined {
    const prior = this.receipts.get(command.idempotencyKey);
    if (!prior) return undefined;
    invariant(prior.commandDigest === digest(command), 'CONFLICT', 'Idempotency key reused for a different command');
    return structuredClone(prior.receipt);
  }
  protected accept(command: ActionCommand): ExecutionReceipt {
    const receipt: ExecutionReceipt = { decisionId: command.decisionId, idempotencyKey: command.idempotencyKey,
      status: 'completed', timestamp: Date.now(), environmentActionId: `${this.id}:${command.idempotencyKey}` };
    this.receipts.set(command.idempotencyKey, { commandDigest: digest(command), receipt });
    return structuredClone(receipt);
  }
  protected validateCommand(command: ActionCommand, legal: CandidateAction[]): S {
    const state = this.current(command.observation);
    invariant(command.expectedStateRevision === String(state.revision) && command.action.revision === String(state.revision), 'STATE_STALE', 'Command revision is stale');
    invariant(Date.now() <= command.deadline, 'STATE_STALE', 'Command deadline expired');
    invariant(legal.some(a => digest(a) === digest(command.action)), 'CONFIG_INVALID', 'Command is not a legal candidate');
    return state;
  }
  async executionStatus(idempotencyKey: string): Promise<ExecutionReceipt> {
    return structuredClone(this.receipts.get(idempotencyKey)?.receipt ?? { decisionId: '', idempotencyKey, status: 'unknown', timestamp: Date.now() });
  }
  async feedback(): Promise<FeedbackEvent[]> { return this.pending.splice(0).map(e => structuredClone(e)); }
  async canActivate(scopeId: string): Promise<boolean> { return scopeId === this.scopeId && [...this.states.values()].every(s => s.done); }
  protected event(streamId: string, state: S, reward: number, settled = true, revision = 1): FeedbackEvent {
    const now = Date.now();
    return { feedbackId: `${this.applicationId}:${this.scopeId}:${this.sessionId}:${streamId}:${state.index}`, revision,
      eventTime: now, receivedAt: now, applicationId: this.applicationId, strategyScopeId: this.scopeId,
      trajectoryId: `${this.sessionId}:${streamId}:${state.index}`, ...(state.lastDecision ? { decisionId: state.lastDecision } : {}), metrics: { reward }, settled };
  }
}

interface KuhnState extends BaseState { cards: [number, number]; seat: number; history: string[]; committed: [number, number]; opponentCalls: number; opponentOpportunities: number }
export class KuhnPokerDomain extends SimulationDomain<KuhnState> implements DomainDefinition {
  readonly id = 'kuhn-poker'; readonly featureContract = 'kuhn-features-v1';
  readonly capabilities = { execution: true, idempotency: true, statusQuery: true, delayedFeedback: false, revisedFeedback: false, activationBoundary: 'trajectory' as const, evaluation: true };
  readonly features = {
    'self.card': { type: 'string' as const, required: true }, 'self.seat': { type: 'number' as const, required: true },
    'self.committedChips': { type: 'number' as const, required: true }, 'round.history': { type: 'string' as const, required: true },
    'round.pot': { type: 'number' as const, required: true }, 'opponent.observedCallRate': { type: 'number' as const, required: true },
    'opponent.callOpportunities': { type: 'number' as const, required: true },
  };
  readonly context: Features = {
    rules: 'Kuhn Poker: cards J<Q<K; two players each receive one private card without replacement. Each antes 1 chip. One betting round, fixed bet 1, no raises. Check-check reaches showdown; a bet permits call or fold. Higher card wins showdown. Net reward is pot won minus own contributions; folding loses own contributions.',
    visibility: 'Only own card and public actions are visible. Opponent card and remaining deck must never be inferred as known.',
    actions: { check: 'Commit 0; pass initiative', bet: 'Commit 1', call: 'Commit 1 and showdown', fold: 'Commit 0 and lose existing contribution' },
    continuation: 'Reference v1: bet with K, check with J/Q; call with K and fold J/Q when facing a bet. This reference is for local scoring; the evaluated strategy makes every actual player decision.',
    units: { reward: 'net chips per hand', 'round.pot': 'chips', 'self.committedChips': 'chips', 'opponent.observedCallRate': 'calls/opportunities; 0.5 prior when no observations' },
  };
  constructor(options: SimulationOptions = {}) {
    super(options);
    invariant(['calling', 'tight', 'random', 'adaptive'].includes(options.opponentId ?? 'calling'), 'CONFIG_INVALID', 'Unknown Kuhn opponent');
  }
  private legalKinds(state: KuhnState): string[] {
    if (state.done) return [];
    return state.history.at(-1) === 'bet' ? ['fold', 'call'] : ['check', 'bet'];
  }
  private nextActor(state: KuhnState): number { return state.history.length % 2; }
  private advance(state: KuhnState, action: string): void {
    const actor = this.nextActor(state); state.history.push(action);
    if (action === 'bet' || action === 'call') state.committed[actor as 0 | 1] += 1;
    state.revision++;
    state.done = action === 'fold' || action === 'call' || state.history.join(',') === 'check,check';
  }
  private opponent(state: KuhnState): void {
    while (!state.done && this.nextActor(state) !== state.seat) {
      const rank = state.cards[(1 - state.seat) as 0 | 1]; const facingBet = state.history.at(-1) === 'bet';
      const opponentId = this.options.opponentId ?? 'calling'; let action: string;
      if (facingBet) {
        const call = opponentId === 'calling' || rank === 2 || (opponentId === 'random' && this.random() < 0.5)
          || (opponentId === 'adaptive' && rank === 1 && state.opponentOpportunities > 2);
        action = call ? 'call' : 'fold'; state.opponentOpportunities++; if (call) state.opponentCalls++;
      } else action = rank === 2 || (opponentId === 'random' && this.random() < 0.5) ? 'bet' : 'check';
      this.advance(state, action);
    }
  }
  async observe(streamId: string): Promise<Observation> {
    let state = this.states.get(streamId);
    if (!state || state.done) {
      const cards = [0, 1, 2];
      for (let i = 2; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [cards[i], cards[j]] = [cards[j]!, cards[i]!]; }
      const index = (state?.index ?? 0) + 1;
      state = { index, revision: 0, done: false, cards: [cards[0]!, cards[1]!], seat: (index - 1) % 2, history: [], committed: [1, 1],
        opponentCalls: state?.opponentCalls ?? Number(this.knowledge['opponent.calls'] ?? 0),
        opponentOpportunities: state?.opponentOpportunities ?? Number(this.knowledge['opponent.callOpportunities'] ?? 0) };
      this.states.set(streamId, state); this.opponent(state);
    }
    const online = this.options.knowledgeStateMode !== 'frozen';
    const opportunities = online ? state.opponentOpportunities : Number(this.knowledge['opponent.callOpportunities'] ?? 0);
    const calls = online ? state.opponentCalls : Number(this.knowledge['opponent.calls'] ?? 0);
    return this.observation(streamId, state, { 'self.card': ['J', 'Q', 'K'][state.cards[state.seat as 0 | 1]]!, 'self.seat': state.seat,
      'self.committedChips': state.committed[state.seat as 0 | 1], 'round.history': state.history.join(','),
      'round.pot': state.committed[0] + state.committed[1], 'opponent.callOpportunities': opportunities,
      'opponent.observedCallRate': opportunities ? calls / opportunities : 0.5 });
  }
  async candidates(observation: Observation): Promise<CandidateAction[]> {
    return this.legalKinds(this.current(observation)).map(kind => ({ id: kind, kind, parameters: {}, revision: observation.revision }));
  }
  async execute(command: ActionCommand): Promise<ExecutionReceipt> {
    const previous = this.previous(command); if (previous) return previous;
    const state = this.validateCommand(command, await this.candidates(command.observation)); state.lastDecision = command.decisionId;
    this.advance(state, command.action.kind); this.opponent(state);
    if (state.done) {
      const folded = state.history.at(-1) === 'fold'; const lastActor = (state.history.length - 1) % 2;
      const winner = folded ? 1 - lastActor : (state.cards[0] > state.cards[1] ? 0 : 1);
      const reward = winner === state.seat ? state.committed[(1 - state.seat) as 0 | 1] : -state.committed[state.seat as 0 | 1];
      this.pending.push(this.event(command.observation.streamId, state, reward));
    }
    return this.accept(command);
  }
}

interface AuctionState extends BaseState { value: number; opponentBid: number; previousWinningBid: number; totalRevenue: number }
/** A continuous repeated resource market: each confirmed bid is an activation checkpoint, not a card-game round. */
export class AuctionDomain extends SimulationDomain<AuctionState> implements DomainDefinition {
  readonly id = 'resource-auction'; readonly featureContract = 'auction-features-v1';
  readonly capabilities = { execution: true, idempotency: true, statusQuery: true, delayedFeedback: true, revisedFeedback: true, activationBoundary: 'scope' as const, evaluation: true };
  readonly features = { 'self.value': { type: 'number' as const, required: true }, 'market.previousWinningBid': { type: 'number' as const, required: true }, 'market.checkpoint': { type: 'number' as const, required: true } };
  readonly context: Features = {
    rules: 'Continuous first-price resource auction. Each checkpoint one unit is available; own private value is known. Submit pass or an integer bid 1..3. Highest bid wins and pays own bid; ties lose. Net reward is own value minus paid bid if won, otherwise 0. Future auctions are separate rewards. Competitor bid is hidden.',
    continuation: 'Reference v1: later checkpoints bid max(0,min(3,value-1)), independently. A decision score concerns only the current checkpoint.',
    units: { 'self.value': 'credits per resource', 'market.previousWinningBid': 'credits', reward: 'net credits per checkpoint' },
  };
  private readonly delayed: { event: FeedbackEvent; due: number }[] = []; private feedbackPoll = 0;
  constructor(options: SimulationOptions = {}) {
    super(options); invariant(['fixed', 'random', 'adaptive'].includes(options.opponentId ?? 'fixed'), 'CONFIG_INVALID', 'Unknown auction opponent');
  }
  async observe(streamId: string): Promise<Observation> {
    let state = this.states.get(streamId);
    if (!state || state.done) {
      const previousWinningBid = state?.previousWinningBid ?? Number(this.knowledge['market.previousWinningBid'] ?? 1);
      const opponentId = this.options.opponentId ?? 'fixed';
      const opponentBid = opponentId === 'random' ? 1 + Math.floor(this.random() * 3) : opponentId === 'adaptive' ? Math.max(1, Math.min(3, previousWinningBid)) : 1;
      state = { index: (state?.index ?? 0) + 1, revision: 0, done: false, value: 1 + Math.floor(this.random() * 5), opponentBid,
        previousWinningBid, totalRevenue: state?.totalRevenue ?? 0 };
      this.states.set(streamId, state);
    }
    return this.observation(streamId, state, { 'self.value': state.value, 'market.previousWinningBid': this.options.knowledgeStateMode === 'frozen' ? Number(this.knowledge['market.previousWinningBid'] ?? 1) : state.previousWinningBid, 'market.checkpoint': state.index });
  }
  async candidates(observation: Observation): Promise<CandidateAction[]> {
    const state = this.current(observation); if (state.done) return [];
    return [0, 1, 2, 3].map(bid => ({ id: bid ? `bid-${bid}` : 'pass', kind: bid ? 'bid' : 'pass', parameters: { bid }, revision: observation.revision }));
  }
  async execute(command: ActionCommand): Promise<ExecutionReceipt> {
    const previous = this.previous(command); if (previous) return previous;
    const state = this.validateCommand(command, await this.candidates(command.observation));
    state.lastDecision = command.decisionId; const bid = Number(command.action.parameters.bid);
    const reward = bid > state.opponentBid ? state.value - bid : 0;
    state.previousWinningBid = Math.max(bid, state.opponentBid); state.totalRevenue += reward; state.done = true; state.revision++;
    this.pending.push(this.event(command.observation.streamId, state, 0, false, 1));
    this.delayed.push({ event: this.event(command.observation.streamId, state, reward, true, 2), due: this.feedbackPoll + 2 });
    return this.accept(command);
  }
  override async feedback(): Promise<FeedbackEvent[]> {
    this.feedbackPoll++;
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      if (this.delayed[i]!.due <= this.feedbackPoll) { const item = this.delayed.splice(i, 1)[0]!; this.pending.push({ ...item.event, receivedAt: Date.now() }); }
    }
    return super.feedback();
  }
}

function initialStrategy(domain: DomainDefinition): StrategyPackage {
  return { schemaVersion: '2.0', strategyId: `${domain.id}-initial`, version: 'v1',
    scope: { domain: domain.id, rulesVersion: domain.rulesVersion, featureContract: domain.featureContract }, stateProjection: Object.keys(domain.features),
    questions: [
      { id: 'gain', type: 'score', forEach: 'candidate', normalization: 'divide_by_max_level',
        instructions: 'Evaluate net reward of {{candidate.id}} from the visible state and rules. Include losses. Do not treat hidden opponent state as known.',
        semantics: { target: 'net_reward_including_losses', horizon: 'current_trajectory_end', continuation: 'domain reference continuation v1', overlap: 'exposure adds intentional risk aversion to gain, which already includes losses' },
        criteria: ['Visible evidence supports losing additional committed resources', 'Visible evidence supports a loss mostly of already committed resources', 'Visible evidence supports approximately balanced net gain and loss; uncertainty alone does not imply this grade', 'Visible evidence supports positive net reward from existing stakes', 'Visible evidence supports positive net reward including additional opponent contribution or substantial resource surplus'] },
      { id: 'exposure', type: 'score', forEach: 'candidate', normalization: 'divide_by_max_level',
        instructions: 'Evaluate risk of losing newly committed resources after {{candidate.id}} under the reference continuation. Exclude sunk resources.',
        semantics: { target: 'loss_of_newly_committed_resources', horizon: 'current_trajectory_end', continuation: 'domain reference continuation v1', overlap: 'intentional extra downside preference; not statistically independent of gain' },
        criteria: ['No additional commitment or rules guarantee no loss on it', 'Additional commitment is mainly supported by visible value or card strength', 'Evidence for preserving and losing new commitment is balanced', 'Visible weakness or opponent participation supports loss of new commitment', 'Rules or strong public evidence make loss of newly committed resources nearly certain'] },
    ], decision: { defaultWeights: { gain: 1, exposure: -0.3 }, branches: [], branchPolicy: 'first_match', aggregate: 'weighted_sum', selection: { mode: 'argmax', tieBreak: 'domain_priority' } },
    provenance: { researchRunId: 'bootstrap', snapshotId: 'bootstrap', hypothesis: 'Initial illustrative risk preference; every actual action requires a valid model response' } };
}
export function createKuhnStrategy(): StrategyPackage { return initialStrategy(new KuhnPokerDomain()); }
export function createAuctionStrategy(): StrategyPackage {
  const strategy = initialStrategy(new AuctionDomain());
  strategy.questions[0]!.criteria = ['Winning would pay more than own resource value', 'Expected outcome is near zero with avoidable overpayment exposure', 'Passing or losing yields zero net credits', 'Visible private value exceeds bid by one credit and public history supports winning', 'Visible private value exceeds bid by at least two credits and public history supports winning'];
  return strategy;
}

export type EvaluationSimulationOptions = Partial<DecisionPolicy>;
async function simulate(factory: (options: SimulationOptions) => DomainDefinition, input: Parameters<EvaluationAdapter['episode']>[0], timing: EvaluationSimulationOptions): Promise<EvaluationEpisode> {
  const maxDecisionMs = timing.maxDecisionMs ?? 5000; const reserve = timing.executionReserveMs ?? 25;
  invariant(Number.isFinite(maxDecisionMs) && maxDecisionMs > 0 && Number.isFinite(reserve) && reserve >= 0 && reserve < maxDecisionMs, 'CONFIG_INVALID', 'Invalid evaluation time budget');
  invariant(Number.isInteger(input.trajectories) && input.trajectories > 0, 'CONFIG_INVALID', 'Evaluation needs a positive integer trajectory count');
  const domain = factory({ applicationId: 'evaluation', scopeId: 'evaluation', seed: input.seed, opponentId: input.opponentId,
    knowledge: structuredClone(input.knowledge), knowledgeStateMode: input.knowledgeStateMode, decisionTimeoutMs: maxDecisionMs, sessionId: `evaluation:${input.seed}` });
  const strategy = compileStrategy(input.strategy, domain).strategy;
  const random = seededRandom(`${input.seed}:selection`);
  const result: EvaluationEpisode = { reward: 0, decisions: 0, decisionComputeLatenciesMs: [], modelCalls: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  const settled = new Set<string>();
  // Every call constructs independent domain/opponent/knowledge state, including paired baseline/candidate calls.
  while (settled.size < input.trajectories) {
    invariant(!input.signal.aborted, 'CANCELLED', 'Evaluation cancelled');
    const observation = await domain.observe('evaluation'); const candidates = await domain.candidates(observation);
    const started = Date.now();
    const request = buildQuestions(strategy, observation, candidates, domain); result.modelCalls++;
    const response = await withDeadline(observation.deadline - reserve, signal => input.model.score({ state: request.state, questions: request.questions, signal }), input.signal);
    invariant(response.model === input.model.id || input.model.kind === 'fixture', 'VERSION_INCOMPATIBLE', 'Evaluation model returned a different version');
    if (response.usage) {
      result.usage!.inputTokens! += response.usage.inputTokens ?? 0; result.usage!.outputTokens! += response.usage.outputTokens ?? 0;
      result.usage!.costUsd! += response.usage.costUsd ?? 0; if (response.usage.unknown) result.usage!.unknown = true;
    } else result.usage!.unknown = true;
    const action = evaluateAnswers(strategy, observation, candidates, response.answers, timing.randomSeed === undefined ? random : seededRandom(`${timing.randomSeed}:${observation.trajectoryId}:${observation.revision}`)).action;
    invariant(!input.signal.aborted, 'CANCELLED', 'Evaluation cancelled');
    result.decisions++; result.decisionComputeLatenciesMs.push(Date.now() - started);
    const decisionId = `eval:${input.seed}:${result.decisions}`;
    const receipt = await domain.execute!({ decisionId, idempotencyKey: decisionId, expectedStateRevision: observation.revision, observation, action, deadline: observation.deadline });
    invariant(receipt.status === 'completed', 'EXECUTION_UNKNOWN', 'Evaluation action did not complete');
    // This simulator's delayed feedback settles after two polls. Poll without starting another checkpoint.
    for (let poll = 0; poll < (domain.capabilities.delayedFeedback ? 2 : 1); poll++) {
      for (const feedback of await domain.feedback!()) if (feedback.settled && !settled.has(feedback.feedbackId)) {
        settled.add(feedback.feedbackId); result.reward += feedback.metrics.reward ?? 0;
      }
    }
    invariant(result.decisions <= input.trajectories * 3, 'VALIDATION_REJECTED', 'Simulator did not settle within its bounded trajectory length');
  }
  result.reward /= input.trajectories;
  return result;
}
function evaluationPolicy(timing: EvaluationSimulationOptions): DecisionPolicy {
  const policy = { maxDecisionMs: timing.maxDecisionMs ?? 5000, executionReserveMs: timing.executionReserveMs ?? 25,
    ...(timing.randomSeed === undefined ? {} : { randomSeed: timing.randomSeed }) };
  invariant(Number.isFinite(policy.maxDecisionMs) && policy.maxDecisionMs > 0 && Number.isFinite(policy.executionReserveMs) && policy.executionReserveMs >= 0 && policy.executionReserveMs < policy.maxDecisionMs, 'CONFIG_INVALID', 'Invalid evaluation time budget');
  invariant(policy.randomSeed === undefined || typeof policy.randomSeed === 'string', 'CONFIG_INVALID', 'Invalid evaluation random seed');
  return Object.freeze(policy);
}
export class KuhnEvaluationAdapter implements EvaluationAdapter {
  readonly id: string; readonly decisionPolicy: DecisionPolicy;
  readonly domainDependencies = evaluationDomainDependencies(new KuhnPokerDomain());
  constructor(timing: EvaluationSimulationOptions = {}) { this.decisionPolicy = evaluationPolicy(timing); this.id = `kuhn-evaluation-v2:${digest({ decisionPolicy: this.decisionPolicy, domainDependencies: this.domainDependencies })}`; }
  episode(input: Parameters<EvaluationAdapter['episode']>[0]): Promise<EvaluationEpisode> { return simulate(options => new KuhnPokerDomain(options), input, this.decisionPolicy); }
}
export class AuctionEvaluationAdapter implements EvaluationAdapter {
  readonly id: string; readonly decisionPolicy: DecisionPolicy;
  readonly domainDependencies = evaluationDomainDependencies(new AuctionDomain());
  constructor(timing: EvaluationSimulationOptions = {}) { this.decisionPolicy = evaluationPolicy(timing); this.id = `auction-evaluation-v2:${digest({ decisionPolicy: this.decisionPolicy, domainDependencies: this.domainDependencies })}`; }
  episode(input: Parameters<EvaluationAdapter['episode']>[0]): Promise<EvaluationEpisode> { return simulate(options => new AuctionDomain(options), input, this.decisionPolicy); }
}
function evaluationDomainDependencies(domain: DomainDefinition): EvaluationAdapter['domainDependencies'] {
  return Object.freeze({ rules: domain.rulesVersion, featureBuilder: domain.featureBuilderVersion,
    knowledgeUpdater: domain.knowledgeUpdaterVersion,
    continuationPolicy: domain.continuationVersion, contextDigest: digest(domain.context) });
}
