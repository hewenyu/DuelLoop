import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KuhnPokerDomain, AuctionDomain, createKuhnStrategy, createAuctionStrategy, KuhnEvaluationAdapter, AuctionEvaluationAdapter } from '../dist/domains.js';
import { runDomainConformance } from '../dist/conformance.js';

const cmd = (observation, action, decisionId = 'd') => ({ observation, action, decisionId, idempotencyKey: decisionId, expectedStateRevision: observation.revision, deadline: observation.deadline });
for (const [Domain, hidden] of [[KuhnPokerDomain, ['opponent.card', 'cards', 'deck']], [AuctionDomain, ['opponent.bid', 'opponentBid']]]) {
  test(`${Domain.name} satisfies sandbox domain conformance`, async () => {
    const report = await runDomainConformance(() => new Domain({ seed: 42 }), { forbiddenFeaturePaths: hidden });
    assert.equal(report.passed, true, JSON.stringify(report.checks));
    assert(report.checks.some(c => c.status === 'skipped' && c.name === 'forced-action'));
  });
}
test('Kuhn implements all terminal histories, legal actions, chip payoffs and alternating private seats', async () => {
  const terminalHistories = new Set(); const ranks = new Set(); const seats = new Set();
  for (let seed = 1; seed <= 80; seed++) {
    const domain = new KuhnPokerDomain({ seed, opponentId: 'random' });
    for (let hand = 0; hand < 4; hand++) {
      let obs = await domain.observe('s'); const trajectory = obs.trajectoryId; let completed = false;
      for (let turn = 0; turn < 2 && !completed; turn++) {
        ranks.add(obs.features['self.card']); seats.add(obs.features['self.seat']);
        const actions = await domain.candidates(obs); const history = obs.features['round.history'];
        assert.deepEqual(actions.map(a => a.id), history.endsWith('bet') ? ['fold', 'call'] : ['check', 'bet']);
        const action = actions[(seed + hand + turn) % 2];
        await domain.execute(cmd(obs, action, `${seed}:${hand}:${turn}`));
        const events = await domain.feedback();
        if (events.length) {
          assert.equal(events.length, 1); assert.equal(events[0].trajectoryId, trajectory);
          assert([-2, -1, 1, 2].includes(events[0].metrics.reward));
          if (action.kind === 'fold') assert.equal(events[0].metrics.reward, -1);
          terminalHistories.add(`${history},${action.kind}`); completed = true;
        } else { obs = await domain.observe('s'); assert.equal(obs.trajectoryId, trajectory); }
      }
      assert(completed, 'Kuhn hand must settle within two player decisions');
    }
  }
  assert.equal(ranks.size, 3); assert.equal(seats.size, 2); assert(terminalHistories.size >= 5);
});
test('Kuhn duplicate execution never duplicates feedback and cannot mutate a new trajectory', async () => {
  const domain = new KuhnPokerDomain(); let obs = await domain.observe('s');
  const action = (await domain.candidates(obs)).find(a => a.kind === 'bet'); const command = cmd(obs, action);
  await domain.execute(command); assert.equal((await domain.feedback()).length, 1);
  await domain.observe('s'); await domain.execute(command); assert.equal((await domain.feedback()).length, 0);
  await assert.rejects(domain.execute({ ...command, idempotencyKey: 'new', decisionId: 'new' }), { code: 'STATE_STALE' });
});
test('Auction settles delayed feedback by revision and activates only after confirmed scope checkpoint', async () => {
  const domain = new AuctionDomain({ seed: 5 }); const a = await domain.observe('a'); const b = await domain.observe('b');
  assert.equal(await domain.canActivate('default'), false);
  const action = (await domain.candidates(a)).find(x => x.id === 'bid-2');
  await domain.execute(cmd(a, action, 'a')); assert.equal(await domain.canActivate('default'), false);
  const first = await domain.feedback(); assert.equal(first[0].settled, false); assert.equal(first[0].revision, 1);
  const final = await domain.feedback(); assert.equal(final[0].feedbackId, first[0].feedbackId); assert.equal(final[0].revision, 2);
  assert.equal(final[0].metrics.reward, a.features['self.value'] - 2);
  await domain.execute(cmd(b, await domain.fallback(b, 'test'), 'b')); assert.equal(await domain.canActivate('default'), true);
});
test('Cross application and actor observations are rejected', async () => {
  const domain = new KuhnPokerDomain({ applicationId: 'a' }); const observation = await domain.observe('s');
  await assert.rejects(domain.candidates({ ...observation, applicationId: 'b' }), { code: 'ACCESS_DENIED' });
  await assert.rejects(domain.candidates({ ...observation, actorId: 'opponent' }), { code: 'ACCESS_DENIED' });
});
const model = { id: 'explicit-test-fixture', kind: 'fixture', async score({ questions }) {
  return { model: this.id, answers: Object.fromEntries(questions.map(q => [q.id, { score: q.dimensionId === 'gain' ? (['bet', 'call', 'bid-2'].includes(q.actionId) ? 4 : 2) : 1, confidence: 1, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } }])) };
} };
for (const [Adapter, strategy, opponent] of [[KuhnEvaluationAdapter, createKuhnStrategy, 'calling'], [AuctionEvaluationAdapter, createAuctionStrategy, 'adaptive']]) {
  test(`${Adapter.name} uses model and resets paired knowledge/opponent state`, async () => {
    const adapter = new Adapter(); const knowledge = { 'opponent.calls': 1, 'opponent.callOpportunities': 3 };
    const input = { strategy: strategy(), model, seed: 100, opponentId: opponent, trajectories: 20, knowledge, knowledgeStateMode: 'online_update', signal: new AbortController().signal };
    const a = await adapter.episode(input); const b = await adapter.episode(input);
    assert.equal(a.reward, b.reward); assert.equal(a.decisions, b.decisions); assert.equal(a.fallbacks, 0);
    assert.equal(a.modelCalls, a.decisions); assert(a.modelCalls >= 20); assert.deepEqual(knowledge, input.knowledge);
    const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(adapter.episode({ ...input, signal: cancelled.signal }), { code: 'CANCELLED' });
  });
}

test('Frozen knowledge remains fixed while online knowledge incorporates observed calls', async () => {
  for (const mode of ['frozen', 'online_update']) {
    const domain = new KuhnPokerDomain({ seed: 9, opponentId: 'calling', knowledgeStateMode: mode, knowledge: { 'opponent.calls': 0, 'opponent.callOpportunities': 0 } });
    const first = await domain.observe('s');
    await domain.execute(cmd(first, (await domain.candidates(first)).find(action => action.kind === 'bet'), 'learn'));
    const next = await domain.observe('s');
    assert.equal(next.features['opponent.callOpportunities'], mode === 'frozen' ? 0 : 1);
    assert.equal(next.features['opponent.observedCallRate'], mode === 'frozen' ? 0.5 : 1);
  }
});
test('Evaluation includes low confidence fallback in measured decisions and rejects empty experiments', async () => {
  const input = { strategy: createAuctionStrategy(), model: { ...model, async score() { throw new Error('simulated timeout'); } }, seed: 2, opponentId: 'fixed', trajectories: 5, knowledge: {}, knowledgeStateMode: 'frozen', signal: new AbortController().signal };
  const result = await new AuctionEvaluationAdapter().episode(input);
  assert.equal(result.fallbacks, result.decisions); assert.equal(result.modelCalls, 5); assert(Number.isFinite(result.reward));
  await assert.rejects(new AuctionEvaluationAdapter().episode({ ...input, trajectories: 0 }), { code: 'CONFIG_INVALID' });
});
test('Fresh simulator sessions cannot reuse persistent trajectory identities', async () => {
  const first = await new KuhnPokerDomain({ seed: 1 }).observe('s');
  const restarted = await new KuhnPokerDomain({ seed: 1 }).observe('s');
  assert.notEqual(first.trajectoryId, restarted.trajectoryId);
  assert.deepEqual(first.features, restarted.features);
  const fixedA = await new AuctionDomain({ seed: 1, sessionId: 'reproducible-test' }).observe('s');
  const fixedB = await new AuctionDomain({ seed: 1, sessionId: 'reproducible-test' }).observe('s');
  assert.equal(fixedA.trajectoryId, fixedB.trajectoryId);
});
test('Evaluation does not turn a real model version mismatch into an apparently valid fallback result', async () => {
  const wrongModel = { ...model, id: 'pinned-v1', kind: 'real', async score(request) { return { ...(await model.score(request)), model: 'unvalidated-v2' }; } };
  await assert.rejects(new AuctionEvaluationAdapter().episode({ strategy: createAuctionStrategy(), model: wrongModel, seed: 2, opponentId: 'fixed', trajectories: 1, knowledge: {}, knowledgeStateMode: 'frozen', signal: new AbortController().signal }), { code: 'VERSION_INCOMPATIBLE' });
});
test('built-in evaluation rejects incompatible and malformed strategies before calling the model', async () => {
 let calls = 0;
 const countingModel = { ...model, async score(request) { calls++; return model.score(request); } };
 const input = { model: countingModel, seed: 2, opponentId: 'fixed', trajectories: 1, knowledge: {}, knowledgeStateMode: 'frozen', signal: new AbortController().signal };
 const incompatible = createAuctionStrategy(); incompatible.scope.featureContract = 'unsupported';
 await assert.rejects(new AuctionEvaluationAdapter().episode({ ...input, strategy: incompatible }), { code: 'VERSION_INCOMPATIBLE' });
 const malformed = createAuctionStrategy(); malformed.decision.defaultWeights = { gain: 1 };
 await assert.rejects(new AuctionEvaluationAdapter().episode({ ...input, strategy: malformed }), { code: 'STRATEGY_INVALID' });
 assert.equal(calls, 0);
});
test('evaluation policy is copied and frozen rather than changed by caller mutation', () => {
 const timing = { maxDecisionMs: 100, executionReserveMs: 5, randomSeed: 'fixed' };
 const adapter = new AuctionEvaluationAdapter(timing); const id = adapter.id;
 timing.maxDecisionMs = 999;
 assert.equal(adapter.decisionPolicy.maxDecisionMs, 100); assert.equal(adapter.id, id);
 assert.throws(() => { adapter.decisionPolicy.maxDecisionMs = 5000; }, TypeError);
});
test('seeded softmax evaluation uses the same per-decision sampling policy as the runtime', async () => {
 const { DuelLoop, SqliteStore, FixtureDecisionModel } = await import('../dist/index.js');
 const randomSeed = 'shared-policy'; const seed = 16; const trajectories = 20;
 const observed = [];
 const decisionModel = new FixtureDecisionModel('uniform-test-fixture', (question, state) => {
  if (question.id === 'gain:pass') observed.push(structuredClone(state.features));
  return { score: 0, confidence: 1, probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), i === 0 ? 1 : 0])) };
 });
 const strategy = createAuctionStrategy(); strategy.decision.selection = { mode: 'softmax_sample', tieBreak: 'domain_priority', temperature: 1 };
 const adapter = new AuctionEvaluationAdapter({ randomSeed });
 const evaluated = await adapter.episode({ strategy, model: decisionModel, seed, opponentId: 'adaptive', trajectories, knowledge: {}, knowledgeStateMode: 'online_update', signal: new AbortController().signal });
 const evaluationFeatures = observed.splice(0);
 const domain = new AuctionDomain({ applicationId: 'runtime-parity', scopeId: 'policy', seed, opponentId: 'adaptive', sessionId: `evaluation:${seed}`, knowledgeStateMode: 'online_update' });
 const store = new SqliteStore(); const runtime = new DuelLoop({ applicationId: 'runtime-parity', domain, model: decisionModel, store, executionOwner: 'framework', randomSeed });
 try {
  runtime.bootstrap(strategy, 'policy');
  for (let i = 0; i < trajectories; i++) await runtime.step('evaluation');
  await runtime.submitFeedback();
  const feedback = store.getArtifact(store.snapshot('policy', Date.now())).feedback.filter(f => f.settled);
  assert.equal(feedback.length, trajectories);
  assert.equal(feedback.reduce((sum, f) => sum + f.metrics.reward, 0) / trajectories, evaluated.reward);
  assert.deepEqual(observed, evaluationFeatures, 'Action-dependent visible history must match');
 } finally { await runtime.close(); store.close(); }
});
