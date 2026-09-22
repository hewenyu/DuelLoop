import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { invariant, DuelLoopError } from './errors.js';
import { jsonValue } from './utils.js';
import type { Features, ExecutionMode } from './types.js';
import type { ResearchBudget } from './research.js';

export interface PiRoleConfiguration { provider: string; model: string; apiKeyEnv: string; baseURL?: string; maxTurns: number }
export interface DuelLoopConfiguration {
  schemaVersion: '1.0'; applicationId: string; scopeId: string; database: string; strategy: string;
  storage?: { maxDatabaseBytes?: number; maxArtifactBytes?: number };
  domain: { kind: 'kuhn' | 'auction'; seed: number; opponentId: string; knowledgeStateMode: 'frozen' | 'online_update'; initialKnowledge: Features }
    | { kind: 'module'; path: string; exportName: string; options: Features };
  decisionModel: { kind: 'fixture'; id: string } | { kind: 'jev'; model: string; apiKeyEnv: string; timeoutMs: number; baseURL?: string };
  runtime: { mode: ExecutionMode; executionOwner: 'framework' | 'host'; streamIds: string[]; maxSteps: number; intervalMs: number; maxDecisionMs: number; executionReserveMs: number };
  activationMode: 'candidate_only' | 'automatic_after_validation' | 'explicit';
  evaluation: { developmentProtocol: string; finalProtocol: string; timeoutMs: number; maxModelCalls: number };
  research: { mode: 'off' } | { mode: 'single' | 'team'; maxRounds: number; budget: ResearchBudget;
    trigger?: { settledTrajectories: number; cooldownMs: number; pollIntervalMs: number };
    roles: { researcher: PiRoleConfiguration; adversary?: PiRoleConfiguration; integrator?: PiRoleConfiguration } };
}
function object(value: unknown, allowed: string[], path: string): asserts value is Record<string, any> {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'CONFIG_INVALID', `${path} must be an object`);
  for (const key of Object.keys(value)) invariant(allowed.includes(key), 'CONFIG_INVALID', `${path} has an unknown field`, { field: key });
}
function string(value: unknown, path: string): asserts value is string {
  invariant(typeof value === 'string' && value.trim().length > 0 && value.length <= 10000, 'CONFIG_INVALID', `${path} must be a nonempty string`);
}
function integer(value: unknown, min: number, path: string): asserts value is number {
  invariant(Number.isSafeInteger(value) && (value as number) >= min, 'CONFIG_INVALID', `${path} must be an integer >= ${min}`);
}
function environment(value: unknown, path: string): void {
  string(value, path); invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(value), 'CONFIG_INVALID', `${path} must name an environment variable`);
}
function url(value: unknown, path: string): void {
  if (value === undefined) return;
  string(value, path);
  try { const parsed = new URL(value); invariant(['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 'CONFIG_INVALID', `${path} must be an HTTP(S) URL without credentials`); }
  catch { throw new DuelLoopError('CONFIG_INVALID', `${path} must be an HTTP(S) URL without credentials`); }
}
function role(value: unknown, path: string): void {
  object(value, ['provider', 'model', 'apiKeyEnv', 'baseURL', 'maxTurns'], path);
  string(value.provider, `${path}.provider`); string(value.model, `${path}.model`); environment(value.apiKeyEnv, `${path}.apiKeyEnv`);
  integer(value.maxTurns, 1, `${path}.maxTurns`); url(value.baseURL, `${path}.baseURL`);
}
/** Closed configuration schema. Paths are resolved by loadConfiguration, never by the current working directory. */
export function validateConfiguration(input: unknown): DuelLoopConfiguration {
  jsonValue(input);
  object(input, ['schemaVersion','applicationId','scopeId','database','strategy','storage','domain','decisionModel','runtime','activationMode','evaluation','research'], 'config');
  invariant(input.schemaVersion === '1.0', 'VERSION_INCOMPATIBLE', 'Unsupported configuration schema');
  for (const key of ['applicationId','scopeId','database','strategy']) string(input[key], key);
  invariant(input.database !== ':memory:', 'CONFIG_INVALID', 'CLI applications require a persistent database path');
  if(input.storage!==undefined){
    object(input.storage,['maxDatabaseBytes','maxArtifactBytes'],'storage');
    for(const key of ['maxDatabaseBytes','maxArtifactBytes'])if(input.storage[key]!==undefined)integer(input.storage[key],1,`storage.${key}`);
  }
  const d = input.domain;
  invariant(d && ['kuhn','auction','module'].includes(d.kind), 'CONFIG_INVALID', 'Unsupported domain kind');
  if (d.kind === 'module') {
    object(d, ['kind','path','exportName','options'], 'domain'); string(d.path, 'domain.path'); string(d.exportName, 'domain.exportName');
    invariant(d.options && typeof d.options === 'object' && !Array.isArray(d.options), 'CONFIG_INVALID', 'domain.options must be an object');
  } else {
    object(d, ['kind','seed','opponentId','knowledgeStateMode','initialKnowledge'], 'domain');
    integer(d.seed, 0, 'domain.seed'); string(d.opponentId, 'domain.opponentId');
    invariant((d.kind === 'kuhn' ? ['calling','tight','random','adaptive'] : ['fixed','random','adaptive']).includes(d.opponentId), 'CONFIG_INVALID', 'Unknown built-in opponent');
    invariant(['frozen','online_update'].includes(d.knowledgeStateMode), 'CONFIG_INVALID', 'Invalid knowledge state mode');
    invariant(d.initialKnowledge && typeof d.initialKnowledge === 'object' && !Array.isArray(d.initialKnowledge), 'CONFIG_INVALID', 'initialKnowledge must be an object');
  }
  const m = input.decisionModel;
  invariant(m && ['fixture','jev'].includes(m.kind), 'CONFIG_INVALID', 'Unsupported decision model kind');
  if (m.kind === 'fixture') { object(m, ['kind','id'], 'decisionModel'); string(m.id, 'decisionModel.id'); }
  else {
    object(m, ['kind','model','apiKeyEnv','timeoutMs','baseURL'], 'decisionModel'); string(m.model, 'decisionModel.model');
    invariant(!/latest/i.test(m.model), 'CONFIG_INVALID', 'Application releases require a pinned Jev model ID, not latest');
    environment(m.apiKeyEnv, 'decisionModel.apiKeyEnv'); integer(m.timeoutMs, 1, 'decisionModel.timeoutMs'); url(m.baseURL, 'decisionModel.baseURL');
  }
  const r = input.runtime;
  object(r, ['mode','executionOwner','streamIds','maxSteps','intervalMs','maxDecisionMs','executionReserveMs'], 'runtime');
  invariant(['offline','simulation','shadow','live'].includes(r.mode), 'CONFIG_INVALID', 'Unsupported execution mode');
  invariant(['framework','host'].includes(r.executionOwner), 'CONFIG_INVALID', 'Unsupported execution owner');
  invariant(Array.isArray(r.streamIds) && r.streamIds.length > 0 && new Set(r.streamIds).size === r.streamIds.length && r.streamIds.every((s: unknown) => typeof s === 'string' && s.length > 0), 'CONFIG_INVALID', 'streamIds must contain unique nonempty strings');
  for (const key of ['maxSteps','maxDecisionMs']) integer(r[key], 1, `runtime.${key}`);
  for (const key of ['intervalMs','executionReserveMs']) integer(r[key], 0, `runtime.${key}`);
  invariant(r.executionReserveMs < r.maxDecisionMs, 'CONFIG_INVALID', 'Execution reserve must fit inside the decision deadline');
  invariant(r.mode !== 'offline' || m.kind === 'fixture', 'CONFIG_INVALID', 'Offline mode requires a fixture model');
  invariant(r.mode !== 'live' || m.kind === 'jev' && d.kind === 'module', 'CONFIG_INVALID', 'Live mode requires a real model and an external environment; built-in domains are simulations');
  invariant(['candidate_only','automatic_after_validation','explicit'].includes(input.activationMode), 'CONFIG_INVALID', 'Unsupported activation mode');
  const e = input.evaluation;
  object(e, ['developmentProtocol','finalProtocol','timeoutMs','maxModelCalls'], 'evaluation');
  string(e.developmentProtocol, 'evaluation.developmentProtocol'); string(e.finalProtocol, 'evaluation.finalProtocol');
  invariant(e.developmentProtocol !== e.finalProtocol, 'CONFIG_INVALID', 'Development and final protocols must be separate files');
  integer(e.timeoutMs, 1, 'evaluation.timeoutMs'); integer(e.maxModelCalls, 1, 'evaluation.maxModelCalls');
  const research = input.research;
  invariant(research && ['off','single','team'].includes(research.mode), 'CONFIG_INVALID', 'Unsupported research mode');
  if (research.mode === 'off') object(research, ['mode'], 'research');
  else {
    object(research, ['mode','maxRounds','budget','roles','trigger'], 'research'); integer(research.maxRounds, 1, 'research.maxRounds');
    if (research.trigger !== undefined) {
      object(research.trigger, ['settledTrajectories','cooldownMs','pollIntervalMs'], 'research.trigger');
      integer(research.trigger.settledTrajectories, 1, 'research.trigger.settledTrajectories');
      integer(research.trigger.cooldownMs, 0, 'research.trigger.cooldownMs');
      integer(research.trigger.pollIntervalMs, 10, 'research.trigger.pollIntervalMs');
      invariant(research.trigger.pollIntervalMs <= 60000, 'CONFIG_INVALID', 'research.trigger.pollIntervalMs must be <= 60000');
    }
    object(research.budget, ['maxWallTimeSeconds','maxTokensTotal','maxModelCalls','maxDecisionModelCalls','maxRepairAttempts'], 'research.budget');
    for (const key of ['maxWallTimeSeconds','maxTokensTotal','maxModelCalls','maxDecisionModelCalls']) integer(research.budget[key], 1, `research.budget.${key}`);
    integer(research.budget.maxRepairAttempts, 0, 'research.budget.maxRepairAttempts');
    object(research.roles, research.mode === 'single' ? ['researcher'] : ['researcher','adversary','integrator'], 'research.roles');
    role(research.roles.researcher, 'research.roles.researcher');
    if (research.mode === 'team') { role(research.roles.adversary, 'research.roles.adversary'); role(research.roles.integrator, 'research.roles.integrator'); }
  }
  return structuredClone(input) as DuelLoopConfiguration;
}
export async function readJsonFile(path: string): Promise<unknown> {
  let contents: string;
  try { contents = await readFile(path, 'utf8'); }
  catch { throw new DuelLoopError('NOT_FOUND', 'Cannot read JSON file', { path }); }
  try { return JSON.parse(contents); }
  catch { throw new DuelLoopError('CONFIG_INVALID', 'File is not valid JSON', { path }); }
}
export async function loadConfiguration(path: string): Promise<DuelLoopConfiguration> {
  const config = validateConfiguration(await readJsonFile(path)); const base = dirname(resolve(path));
  config.database = resolve(base, config.database); config.strategy = resolve(base, config.strategy);
  config.evaluation.developmentProtocol = resolve(base, config.evaluation.developmentProtocol);
  config.evaluation.finalProtocol = resolve(base, config.evaluation.finalProtocol);
  if (config.domain.kind === 'module') config.domain.path = resolve(base, config.domain.path);
  return config;
}
