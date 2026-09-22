import { createHash, randomBytes } from 'node:crypto';
import { DuelLoopError } from './errors.js';
import type { Json } from './types.js';
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (typeof value === 'object' && value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  throw new DuelLoopError('CONFIG_INVALID', 'Values must be finite JSON data');
}
export function digest(value: unknown): string { return createHash('sha256').update(canonicalize(value)).digest('hex'); }
export function jsonValue(value: unknown): Json { return JSON.parse(canonicalize(value)) as Json; }
export function getFeature(data: Record<string, unknown>, key: string): unknown {
  if (Object.hasOwn(data, key)) return data[key];
  return key.split('.').reduce<unknown>((v, part) => v && typeof v === 'object' && Object.hasOwn(v, part) ? (v as Record<string, unknown>)[part] : undefined, data);
}
export function seededRandom(seed: string | number): () => number {
  let state = parseInt(createHash('sha256').update(String(seed)).digest('hex').slice(0, 8), 16);
  return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function secureRandom(): number { return randomBytes(6).readUIntBE(0, 6) / 281474976710656; }
export async function withDeadline<T>(deadline: number, operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  if (parent?.aborted) throw new DuelLoopError('CANCELLED', 'Operation cancelled');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DuelLoopError('MODEL_TIMEOUT', 'Deadline expired');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let abort!: () => void;
  const timeout = new Promise<never>((_, reject) => {
    abort = () => { const error = new DuelLoopError('CANCELLED', 'Operation cancelled'); controller.abort(error); reject(error); };
    timer = setTimeout(() => { const error = new DuelLoopError('MODEL_TIMEOUT', 'Deadline expired'); controller.abort(error); reject(error); }, remaining);
    if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  });
  // Attach both rejection handlers before entering caller code. A synchronous throw
  // (including one after aborting the parent) must not leave timeout unobserved.
  const task = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw controller.signal.reason;
    return operation(controller.signal);
  });
  try { return await Promise.race([task, timeout]); }
  finally { clearTimeout(timer!); parent?.removeEventListener('abort', abort); }
}
