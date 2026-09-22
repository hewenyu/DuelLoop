import test from 'node:test';
import assert from 'node:assert/strict';
import { episode, makeFixtureModel } from '../scripts/m0.mjs';

const options = { hands: 4, timeoutMs: 5000, maxCalls: 100 };
const knownUsage = { inputTokens: 7, outputTokens: 3, costUsd: 0.125, unknown: false };

async function runRejectedResponse(path, usage) {
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
  test(`M0 ${path}: low confidence fallback preserves known response usage exactly once`, async () => {
    const block = await runRejectedResponse(path, knownUsage);
    assert.equal(block.status, 'completed');
    assert.ok(block.modelCalls > 0);
    assert.equal(block.fallbacks, block.modelCalls);
    assert.equal(block.fallbackReasons.MODEL_INVALID, block.modelCalls);
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
  const block = await runRejectedResponse('jev_score', { inputTokens: 7, outputTokens: 3 });
  assert.equal(block.status, 'completed');
  assert.equal(block.usage.unknownTokenUsage, false);
  assert.equal(block.usage.unknownCost, true);
  assert.equal(block.usage.inputTokens, block.modelCalls * 7);
});

test('M0: missing response usage remains unknown after local rejection', async () => {
  const block = await runRejectedResponse('jev_score', undefined);
  assert.equal(block.status, 'completed');
  assert.equal(block.usage.unknownTokenUsage, true);
  assert.equal(block.usage.unknownCost, true);
});

test('M0: transport failure without a response marks usage unknown and falls back', async () => {
  const model = makeFixtureModel();
  model.score = async () => { throw Object.assign(new Error('Offline transport failure'), { code: 'MODEL_UNAVAILABLE' }); };
  const block = await episode('jev_score', 11, 'calling', options, model, { used: 0 });
  assert.equal(block.status, 'completed');
  assert.ok(block.modelCalls > 0);
  assert.equal(block.fallbacks, block.modelCalls);
  assert.equal(block.fallbackReasons.MODEL_UNAVAILABLE, block.modelCalls);
  assert.deepEqual(block.usage, { inputTokens: 0, outputTokens: 0, knownCostUsd: 0, unknownTokenUsage: true, unknownCost: true });
});

for (const path of ['jev_choice', 'jev_score']) {
  test(`M0 ${path}: adapter rejection accounts known error usage once`, async () => {
    const model = makeFixtureModel();
    model[path === 'jev_choice' ? 'choice' : 'score'] = async () => {
      throw Object.assign(new Error('Malformed answer with known usage'), { code: 'MODEL_INVALID', context: { usage: knownUsage } });
    };
    const block = await episode(path, 11, 'calling', options, model, { used: 0 });
    assert.equal(block.status, 'completed');
    assert.ok(block.modelCalls > 0);
    assert.equal(block.fallbacks, block.modelCalls);
    assert.deepEqual(block.usage, { inputTokens: 7 * block.modelCalls, outputTokens: 3 * block.modelCalls, knownCostUsd: 0.125 * block.modelCalls, unknownTokenUsage: false, unknownCost: false });
  });
}
