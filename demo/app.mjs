import { DuelLoop, SqliteStore, FixtureDecisionModel, KuhnPokerDomain, createKuhnStrategy } from 'duelloop';
import { MyMarketDomain, myMarketStrategy } from './market-domain.mjs';

// Explicit local fixture: zero network calls, zero model-performance claims.
// A real application injects new JevDecisionModel({ model: ..., apiKey: ... }).
const model = new FixtureDecisionModel('demo-visible-state-fixture', (question, state) => {
  const action = state.candidates.find(action => action.id === question.actionId);
  const features = state.features; let score;
  if ('value' in features) {
    const surplus = features.value - action.parameters.bid;
    score = action.parameters.bid === 0 ? 1 : Math.max(0, Math.min(4, surplus + 1));
  } else {
    const strong = features['self.card'] === 'K'; const commits = ['bet', 'call'].includes(action.kind);
    score = question.dimensionId === 'gain' ? (strong === commits ? 4 : 1) : (commits && !strong ? 4 : 0);
  }
  return { score, confidence: 1, probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === score ? 1 : 0])) };
});

async function run({ domain, strategy, streamId, applicationId, scopeId, steps }) {
  const store = new SqliteStore(':memory:');
  const app = new DuelLoop({ domain, model, store, mode: 'offline', executionOwner: 'framework', applicationId });
  try {
    await app.bootstrap(strategy, scopeId);
    for (let index = 0; index < steps; index++) {
      const result = await app.step(streamId);
      console.log(JSON.stringify({ application: applicationId, index, result }));
    }
    // Delayed/revised feedback belongs to the application's asynchronous input feed.
    for (let poll = 0; poll < 2; poll++) for (const event of await domain.feedback()) await app.submitFeedback(event);
    console.log(JSON.stringify({ application: applicationId, status: app.status() }));
  } finally { await app.close(); store.close(); }
}
await run({ domain: new KuhnPokerDomain({ applicationId: 'sdk-demo-kuhn', scopeId: 'poker', seed: 7 }), strategy: createKuhnStrategy(), streamId: 'table-1', applicationId: 'sdk-demo-kuhn', scopeId: 'poker', steps: 6 });
await run({ domain: new MyMarketDomain(), strategy: myMarketStrategy(), streamId: 'market', applicationId: 'sdk-demo-market', scopeId: 'market-policy', steps: 6 });
