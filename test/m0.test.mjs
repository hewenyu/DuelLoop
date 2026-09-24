import test from 'node:test';
import assert from 'node:assert/strict';
import { episode, makeFixtureModel, usageAccumulator, addUsage } from '../scripts/m0.mjs';

const options = { hands: 4, timeoutMs: 5000, maxCalls: 100 };
const knownUsage = { inputTokens: 7, outputTokens: 3, costUsd: 0.125, unknown: false };

test('M0 usage preserves partial cost subtotals independently from token completeness', () => {
  const total = usageAccumulator();
  addUsage(total, { inputTokens: 7, outputTokens: 3, costUnknown: true, knownCostUsd: 0.125 });
  addUsage(total, { costUsd: 0.25 });
  assert.deepEqual(total, { inputTokens: 7, outputTokens: 3, knownCostUsd: 0.375, unknownTokenUsage: true, unknownCost: true });
  const priced = usageAccumulator();
  addUsage(priced, { costUsd: 0, unknown: true });
  assert.equal(priced.unknownTokenUsage, true);
  assert.equal(priced.unknownCost, false);
  addUsage(priced, { inputTokens: 1, outputTokens: 1, costUsd: Infinity });
  assert.equal(priced.unknownCost, true);
  assert.equal(priced.knownCostUsd, 0);
});

async function runLowConfidenceResponse(path, usage) {
  const model = makeFixtureModel();
  if (path === 'jev_choice') {
    const original = model.choice.bind(model);
    model.choice = async input => ({ ...await original(input), confidence: 0, usage });
  } else {
    const original = model.score.bind(model);
    model.score = async input => {
      const response = await original(input);
      return { ...response, usage, answers: Object.fromEntries(Object.entries(response.answers).map(([id, answer]) => [id, { ...answer, confidence: 0 }])) };
    };
  }
  return episode(path, 11, 'calling', options, model, { used: 0 });
}

for (const path of ['jev_choice', 'jev_score']) {
  test(`M0 ${path}: zero confidence remains a model action and preserves response usage exactly once`, async () => {
    const block = await runLowConfidenceResponse(path, knownUsage);
    assert.equal(block.status, 'completed');
    assert.ok(block.modelCalls > 0);
    assert.equal(block.stoppedDecisions, 0);
    assert.equal(block.decisions, block.modelCalls);
    assert.deepEqual(block.usage, {
      inputTokens: block.modelCalls * 7,
      outputTokens: block.modelCalls * 3,
      knownCostUsd: block.modelCalls * 0.125,
      unknownTokenUsage: false,
      unknownCost: false,
    });
  });
}

test('M0 Score: missing price does not make recorded token counts unknown', async () => {
  const block = await runLowConfidenceResponse('jev_score', { inputTokens: 7, outputTokens: 3 });
  assert.equal(block.status, 'completed');
  assert.equal(block.usage.unknownTokenUsage, false);
  assert.equal(block.usage.unknownCost, true);
  assert.equal(block.usage.inputTokens, block.modelCalls * 7);
});

test('M0: missing response usage remains unknown', async () => {
  const block = await runLowConfidenceResponse('jev_score', undefined);
  assert.equal(block.status, 'completed');
  assert.equal(block.usage.unknownTokenUsage, true);
  assert.equal(block.usage.unknownCost, true);
});

test('M0: transport failure stops before any action and marks usage unknown', async () => {
  const model = makeFixtureModel();
  model.score = async () => { throw Object.assign(new Error('Offline transport failure'), { code: 'MODEL_UNAVAILABLE' }); };
  const block = await episode('jev_score', 11, 'calling', options, model, { used: 0 });
  assert.equal(block.status, 'incomplete');
  assert.equal(block.failureCode, 'MODEL_UNAVAILABLE');
  assert.equal(block.modelCalls, 1);
  assert.equal(block.decisions, 0);
  assert.equal(block.hands, 0);
  assert.equal(block.stoppedDecisions, 1);
  assert.deepEqual(block.usage, { inputTokens: 0, outputTokens: 0, knownCostUsd: 0, unknownTokenUsage: true, unknownCost: true });
});

for (const path of ['jev_choice', 'jev_score']) {
  test(`M0 ${path}: adapter rejection accounts known error usage once`, async () => {
    const model = makeFixtureModel();
    model[path === 'jev_choice' ? 'choice' : 'score'] = async () => {
      throw Object.assign(new Error('Malformed answer with known usage'), { code: 'MODEL_INVALID', context: { usage: knownUsage } });
    };
    const block = await episode(path, 11, 'calling', options, model, { used: 0 });
    assert.equal(block.status, 'incomplete');
    assert.equal(block.failureCode, 'MODEL_INVALID');
    assert.equal(block.modelCalls, 1);
    assert.equal(block.decisions, 0);
    assert.equal(block.stoppedDecisions, 1);
    assert.deepEqual(block.usage, { inputTokens: 7 * block.modelCalls, outputTokens: 3 * block.modelCalls, knownCostUsd: 0.125 * block.modelCalls, unknownTokenUsage: false, unknownCost: false });
  });
}

for (const path of ['jev_choice', 'jev_score']) {
  test(`M0 ${path}: changed model version stops and preserves known usage`, async () => {
    const model = makeFixtureModel();
    const method = path === 'jev_choice' ? 'choice' : 'score';
    const original = model[method].bind(model);
    model[method] = async input => ({ ...await original(input), model: 'unexpected-version', usage: knownUsage });
    const block = await episode(path, 11, 'calling', options, model, { used: 0 });
    assert.equal(block.status, 'incomplete');
    assert.equal(block.failureCode, 'VERSION_INCOMPATIBLE');
    assert.equal(block.decisions, 0);
    assert.equal(block.modelCalls, 1);
    assert.equal(block.usage.inputTokens, 7);
    assert.equal(block.usage.unknownTokenUsage, false);
  });
}
