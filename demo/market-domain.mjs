import { randomUUID } from 'node:crypto';
/**
 * This entire domain belongs to the consuming application. It imports only public
 * contract types and implements no DuelLoop internals. Replace Market methods
 * with your own observation feed, execution transport and reconciliation API.
 */
/** @typedef {import('duelloop').DomainDefinition} DomainDefinition */

class Market {
  tick = 0; current = null; receipts = new Map(); events = []; delayed = [];
  observe() {
    if (!this.current || this.current.complete) this.current = { tick: ++this.tick, value: 2 + (this.tick % 4), complete: false };
    return this.current;
  }
  execute(key, bid) {
    const state = this.current;
    const competitorBid = 1 + (state.tick % 2); // private environment state, never part of own observation
    state.complete = true;
    return bid > competitorBid ? state.value - bid : 0;
  }
}
/** @implements {DomainDefinition} */
export class MyMarketDomain {
  id = 'my-resource-market'; rulesVersion = '1'; featureContract = 'my-market-v1';
  featureBuilderVersion = '1'; knowledgeUpdaterVersion = '1'; continuationVersion = '1';
  capabilities = { execution: true, idempotency: true, statusQuery: true, delayedFeedback: true, revisedFeedback: true, activationBoundary: 'scope', evaluation: false };
  features = { value: { type: 'number', required: true }, checkpoint: { type: 'number', required: true } };
  context = { rules: 'First-price auction of one resource per checkpoint; private resource value is known. Bid 0, 1, 2 or 3. Higher bid wins; tied bid loses. Reward equals value minus bid if won, otherwise zero. Opponent bid is hidden.', continuation: 'Evaluate this checkpoint only; future independent checkpoints use the same fixed bid-below-value reference.', units: { value: 'credits', reward: 'credits per checkpoint' } };
  constructor(applicationId = 'sdk-demo-market') { this.sessionId = randomUUID(); this.applicationId = applicationId; this.market = new Market(); }
  async observe(streamId) {
    if (streamId !== 'market') throw new Error('This example environment has one stream named market');
    const state = this.market.observe(); const now = Date.now();
    return { applicationId: this.applicationId, domainId: this.id, strategyScopeId: 'market-policy', streamId, actorId: 'buyer', trajectoryId: `${this.sessionId}:checkpoint-${state.tick}`, revision: String(state.tick), observedAt: now, deadline: now + 30000, features: { value: state.value, checkpoint: state.tick } };
  }
  validate(observation) {
    if (observation.applicationId !== this.applicationId || observation.domainId !== this.id || observation.strategyScopeId !== 'market-policy' || observation.actorId !== 'buyer') throw new Error('Observation identity mismatch');
    if (observation.revision !== String(this.market.current?.tick) || this.market.current.complete) throw new Error('State is stale');
  }
  async candidates(observation) {
    this.validate(observation);
    return [0, 1, 2, 3].map(bid => ({ id: `bid-${bid}`, kind: 'bid', parameters: { bid }, revision: observation.revision }));
  }
  async execute(command) {
    const prior = this.market.receipts.get(command.idempotencyKey);
    if (prior) {
      if (prior.command !== JSON.stringify(command)) throw new Error('Idempotency conflict');
      return structuredClone(prior.receipt);
    }
    this.validate(command.observation);
    if (command.expectedStateRevision !== command.observation.revision || command.deadline < Date.now()) throw new Error('Stale command');
    if (!(await this.candidates(command.observation)).some(action => JSON.stringify(action) === JSON.stringify(command.action))) throw new Error('Illegal action');
    const reward = this.market.execute(command.idempotencyKey, command.action.parameters.bid); const now = Date.now();
    const event = { feedbackId: `market:${command.observation.trajectoryId}`, revision: 1, eventTime: now, receivedAt: now, applicationId: this.applicationId, strategyScopeId: 'market-policy', trajectoryId: command.observation.trajectoryId, decisionId: command.decisionId, metrics: { reward: 0 }, settled: false };
    this.market.events.push(event); this.market.delayed.push({ ...event, revision: 2, settled: true, metrics: { reward } });
    const receipt = { decisionId: command.decisionId, idempotencyKey: command.idempotencyKey, status: 'completed', timestamp: now, environmentActionId: `market:${command.idempotencyKey}` };
    this.market.receipts.set(command.idempotencyKey, { command: JSON.stringify(command), receipt }); return receipt;
  }
  async executionStatus(idempotencyKey) { return structuredClone(this.market.receipts.get(idempotencyKey)?.receipt ?? { decisionId: '', idempotencyKey, status: 'unknown', timestamp: Date.now() }); }
  async feedback() {
    const events = this.market.events.splice(0);
    this.market.events.push(...this.market.delayed.splice(0).map(event => ({ ...event, receivedAt: Date.now() })));
    return events;
  }
  async canActivate(scopeId) { return scopeId === 'market-policy' && (!this.market.current || this.market.current.complete); }
}
export function myMarketStrategy() {
  return {
    schemaVersion: '2.0', strategyId: 'my-market-risk-policy', version: 'v1',
    scope: { domain: 'my-resource-market', rulesVersion: '1', featureContract: 'my-market-v1' },
    stateProjection: ['value', 'checkpoint'],
    questions: [{ id: 'surplus', type: 'score', forEach: 'candidate', normalization: 'divide_by_max_level',
      semantics: { target: 'net_credits_from_current_auction', horizon: 'current_checkpoint', continuation: 'no later action within checkpoint', overlap: 'single net reward dimension includes overpayment losses' },
      instructions: 'Evaluate {{candidate.id}} from own resource value and public auction rules. Opponent bid is unknown; do not invent it.',
      criteria: ['Bid exceeds own value: winning loses credits', 'Zero surplus if won or a pass with zero reward', 'One credit surplus if won', 'At least two credits surplus if won with plausible winning bid', 'At least three credits surplus if won with plausible winning bid'] }],
    decision: { defaultWeights: { surplus: 1 }, branches: [], branchPolicy: 'first_match', aggregate: 'weighted_sum', selection: { mode: 'argmax', tieBreak: 'domain_priority' } },
    provenance: { researchRunId: 'bootstrap', snapshotId: 'bootstrap', hypothesis: 'Illustrative SDK integration only; no measured policy improvement claim' },
  };
}
