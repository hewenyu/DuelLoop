import { invariant } from './errors.js';
import { digest } from './utils.js';
import { validateScoreAnswer, validateStrategy } from './strategy.js';
import { decisionPolicyRuntimeVersion, modelBehaviorDigest } from './runtime.js';
import type { BehaviorDependencies, DecisionModel, EvaluationAdapter, EvaluationEpisode, EvaluationProtocol, Features, StrategyPackage, ValidationReport } from './types.js';

/** Validate the whole immutable experimental plan before research can begin. */
export function validateProtocol(input: unknown): EvaluationProtocol {
  invariant(input && typeof input === 'object', 'CONFIG_INVALID', 'Evaluation protocol must be an object');
  const p = input as EvaluationProtocol;
  invariant(p.version === '3.0' && typeof p.id === 'string' && !!p.id && typeof p.domainId === 'string' && !!p.domainId, 'CONFIG_INVALID', 'Invalid protocol identity');
  invariant(Array.isArray(p.seeds) && p.seeds.length > 0 && p.seeds.every(Number.isSafeInteger) && new Set(p.seeds).size === p.seeds.length, 'CONFIG_INVALID', 'Seeds must be distinct integers');
  invariant(Array.isArray(p.opponentIds) && p.opponentIds.length > 0 && p.opponentIds.every(x => typeof x === 'string' && !!x) && new Set(p.opponentIds).size === p.opponentIds.length, 'CONFIG_INVALID', 'Opponents must be distinct IDs');
  for (const key of ['trajectoriesPerSeed', 'minSamples', 'maxDevelopmentEvalRuns', 'maxFinalEvaluationsPerRun', 'maxHoldoutUses'] as const) invariant(Number.isSafeInteger(p[key]) && p[key] >= (key === 'maxDevelopmentEvalRuns' ? 0 : 1), 'CONFIG_INVALID', `Invalid ${key}`);
  invariant(p.minSamples >= 2 && p.maxFinalEvaluationsPerRun === 1, 'CONFIG_INVALID', 'At least two independent samples and exactly one final evaluation per run are required');
  invariant(['frozen', 'online_update'].includes(p.knowledgeStateMode) && p.initialKnowledge && typeof p.initialKnowledge === 'object' && !Array.isArray(p.initialKnowledge), 'CONFIG_INVALID', 'Invalid knowledge state');
  invariant(p.metric && ['maximize', 'minimize'].includes(p.metric.direction) && typeof p.metric.name === 'string' && !!p.metric.name && typeof p.metric.unit === 'string', 'CONFIG_INVALID', 'Invalid metric');
  for (const key of ['minimumImprovement', 'maxGroupRegression', 'maxP95DecisionComputeMs'] as const) invariant(Number.isFinite(p[key]) && p[key] >= 0, 'CONFIG_INVALID', `Invalid ${key}`);
  invariant(p.confidenceLevel > 0.5 && p.confidenceLevel < 1 && typeof p.holdoutId === 'string' && !!p.holdoutId, 'CONFIG_INVALID', 'Invalid confidence or holdout limits');
  invariant(!('maxFallbackRate' in p), 'CONFIG_INVALID', 'Fallback thresholds are not supported');
  invariant(!('maxP95LatencyMs' in p), 'CONFIG_INVALID', 'Use maxP95DecisionComputeMs; SDK end-to-end latency needs a separate runtime benchmark');
  digest(p);
  return structuredClone(p);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function validateEpisode(e: EvaluationEpisode): void {
  invariant(e && !('fallbacks' in e), 'VALIDATION_REJECTED', 'Legacy fallback experiment results are not accepted');
  invariant(e && Number.isFinite(e.reward), 'VALIDATION_REJECTED', 'Episode reward must be finite and settled');
  for (const key of ['decisions', 'modelCalls'] as const) invariant(Number.isSafeInteger(e[key]) && e[key] >= 0, 'VALIDATION_REJECTED', `Invalid episode ${key}`);
  invariant(Array.isArray(e.decisionComputeLatenciesMs) && e.decisionComputeLatenciesMs.length === e.decisions && e.decisionComputeLatenciesMs.every(x => Number.isFinite(x) && x >= 0), 'VALIDATION_REJECTED', 'Episode latency data are incomplete');
}
// Student-t two-sided interval, evaluated numerically; no normal approximation for tiny samples.
function logGamma(z: number): number {
  const c = [676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.984369578019572e-6,1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1; let x = 0.99999999999980993;
  for (let i = 0; i < c.length; i++) x += c[i]! / (z + i + 1);
  const t = z + c.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300; let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d; const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 3e-14) break;
  }
  return h;
}
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const f = Math.exp(logGamma(a+b)-logGamma(a)-logGamma(b)+a*Math.log(x)+b*Math.log1p(-x));
  return x < (a+1)/(a+b+2) ? f*betaFraction(a,b,x)/a : 1-f*betaFraction(b,a,1-x)/b;
}
function tCritical(confidence: number, degrees: number): number {
  const target = (1 + confidence) / 2;
  const cdf = (t: number) => 1 - 0.5 * incompleteBeta(degrees / (degrees + t*t), degrees/2, 0.5);
  let low = 0, high = 1;
  while (cdf(high) < target && high < 1e12) high *= 2;
  for (let i = 0; i < 80; i++) { const mid = (low+high)/2; if (cdf(mid) < target) low=mid; else high=mid; }
  return (low+high)/2;
}
function interval(values: number[], confidence: number): { meanDifference: number; lowerBound: number } {
  const meanDifference = values.reduce((a,b)=>a+b,0)/values.length;
  if (values.length < 2) return { meanDifference, lowerBound: -Number.MAX_VALUE };
  const variance = values.reduce((sum,v)=>sum+(v-meanDifference)**2,0)/(values.length-1);
  return { meanDifference, lowerBound: meanDifference-tCritical(confidence,values.length-1)*Math.sqrt(variance/values.length) };
}
export interface EvaluationEvidence {
  adapterId: string; protocolDigest: string; modelKind: 'real' | 'fixture';
  blocks: {seed: number; opponentId: string; baseline: EvaluationEpisode; candidate: EvaluationEpisode; difference: number}[];
  costs: { modelCalls: number; inputTokens: number; outputTokens: number; costUsd: number; usageUnknown: boolean };
}
export interface EvaluateCandidateOptions {
  candidate: StrategyPackage; baseline: StrategyPackage; protocol: EvaluationProtocol;
  adapter: EvaluationAdapter; model: DecisionModel; dependencies: BehaviorDependencies;
  baseReleaseDigest: string; stage: 'development' | 'final'; signal?: AbortSignal;
  onEvidence?: (evidence: EvaluationEvidence) => void;
}
/** Each seed is an independent paired block; actions within a block are never counted as samples. */
export async function evaluateCandidate(options: EvaluateCandidateOptions): Promise<ValidationReport> {
  const { candidate, baseline, adapter, model, dependencies, baseReleaseDigest, stage } = options;
  validateStrategy(candidate); validateStrategy(baseline);
  const protocol = validateProtocol(options.protocol);
  invariant(candidate.scope.domain === protocol.domainId && baseline.scope.domain === protocol.domainId, 'CONFIG_INVALID', 'Protocol and strategy domains differ');
  invariant(model.id === dependencies.model && model.kind === dependencies.modelKind && modelBehaviorDigest(model) === dependencies.modelBehaviorDigest, 'VERSION_INCOMPATIBLE', 'Evaluation model behavior does not match behavior dependencies');
  invariant(adapter.decisionPolicy && typeof adapter.decisionPolicy === 'object', 'VERSION_INCOMPATIBLE', 'Evaluation adapter must declare its actual decision policy');
  invariant(Number.isFinite(adapter.decisionPolicy.maxDecisionMs) && adapter.decisionPolicy.maxDecisionMs > 0 && Number.isFinite(adapter.decisionPolicy.executionReserveMs) && adapter.decisionPolicy.executionReserveMs >= 0 && adapter.decisionPolicy.executionReserveMs < adapter.decisionPolicy.maxDecisionMs && (adapter.decisionPolicy.randomSeed === undefined || typeof adapter.decisionPolicy.randomSeed === 'string'), 'VERSION_INCOMPATIBLE', 'Evaluation adapter decision policy is incomplete or invalid');
  invariant(decisionPolicyRuntimeVersion(adapter.decisionPolicy) === dependencies.runtime, 'VERSION_INCOMPATIBLE', 'Evaluation decision deadline, execution reserve or random seed differs from runtime binding');
  invariant(adapter.domainDependencies && typeof adapter.domainDependencies === 'object', 'VERSION_INCOMPATIBLE', 'Evaluation adapter must declare the domain behavior dependencies it actually simulates');
  const { model: _modelBinding, modelKind: _modelKind, modelBehaviorDigest: _modelBehavior, runtime: _runtimeBinding, ...domainBinding } = dependencies;
  invariant(digest(adapter.domainDependencies) === digest(domainBinding), 'VERSION_INCOMPATIBLE', 'Evaluation domain rules, features, knowledge updater, continuation or context differ from release binding');
  const signal = options.signal ?? new AbortController().signal;
  const evidence: EvaluationEvidence = { adapterId: adapter.id, protocolDigest: digest(protocol), modelKind: model.kind, blocks: [], costs: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, usageUnknown: false } };
  const groups: Record<string, { meanDifference: number; lowerBound: number }> = {};
  const byOpponent = new Map<string, number[]>();
  const paired: number[] = []; const latencies: number[] = [];
  let decisions = 0;
  for (const seed of protocol.seeds) {
    const block: number[] = [];
    for (const opponentId of protocol.opponentIds) {
      signal.throwIfAborted();
      const run = async (strategy: StrategyPackage): Promise<EvaluationEpisode> => {
        let knowledge: Features = structuredClone(protocol.initialKnowledge);
        if (protocol.knowledgeStateMode === 'frozen') knowledge = deepFreeze(knowledge);
        let calls = 0, completed = 0, pending = 0, modelFailed = false;
        let firstModelFailure: unknown;
        const checkedModel: DecisionModel = {
          id: model.id, kind: model.kind, behaviorIdentity: model.behaviorIdentity,
          async score(request) {
            if (modelFailed) throw firstModelFailure;
            calls++; pending++;
            const aborted = () => {
              if (!modelFailed) firstModelFailure = request.signal.reason;
              modelFailed = true;
            };
            request.signal.addEventListener('abort', aborted, { once: true });
            try {
              request.signal.throwIfAborted();
              const response = await model.score(request);
              request.signal.throwIfAborted();
              invariant(response && (response.model === model.id || model.kind === 'fixture'), 'VERSION_INCOMPATIBLE', 'Evaluation model returned a different version');
              invariant(response.answers && typeof response.answers === 'object' && !Array.isArray(response.answers) && Object.keys(response.answers).length === request.questions.length, 'MODEL_INVALID', 'Evaluation model answer set differs from requested questions');
              invariant(request.questions.length > 0, 'MODEL_INVALID', 'An empty question set cannot authorize a decision');
              for (const question of request.questions) validateScoreAnswer(response.answers[question.id], question.criteria.length);
              completed++;
              return response;
            } catch (error) { if (!modelFailed) firstModelFailure = error; modelFailed = true; throw error; }
            finally { pending--; request.signal.removeEventListener('abort', aborted); }
          },
        };
        const result = await adapter.episode({ strategy: structuredClone(strategy), model: checkedModel, seed, opponentId, trajectories: protocol.trajectoriesPerSeed, knowledge, knowledgeStateMode: protocol.knowledgeStateMode, signal });
        signal.throwIfAborted();
        if (modelFailed) throw firstModelFailure;
        invariant(pending === 0, 'VALIDATION_REJECTED', 'Episode contains an unfinished model decision');
        validateEpisode(result);
        // Fixtures may supply precomputed statistical summaries. Real experiments must account for every decision.
        invariant(model.kind === 'fixture' || (completed >= result.decisions && result.modelCalls === calls), 'VALIDATION_REJECTED', 'Every real experimental decision requires a completed model call and accurate call accounting');
        return result;
      };
      // Alternating order catches accidental ordering assumptions without sharing mutable state.
      let a: EvaluationEpisode, b: EvaluationEpisode;
      if (paired.length % 2) { b = await run(candidate); a = await run(baseline); }
      else { a = await run(baseline); b = await run(candidate); }
      const difference = (b.reward-a.reward)*(protocol.metric.direction === 'maximize' ? 1 : -1);
      evidence.blocks.push({seed,opponentId,baseline:structuredClone(a),candidate:structuredClone(b),difference});
      for (const item of [a,b]) {
        evidence.costs.modelCalls += item.modelCalls;
        evidence.costs.inputTokens += item.usage?.inputTokens ?? 0;
        evidence.costs.outputTokens += item.usage?.outputTokens ?? 0;
        evidence.costs.costUsd += item.usage?.costUsd ?? 0;
        if (item.modelCalls > 0 && (!item.usage || item.usage.unknown || item.usage.inputTokens === undefined || item.usage.outputTokens === undefined || item.usage.costUsd === undefined)) evidence.costs.usageUnknown=true;
      }
      block.push(difference);
      const group = byOpponent.get(opponentId) ?? []; group.push(difference); byOpponent.set(opponentId,group);
      decisions += b.decisions; latencies.push(...b.decisionComputeLatenciesMs);
    }
    paired.push(block.reduce((a,b)=>a+b,0)/block.length);
  }
  for (const [opponent, values] of byOpponent) groups[opponent] = interval(values, protocol.confidenceLevel);
  const overall = interval(paired, protocol.confidenceLevel);
  latencies.sort((a,b)=>a-b);
  const p95DecisionComputeMs = latencies.length ? latencies[Math.ceil(latencies.length*.95)-1]! : 0;
  const reasons: string[] = [];
  let failed = false;
  if (p95DecisionComputeMs > protocol.maxP95DecisionComputeMs) { failed = true; reasons.push('latency_limit_exceeded'); }
  if (Object.values(groups).some(g => g.meanDifference < -protocol.maxGroupRegression)) { failed = true; reasons.push('opponent_group_regression'); }
  if (overall.meanDifference < 0) { failed = true; reasons.push('negative_mean_improvement'); }
  let insufficient = paired.length < protocol.minSamples || decisions === 0;
  if (paired.length < protocol.minSamples) reasons.push('insufficient_independent_samples');
  if (!decisions) reasons.push('no_candidate_decisions');
  if (overall.lowerBound <= protocol.minimumImprovement) { insufficient = true; reasons.push('improvement_not_demonstrated'); }
  if (Object.values(groups).some(g=>g.lowerBound < -protocol.maxGroupRegression)) { insufficient = true; reasons.push('group_non_regression_not_demonstrated'); }
  options.onEvidence?.(structuredClone(evidence));
  return { evaluationAdapterId: adapter.id, candidateDigest: digest(candidate), baseReleaseDigest, protocolDigest: digest(protocol), dependencies: structuredClone(dependencies), status: failed ? 'failed' : insufficient ? 'inconclusive' : 'passed', reasons, modelKind: model.kind, stage, sampleCount: paired.length, ...overall, groups, p95DecisionComputeMs, createdAt: Date.now() };
}
