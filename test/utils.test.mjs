import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { withDeadline } from '../dist/utils.js';

test('withDeadline never starts an operation when the parent was already cancelled', async () => {
  const parent = new AbortController(); parent.abort(); let calls = 0;
  await assert.rejects(withDeadline(Date.now() + 1000, async () => { calls++; return 'forbidden'; }, parent.signal), { code: 'CANCELLED' });
  assert.equal(calls, 0); assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('withDeadline cancellation before the operation microtask prevents side effects', async () => {
  const parent = new AbortController(); let calls = 0;
  const result = withDeadline(Date.now() + 1000, async () => { calls++; return 'forbidden'; }, parent.signal);
  parent.abort(); await assert.rejects(result, { code: 'CANCELLED' });
  assert.equal(calls, 0); assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('withDeadline catches synchronous throws and always removes cancellation listeners', async () => {
  const parent = new AbortController(); const failure = new Error('synchronous failure');
  await assert.rejects(withDeadline(Date.now() + 1000, () => { throw failure; }, parent.signal), error => error === failure);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  parent.abort(); await nextTurn(); // No detached timeout rejection after cleanup.
});

test('withDeadline observes both rejections when caller aborts then throws synchronously', async () => {
  const parent = new AbortController();
  await assert.rejects(withDeadline(Date.now() + 1000, () => {
    parent.abort(); throw new Error('late synchronous failure');
  }, parent.signal), { code: 'CANCELLED' });
  await nextTurn(); // node:test fails this regression on an unhandled timeout rejection.
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

test('withDeadline aborts timed-out work and observes its late rejection', async () => {
  let operationSignal; let rejectOperation;
  const result = withDeadline(Date.now() + 15, signal => {
    operationSignal = signal;
    return new Promise((_resolve, reject) => { rejectOperation = reject; });
  });
  await assert.rejects(result, { code: 'MODEL_TIMEOUT' });
  assert.equal(operationSignal.aborted, true); assert.equal(operationSignal.reason.code, 'MODEL_TIMEOUT');
  rejectOperation(new Error('late remote failure')); await nextTurn();
});

test('withDeadline does not start expired work and returns successful values without listeners', async () => {
  await assert.rejects(withDeadline(Date.now() - 1, () => assert.fail('expired operation started')), { code: 'MODEL_TIMEOUT' });
  const parent = new AbortController();
  assert.equal(await withDeadline(Date.now() + 1000, async () => 42, parent.signal), 42);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});
