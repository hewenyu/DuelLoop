import type { ModelUsage } from './types.js';

export function emptyModelUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, unknown: false, costUsd: 0, knownCostUsd: 0, costUnknown: false };
}

const validTokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nonnegativeFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Aggregate token completeness independently from dollar-cost completeness. */
export function accumulateModelUsage(total: ModelUsage, usage: ModelUsage | undefined, hasCalls = true): void {
  if (!hasCalls && usage === undefined) return;
  for (const key of ['inputTokens', 'outputTokens'] as const) {
    const value = usage?.[key];
    const next = (total[key] ?? 0) + (validTokenCount(value) ? value : 0);
    if (validTokenCount(next)) total[key] = next;
    if (!validTokenCount(value) || !validTokenCount(next)) total.unknown = true;
  }
  if (usage?.unknown) total.unknown = true;

  const completeCost = usage?.costUsd;
  const knownCost = usage?.knownCostUsd;
  const complete = nonnegativeFinite(completeCost) && !usage?.costUnknown
    && (knownCost === undefined || nonnegativeFinite(knownCost) && knownCost === completeCost);
  const contribution = nonnegativeFinite(knownCost) ? knownCost : nonnegativeFinite(completeCost) ? completeCost : 0;
  const nextCost = (total.knownCostUsd ?? total.costUsd ?? 0) + contribution;
  if (nonnegativeFinite(nextCost)) total.knownCostUsd = nextCost;
  if (!complete || !nonnegativeFinite(nextCost)) total.costUnknown = true;
  if (total.costUnknown) delete total.costUsd;
  else total.costUsd = total.knownCostUsd ?? 0;
}

/** Normalize one provider result without converting missing billing data into a zero total. */
export function normalizeModelUsage(usage: ModelUsage | undefined): ModelUsage {
  const normalized = emptyModelUsage();
  accumulateModelUsage(normalized, usage);
  return normalized;
}
