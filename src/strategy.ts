import { invariant, DuelLoopError } from './errors.js';
import { canonicalize, digest, getFeature, secureRandom } from './utils.js';
import type { CandidateAction, Condition, DomainDefinition, Features, Observation, ScoreAnswer, ScoreQuestion, StrategyPackage } from './types.js';

export const STRATEGY_LIMITS = Object.freeze({ dimensions: 16, branches: 64, conditionDepth: 12, conditionNodes: 256, questions: 512, contextBytes: 131072 });
function object(value: unknown, fields: string[], path: string): asserts value is Record<string, any> {
  invariant(!!value && typeof value === 'object' && !Array.isArray(value), 'STRATEGY_INVALID', `${path} must be an object`);
  for (const key of Object.keys(value)) invariant(fields.includes(key), 'STRATEGY_INVALID', `${path}: unknown field ${key}`);
}
function string(value: unknown, path: string): asserts value is string { invariant(typeof value === 'string' && value.length > 0 && value.length <= 10000, 'STRATEGY_INVALID', `${path} must be a nonempty string`); }
function finite(value: unknown, path: string): asserts value is number { invariant(typeof value === 'number' && Number.isFinite(value), 'STRATEGY_INVALID', `${path} must be finite`); }
export function validateStrategy(input: unknown, domain?: DomainDefinition): StrategyPackage {
  canonicalize(input);
  object(input, ['schemaVersion','strategyId','version','parentVersion','scope','stateProjection','questions','decision','exitConditions','fallback','provenance'], 'strategy');
  invariant(input.schemaVersion === '1.0', 'VERSION_INCOMPATIBLE', 'Unsupported strategy schema');
  for (const name of ['strategyId','version']) string(input[name], name);
  if (input.parentVersion !== undefined) string(input.parentVersion, 'parentVersion');
  object(input.scope, ['domain','rulesVersion','featureContract'], 'scope');
  for (const name of ['domain','rulesVersion','featureContract']) string(input.scope[name], `scope.${name}`);
  if (domain) invariant(input.scope.domain === domain.id && input.scope.rulesVersion === domain.rulesVersion && input.scope.featureContract === domain.featureContract, 'VERSION_INCOMPATIBLE', 'Strategy/domain contract mismatch');
  invariant(Array.isArray(input.stateProjection) && new Set(input.stateProjection).size === input.stateProjection.length, 'STRATEGY_INVALID', 'stateProjection must contain unique features');
  for (const key of input.stateProjection) { string(key, 'feature'); if (domain) invariant(Object.hasOwn(domain.features, key), 'STRATEGY_INVALID', `Unknown feature ${key}`); }
  invariant(Array.isArray(input.questions) && input.questions.length > 0 && input.questions.length <= STRATEGY_LIMITS.dimensions, 'STRATEGY_INVALID', 'Invalid dimension count');
  const ids = new Set<string>();
  for (const q of input.questions) {
    object(q, ['id','type','forEach','instructions','criteria','normalization','semantics'], 'question');
    string(q.id, 'question.id'); invariant(/^[a-zA-Z0-9_-]+$/.test(q.id) && !ids.has(q.id), 'STRATEGY_INVALID', 'Duplicate or invalid question ID'); ids.add(q.id);
    invariant(q.type === 'score' && q.forEach === 'candidate' && q.normalization === 'divide_by_max_level', 'STRATEGY_INVALID', 'Only per-candidate normalized Score dimensions are supported');
    string(q.instructions, 'instructions');
    invariant(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10, 'STRATEGY_INVALID', 'Score requires 2–10 levels');
    for (const level of q.criteria) string(level, 'criterion');
    object(q.semantics, ['target','horizon','continuation','overlap'], 'semantics');
    for (const key of ['target','horizon','continuation','overlap']) string(q.semantics[key], key);
  }
  object(input.decision, ['defaultWeights','branches','branchPolicy','aggregate','selection','minRequiredConfidence'], 'decision');
  const d = input.decision;
  const weights = (w: unknown) => { object(w, [...ids], 'weights'); invariant(Object.keys(w).length === ids.size, 'STRATEGY_INVALID', 'Weights must cover every dimension'); for (const id of ids) finite(w[id], `weight.${id}`); };
  weights(d.defaultWeights);
  invariant(d.branchPolicy === 'first_match' && d.aggregate === 'weighted_sum', 'STRATEGY_INVALID', 'Unsupported combination mode');
  finite(d.minRequiredConfidence, 'minRequiredConfidence'); invariant(d.minRequiredConfidence >= 0 && d.minRequiredConfidence <= 1, 'STRATEGY_INVALID', 'Confidence threshold outside [0,1]');
  object(d.selection, ['mode','tieBreak','temperature'], 'selection');
  invariant(['argmax','softmax_sample'].includes(d.selection.mode) && d.selection.tieBreak === 'domain_priority', 'STRATEGY_INVALID', 'Unsupported selection mode');
  if (d.selection.mode === 'softmax_sample') { finite(d.selection.temperature, 'temperature'); invariant(d.selection.temperature >= 1e-6 && d.selection.temperature <= 1e6, 'STRATEGY_INVALID', 'Temperature must be in [1e-6,1e6]'); }
  else invariant(d.selection.temperature === undefined, 'STRATEGY_INVALID', 'argmax does not accept temperature');
  let conditionNodes = 0;
  const condition = (c: unknown, depth = 0): void => {
    invariant(depth <= STRATEGY_LIMITS.conditionDepth && ++conditionNodes <= STRATEGY_LIMITS.conditionNodes, 'STRATEGY_INVALID', 'Condition complexity limit exceeded');
    invariant(!!c && typeof c === 'object' && !Array.isArray(c), 'STRATEGY_INVALID', 'Invalid condition');
    const r = c as Record<string, any>;
    for (const op of ['all','any','not']) if (Object.hasOwn(r, op)) {
      object(r, [op], 'condition');
      if (op === 'not') condition(r[op], depth + 1);
      else { invariant(Array.isArray(r[op]) && r[op].length > 0, 'STRATEGY_INVALID', 'Condition group must be nonempty'); for (const x of r[op]) condition(x, depth + 1); }
      return;
    }
    object(r, ['feature','op','value'], 'condition'); string(r.feature, 'condition.feature');
    invariant(['eq','gt','gte','lt','lte','in'].includes(r.op) && Object.hasOwn(r,'value'), 'STRATEGY_INVALID', 'Invalid condition operator');
    if (domain) {
      invariant(r.feature === 'observation.isStale' || Object.hasOwn(domain.features,r.feature), 'STRATEGY_INVALID', `Unknown condition feature ${r.feature}`);
      const kind = r.feature === 'observation.isStale' ? 'boolean' : domain.features[r.feature]!.type;
      if (['gt','gte','lt','lte'].includes(r.op)) invariant(kind === 'number' && typeof r.value === 'number', 'STRATEGY_INVALID', 'Ordered comparisons require numeric features and values');
      if (r.op === 'eq' && r.value !== null) invariant(typeof r.value === kind, 'STRATEGY_INVALID', 'Comparison value type mismatch');
      if (r.op === 'in' && Array.isArray(r.value)) invariant(r.value.every((v: unknown) => v === null || typeof v === kind), 'STRATEGY_INVALID', 'Membership value type mismatch');
    }
    if (r.op === 'in') invariant(Array.isArray(r.value), 'STRATEGY_INVALID', 'in requires an array');
    if (['gt','gte','lt','lte'].includes(r.op)) finite(r.value,'comparison value');
  };
  invariant(Array.isArray(d.branches) && d.branches.length <= STRATEGY_LIMITS.branches, 'STRATEGY_INVALID', 'Too many branches');
  const branches = new Set<string>();
  for (const b of d.branches) { object(b, ['id','when','weights'], 'branch'); string(b.id, 'branch.id'); invariant(!branches.has(b.id), 'STRATEGY_INVALID', 'Duplicate branch'); branches.add(b.id); condition(b.when); weights(b.weights); }
  invariant(Array.isArray(input.exitConditions), 'STRATEGY_INVALID', 'exitConditions required'); for (const c of input.exitConditions) condition(c);
  object(input.fallback, ['mode'], 'fallback'); invariant(input.fallback.mode === 'domain_baseline', 'STRATEGY_INVALID', 'Unsupported fallback');
  object(input.provenance, ['researchRunId','snapshotId','hypothesis'], 'provenance'); for (const k of ['researchRunId','snapshotId','hypothesis']) string(input.provenance[k], k);
  return structuredClone(input) as StrategyPackage;
}
export function compileStrategy(input: unknown, domain: DomainDefinition) {
  const strategy = validateStrategy(input,domain); return { strategy, digest: digest(strategy) };
}
export function matchCondition(condition: Condition, features: Features): boolean | null {
  if ('all' in condition) { const a = condition.all.map(c => matchCondition(c, features)); return a.includes(false) ? false : a.includes(null) ? null : true; }
  if ('any' in condition) { const a = condition.any.map(c => matchCondition(c, features)); return a.includes(true) ? true : a.includes(null) ? null : false; }
  if ('not' in condition) { const a = matchCondition(condition.not, features); return a === null ? null : !a; }
  const value = getFeature(features, condition.feature);
  if (value === undefined || value === null) return null;
  switch (condition.op) {
    case 'eq': return canonicalize(value) === canonicalize(condition.value);
    case 'in': return (condition.value as unknown[]).some(x => canonicalize(x) === canonicalize(value));
    case 'gt': return typeof value === 'number' && value > (condition.value as number);
    case 'gte': return typeof value === 'number' && value >= (condition.value as number);
    case 'lt': return typeof value === 'number' && value < (condition.value as number);
    case 'lte': return typeof value === 'number' && value <= (condition.value as number);
  }
}
export function buildQuestions(strategy: StrategyPackage, observation: Observation, candidates: CandidateAction[], domain: DomainDefinition) {
  invariant(candidates.length * strategy.questions.length <= STRATEGY_LIMITS.questions, 'STRATEGY_INVALID', 'Expanded question budget exceeded');
  const features: Features = {};
  for (const key of strategy.stateProjection) {
    const value = getFeature(observation.features,key); const spec = domain.features[key];
    invariant(spec, 'VERSION_INCOMPATIBLE', `Missing feature contract ${key}`);
    if (value === undefined || value === null) { invariant(!spec.required, 'MODEL_INVALID', `Missing required feature ${key}`); features[key] = null; }
    else { invariant(typeof value === spec.type, 'MODEL_INVALID', `Invalid feature type ${key}`); features[key] = value as Features[string]; }
  }
  const questions: ScoreQuestion[] = candidates.flatMap(a => strategy.questions.map(q => ({
    id: `${q.id}:${a.id}`, actionId: a.id, dimensionId: q.id,
    instructions: q.instructions.replaceAll('{{candidate.id}}', a.id) + '\nDimension semantics: ' + canonicalize(q.semantics), criteria: q.criteria,
  })));
  const state: Features = { context: domain.context, features, candidates: candidates.map(a => ({ id: a.id, kind: a.kind, parameters: a.parameters })), unknownPolicy: 'Null means unknown. Never invent hidden facts; judge using visible evidence and the reference continuation policy.' };
  invariant(Buffer.byteLength(canonicalize({state,questions})) <= STRATEGY_LIMITS.contextBytes, 'STRATEGY_INVALID', 'Context budget exceeded');
  return { state, questions, questionDigest: digest({state,questions}) };
}
export function evaluateAnswers(strategy: StrategyPackage, observation: Observation, candidates: CandidateAction[], answers: Record<string, ScoreAnswer>, random = secureRandom, evaluatedAt = Date.now()) {
  invariant(candidates.length > 0 && new Set(candidates.map(a => a.id)).size === candidates.length, 'MODEL_INVALID', 'Candidates must have unique IDs');
  invariant(Number.isFinite(evaluatedAt), 'CONFIG_INVALID', 'Evaluation time must be finite');
  const features = { ...observation.features, 'observation.isStale': observation.deadline <= evaluatedAt };
  invariant(!strategy.exitConditions.some(c => matchCondition(c,features) === true), 'MODEL_INVALID', 'Strategy exit condition matched');
  const branch = strategy.decision.branches.find(b => matchCondition(b.when,features) === true);
  const weights = branch?.weights ?? strategy.decision.defaultWeights;
  const utilities: Record<string, number> = Object.create(null);
  for (const candidate of candidates) {
    let utility = 0;
    for (const q of strategy.questions) {
      const a = answers[`${q.id}:${candidate.id}`]; const top = q.criteria.length - 1;
      invariant(a && Number.isFinite(a.score) && a.score >= 0 && a.score <= top && Number.isFinite(a.confidence) && a.confidence >= strategy.decision.minRequiredConfidence && a.confidence <= 1, 'MODEL_INVALID', 'Missing, invalid or low-confidence Score answer', {questionId:`${q.id}:${candidate.id}`});
      invariant(a.probabilities && Object.keys(a.probabilities).length === top + 1, 'MODEL_INVALID', 'Invalid answer probability levels');
      let sum = 0;
      for (let i = 0; i <= top; i++) { const p = a.probabilities[String(i)]; invariant(p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1, 'MODEL_INVALID', 'Invalid answer probabilities'); sum += p; }
      invariant(Math.abs(sum-1) <= 1e-3, 'MODEL_INVALID', 'Answer probabilities do not sum to one');
      utility += weights[q.id]! * a.score / top;
    }
    invariant(Number.isFinite(utility), 'MODEL_INVALID', 'Nonfinite utility'); utilities[candidate.id] = utility;
  }
  const probabilities: Record<string, number> = Object.create(null);
  const max = Math.max(...Object.values(utilities)); let selected = candidates[0]!;
  if (strategy.decision.selection.mode === 'argmax') {
    selected = candidates.find(a => utilities[a.id] === max)!;
    for (const a of candidates) probabilities[a.id] = a.id === selected.id ? 1 : 0;
  } else {
    const temp = strategy.decision.selection.temperature!;
    invariant(Number.isFinite(temp) && temp >= 1e-6 && temp <= 1e6, 'MODEL_INVALID', 'Invalid sampling temperature');
    let total = 0;
    for (const a of candidates) { probabilities[a.id] = Math.exp((utilities[a.id]! - max)/temp); total += probabilities[a.id]!; }
    invariant(total > 0 && Number.isFinite(total), 'MODEL_INVALID', 'Invalid probability normalization');
    const draw = random(); invariant(Number.isFinite(draw) && draw >= 0 && draw < 1, 'MODEL_INVALID', 'Random source must return [0,1)');
    let cumulative = 0; selected = candidates[candidates.length-1]!;
    for (const a of candidates) probabilities[a.id] = probabilities[a.id]! / total;
    for (const a of candidates) { cumulative += probabilities[a.id]!; if (draw < cumulative) { selected = a; break; } }
  }
  return { action: selected, utilities, probabilities, ...(branch ? { branchId: branch.id } : {}) };
}
export function diffStrategies(before: StrategyPackage, after: StrategyPackage) {
  const questionChanged = digest({questions:before.questions,projection:before.stateProjection}) !== digest({questions:after.questions,projection:after.stateProjection});
  return { questionChanged, requiredChecks: questionChanged ? ['structure','new_question_fixtures','real_model','independent_evaluation'] : ['structure','behavior','independent_evaluation'], beforeDigest:digest(before), afterDigest:digest(after) };
}
