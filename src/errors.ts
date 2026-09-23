export type ErrorCode = 'CONFIG_INVALID' | 'STRATEGY_INVALID' | 'CAPABILITY_UNSUPPORTED' | 'STATE_STALE'
  | 'MODEL_TIMEOUT' | 'MODEL_INVALID' | 'EXECUTION_UNKNOWN' | 'STORAGE_FAILURE' | 'VALIDATION_REJECTED'
  | 'VERSION_INCOMPATIBLE' | 'CONFLICT' | 'NOT_FOUND' | 'CANCELLED' | 'BUDGET_EXHAUSTED' | 'ACCESS_DENIED' | 'DECISION_STOPPED';
export class DuelLoopError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly context: Record<string, unknown> = {}) {
    super(message); this.name = 'DuelLoopError';
  }
  toJSON() { return { name: this.name, code: this.code, message: this.message, context: this.context }; }
}
export function invariant(condition: unknown, code: ErrorCode, message: string, context: Record<string, unknown> = {}): asserts condition {
  if (!condition) throw new DuelLoopError(code, message, context);
}
