// Trusted application code: loaded only by commands that execute domain behavior.
// Replace the factory with your own DomainDefinition; only the public SDK is needed.
import { AuctionDomain, AuctionEvaluationAdapter } from 'duelloop';

export function createDomain({ applicationId, scopeId, options }) {
  return {
    domain: new AuctionDomain({ applicationId, scopeId, ...options }),
    evaluator: new AuctionEvaluationAdapter({ maxDecisionMs: 5000, executionReserveMs: 25 }),
  };
}
