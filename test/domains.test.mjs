import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KuhnPokerDomain, AuctionDomain, createKuhnStrategy, createAuctionStrategy, KuhnEvaluationAdapter, AuctionEvaluationAdapter } from '../dist/domains.js';
import { runDomainConformance } from '../dist/conformance.js';

const cmd = (observation, action, decisionId = 'd') => ({ observation, action, decisionId, idempotencyKey: decisionId, expectedStateRevision: observation.revision, deadline: observation.deadline });
for (const [Domain, hidden] of [[KuhnPokerDomain, ['opponent.card', 'cards', 'deck']], [AuctionDomain, ['opponent.bid', 'opponentBid']]]) {
  test(`${Domain.name} satisfies sandbox domain conformance`, async () => {
    const report = await runDomainConformance(() => new Domain({ seed: 42 }), { forbiddenFeaturePaths: hidden });
    assert.equal(report.passed, true, JSON.stringify(report.checks));
    assert(report.checks.some(c => c.status === 'skipped' && c.name === 'single-candidate'));
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
  await domain.execute(cmd(b, (await domain.candidates(b))[0], 'b')); assert.equal(await domain.canActivate('default'), true);
});
test('Cross application and actor observations are rejected', async () => {
  const domain = new KuhnPokerDomain({ applicationId: 'a' }); const observation = await domain.observe('s');
  await assert.rejects(domain.candidates({ ...observation, applicationId: 'b' }), { code: 'ACCESS_DENIED' });
  await assert.rejects(domain.candidates({ ...observation, actorId: 'opponent' }), { code: 'ACCESS_DENIED' });
});
const model = { id: 'explicit-test-fixture', kind: 'fixture', behaviorIdentity:{adapterVersion:'domain-test-1',deploymentVersion:'fixture-1',protocolVersion:'score-1',configurationDigest:'fixture'}, async score({ questions }) {
  return { model: this.id, answers: Object.fromEntries(questions.map(q => [q.id, { score: q.dimensionId === 'gain' ? (['bet', 'call', 'bid-2'].includes(q.actionId) ? 4 : 2) : 1, confidence: 1, probabilities: { '0': 0, '1': 0, '2': 0, '3': 0, '4': 1 } }])) };
} };
for (const [Adapter, strategy, opponent] of [[KuhnEvaluationAdapter, createKuhnStrategy, 'calling'], [AuctionEvaluationAdapter, createAuctionStrategy, 'adaptive']]) {
  test(`${Adapter.name} uses model and resets paired knowledge/opponent state`, async () => {
    const adapter = new Adapter(); const knowledge = { 'opponent.calls': 1, 'opponent.callOpportunities': 3 };
    const input = { strategy: strategy(), model, seed: 100, opponentId: opponent, trajectories: 20, knowledge, knowledgeStateMode: 'online_update', signal: new AbortController().signal };
    const a = await adapter.episode(input); const b = await adapter.episode(input);
    assert.equal(a.reward, b.reward); assert.equal(a.decisions, b.decisions);
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
test('Evaluation accepts valid zero-confidence model decisions without replacing actions', async (t) => {
  const actions = [];
  const execute = AuctionDomain.prototype.execute;
  t.mock.method(AuctionDomain.prototype, 'execute', function(command) { actions.push(command.action.id); return execute.call(this, command); });
  const decisionModel = { ...model, async score(request) {
    const response = await model.score(request);
    for (const answer of Object.values(response.answers)) answer.confidence = 0;
    return response;
  } };
  const result = await new AuctionEvaluationAdapter().episode({ strategy: createAuctionStrategy(), model: decisionModel, seed: 2, opponentId: 'fixed', trajectories: 5, knowledge: {}, knowledgeStateMode: 'frozen', signal: new AbortController().signal });
  assert.equal(result.modelCalls, 5); assert.equal(result.decisions, 5);
  assert.deepEqual(actions, Array(5).fill('bid-2'));
});
test('Evaluation stops before execution on model error, timeout or missing answers', async (t) => {
  for (const [name, score] of [
    ['error', async () => { throw new Error('model unavailable'); }],
    ['timeout', async () => new Promise(() => {})],
    ['missing', async () => ({ model: model.id, answers: {} })],
  ]) await t.test(name, async (subtest) => {
    let executions = 0;
    subtest.mock.method(AuctionDomain.prototype, 'execute', async () => { executions++; throw new Error('Must never execute'); });
    const input = { strategy: createAuctionStrategy(), model: { ...model, score }, seed: 2, opponentId: 'fixed', trajectories: 5, knowledge: {}, knowledgeStateMode: 'frozen', signal: new AbortController().signal };
    await assert.rejects(new AuctionEvaluationAdapter({ maxDecisionMs: 60, executionReserveMs: 5 }).episode(input));
    assert.equal(executions, 0);
    await assert.rejects(new AuctionEvaluationAdapter().episode({ ...input, trajectories: 0 }), { code: 'CONFIG_INVALID' });
  });
});
test('Evaluation requests a model answer even when the domain has one legal candidate', async (t) => {
  const candidates = AuctionDomain.prototype.candidates;
  t.mock.method(AuctionDomain.prototype, 'candidates', async function(observation) { return (await candidates.call(this, observation)).filter(action => action.id === 'bid-2'); });
  let calls = 0;
  const decisionModel = { ...model, async score(request) { calls++; assert(request.questions.every(question => question.actionId === 'bid-2')); return model.score(request); } };
  const result = await new AuctionEvaluationAdapter().episode({ strategy: createAuctionStrategy(), model: decisionModel, seed: 2, opponentId: 'fixed', trajectories: 3, knowledge: {}, knowledgeStateMode: 'frozen', signal: new AbortController().signal });
  assert.equal(calls, 3); assert.equal(result.decisions, 3);
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
test('Evaluation stops on a real model version mismatch', async () => {
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

async function simulateUsage(usages) {
  let calls = 0;
  const decisionModel = { ...model, async score(request) { return { ...(await model.score(request)), usage: usages[calls++] }; } };
  const result = await new AuctionEvaluationAdapter().episode({ strategy: createAuctionStrategy(), model: decisionModel, seed: 2, opponentId: 'fixed', trajectories: usages.length, knowledge: {}, knowledgeStateMode: 'frozen', signal: new AbortController().signal });
  assert.equal(calls, usages.length); assert.equal(result.modelCalls, usages.length);
  return result.usage;
}

test('official Jev-shaped token usage keeps dollar costs unknown through complete simulated trajectories', async () => {
  const usage = await simulateUsage(Array.from({ length: 10 }, () => ({ inputTokens: 10, outputTokens: 5 })));
  assert.equal(usage.inputTokens, 100); assert.equal(usage.outputTokens, 50);
  assert.equal(usage.unknown, false, 'Known token counts do not become unknown when billing data are missing');
  assert.equal(usage.costUnknown, true); assert.equal(usage.knownCostUsd, 0);
  assert.equal(Object.hasOwn(usage, 'costUsd'), false, 'Missing dollar billing data must not become a known zero cost');
});

test('simulator preserves only the known dollar subtotal when priced and unpriced calls are mixed', async () => {
  const usage = await simulateUsage([
    { inputTokens: 10, outputTokens: 5, costUsd: 1.25 },
    { inputTokens: 10, outputTokens: 5 },
    { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    { inputTokens: 10, outputTokens: 5, knownCostUsd: 0.5, costUnknown: true },
  ]);
  assert.equal(usage.inputTokens, 40); assert.equal(usage.outputTokens, 20); assert.equal(usage.unknown, false);
  assert.equal(usage.knownCostUsd, 1.75); assert.equal(usage.costUnknown, true); assert.equal(Object.hasOwn(usage, 'costUsd'), false);
});

test('explicit zero-dollar prices are known, independently of missing token counts', async () => {
  const known = await simulateUsage(Array.from({ length: 3 }, () => ({ inputTokens: 10, outputTokens: 5, costUsd: 0 })));
  assert.equal(known.costUsd, 0); assert.equal(known.knownCostUsd, 0); assert.equal(known.costUnknown, false); assert.equal(known.unknown, false);
  const tokensMissing = await simulateUsage([{ costUsd: 0 }, { costUsd: 0.25 }]);
  assert.equal(tokensMissing.unknown, true); assert.equal(tokensMissing.costUnknown, false); assert.equal(tokensMissing.costUsd, 0.25);
});

test('invalid provider dollar values stay unknown instead of contaminating costs or replacing decisions', async () => {
  for (const costUsd of [NaN, Infinity, -1, '0', null]) {
    const usage = await simulateUsage([{ inputTokens: 10, outputTokens: 5, costUsd }]);
    assert.equal(usage.inputTokens, 10); assert.equal(usage.outputTokens, 5); assert.equal(usage.unknown, false);
    assert.equal(usage.knownCostUsd, 0); assert.equal(usage.costUnknown, true); assert.equal(Object.hasOwn(usage, 'costUsd'), false);
  }
});


test('invalid or overflowing token counts remain incomplete without discarding independently known dollar costs', async () => {
  for (const inputTokens of [0.5, Number.MAX_SAFE_INTEGER + 1, NaN, -1]) {
    const usage = await simulateUsage([{ inputTokens, outputTokens: 5, costUsd: 0.25 }]);
    assert.equal(usage.unknown, true); assert.equal(usage.inputTokens, 0); assert.equal(usage.outputTokens, 5);
    assert.equal(usage.costUnknown, false); assert.equal(usage.costUsd, 0.25); assert.equal(usage.knownCostUsd, 0.25);
  }
  const overflow = await simulateUsage([{ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 5, costUsd: 0.25 }, { inputTokens: 1, outputTokens: 5, costUsd: 0.25 }]);
  assert.equal(overflow.unknown, true); assert.equal(overflow.inputTokens, Number.MAX_SAFE_INTEGER); assert.equal(overflow.outputTokens, 10);
  assert.equal(overflow.costUnknown, false); assert.equal(overflow.costUsd, 0.5);
});
