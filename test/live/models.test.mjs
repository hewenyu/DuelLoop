import test from 'node:test';
import assert from 'node:assert/strict';
import { JevDecisionModel, PiResearchProvider } from '../../dist/adapters.js';

// Explicit opt-in prevents paid network work during ordinary CI. A skipped test is not an acceptance result.
const enabled = process.env.DUELLOOP_LIVE === '1';
const jevEnv = process.env.DUELLOOP_JEV_KEY_ENV ?? 'TYPESAFE_API_KEY';
test('LIVE: real Jev Score and Choice transport smoke (not M0 quality/performance acceptance)', {
  skip: !enabled || !process.env[jevEnv] ? 'Not executed: set DUELLOOP_LIVE=1 and a Jev credential' : false,
  timeout: 60000,
}, async () => {
  const model = new JevDecisionModel({ model: process.env.DUELLOOP_JEV_MODEL ?? 'jev-latest', apiKeyEnv: jevEnv, timeoutMs: 20000 });
  const state = { value: 3 };
  const result = await model.score({ state, questions: [{ id: 'size', actionId: 'inspect', dimensionId: 'size',
    instructions: 'Classify value from the visible state.', criteria: ['Value is below zero', 'Value is zero through nine', 'Value is at least ten'] }], signal: AbortSignal.timeout(25000) });
  assert.ok(Number.isFinite(result.answers.size.score));
  assert.ok(result.model.length > 0); assert.ok(result.usage.inputTokens > 0);
  const choice = await model.choice({ state, instructions: 'Choose the category containing value.', candidates: { small: 'value < 10', large: 'value >= 10' }, signal: AbortSignal.timeout(25000) });
  assert.ok(['small', 'large'].includes(choice.actionId));
});

const piEnv = process.env.DUELLOOP_PI_KEY_ENV;
test('LIVE: real pi session with a controlled tool (not R2 autonomous strategy improvement acceptance)', {
  skip: !enabled || !process.env.DUELLOOP_PI_PROVIDER || !process.env.DUELLOOP_PI_MODEL || !piEnv || !process.env[piEnv]
    ? 'Not executed: set DUELLOOP_LIVE=1, DUELLOOP_PI_PROVIDER, DUELLOOP_PI_MODEL, DUELLOOP_PI_KEY_ENV and credential' : false,
  timeout: 120000,
}, async () => {
  const provider = new PiResearchProvider({ provider: process.env.DUELLOOP_PI_PROVIDER, model: process.env.DUELLOOP_PI_MODEL,
    apiKeyEnv: piEnv, maxTurns: 4 });
  let calls = 0;
  try {
    const result = await provider.run({ role: 'researcher', prompt: 'Call query_experience once, then return exactly {"status":"no_change","reason":"smoke test"}.',
      tools: [{ name: 'query_experience', description: 'Read the synthetic smoke test evidence.', schema: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => { calls++; return { evidence: [], purpose: 'transport smoke only' }; } }],
      signal: AbortSignal.timeout(110000), maxTokens: 4096, sessionId: 'live-smoke' });
    assert.ok(calls > 0); assert.equal(result.output.status, 'no_change');
    assert.ok(result.usage.inputTokens > 0);
  } finally { await provider.dispose(); }
});
