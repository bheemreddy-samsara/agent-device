import { test } from 'vitest';
import assert from 'node:assert/strict';
import { perfHangNextSteps, perfHitchNextSteps } from '../perf-hang-next-steps.ts';

test('perfHangNextSteps names the top symbol for a running-dominant main-thread hang', () => {
  const steps = perfHangNextSteps({
    runningMs: 3_800,
    blockedMs: 200,
    topSymbol: 'HangViewController.blockMainThread(seconds:)',
    threadName: 'Main Thread',
  });
  assert.match(steps.join('\n'), /HangViewController\.blockMainThread\(seconds:\)/);
  assert.match(steps.join('\n'), /perf cpu profile/);
  assert.ok(!steps.join('\n').includes('blocked, not running'));
});

test('perfHangNextSteps recommends offloading for a blocked-dominant hang', () => {
  const steps = perfHangNextSteps({ runningMs: 10, blockedMs: 2_900, threadName: 'main' });
  assert.equal(steps.length, 1);
  assert.match(steps.join('\n'), /blocked, not running/);
});

test('perfHangNextSteps recommends a CPU profile without a top symbol', () => {
  const steps = perfHangNextSteps({ runningMs: 900, blockedMs: 0 });
  assert.equal(steps.length, 1);
  assert.match(steps.join('\n'), /perf cpu profile/);
});

test('perfHitchNextSteps points at layout cost and trace UIs', () => {
  assert.match(perfHitchNextSteps().join('\n'), /layout cost/);
});
