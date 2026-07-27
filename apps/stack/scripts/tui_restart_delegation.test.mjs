import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  beginTuiRestartOperation,
  createTuiRuntimeOwnershipTracker,
  resolveTuiShutdownChildren,
} from './utils/tui/restart_operation.mjs';

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killCalls = 0;
  }

  kill() {
    this.killCalls += 1;
  }

  exit(code = 0, signal = null) {
    this.exitCode = signal ? null : code;
    this.signalCode = signal;
    this.emit('exit', this.exitCode, signal);
  }
}

function createHarness({ previousChild = new FakeChild(101), replacementChild = new FakeChild(202), spawnError = null } = {}) {
  const tracked = [previousChild];
  const logs = [];
  const refreshes = [];
  const spawnArgs = [];
  const spawnChild = (args) => {
    spawnArgs.push([...args]);
    if (spawnError) throw spawnError;
    return replacementChild;
  };
  const trackChild = (child) => tracked.push(child);
  const log = (message) => logs.push(message);
  const refresh = () => refreshes.push('refresh');
  return {
    previousChild,
    replacementChild,
    tracked,
    logs,
    refreshes,
    spawnArgs,
    spawnChild,
    trackChild,
    log,
    refresh,
  };
}

function begin(harness, currentOperation = null) {
  return beginTuiRestartOperation({
    currentOperation,
    previousChild: harness.previousChild,
    previousRuntimeOwner: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
    restartArgs: ['stack', 'dev', 'exp1', '--watch', '--restart'],
    spawnChild: harness.spawnChild,
    trackChild: harness.trackChild,
    log: harness.log,
    refresh: harness.refresh,
  });
}

test('TUI cleanup remains bound to the runtime owner admitted by its own child', () => {
  const tracker = createTuiRuntimeOwnershipTracker({
    runtimeOwnerBeforeSpawn: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
  });

  tracker.observe({
    runtimeOwner: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
    childActive: true,
  });
  assert.equal(tracker.getExpectedOwner(), null);

  tracker.observe({
    runtimeOwner: { ownerPid: 202, startedAt: '2026-07-21T08:00:00.000Z' },
    childActive: true,
  });
  assert.deepEqual(tracker.getExpectedOwner(), {
    ownerPid: 202,
    startedAt: '2026-07-21T08:00:00.000Z',
  });

  tracker.observe({
    runtimeOwner: { ownerPid: 303, startedAt: '2026-07-21T09:00:00.000Z' },
    childActive: false,
  });
  assert.deepEqual(tracker.getExpectedOwner(), {
    ownerPid: 202,
    startedAt: '2026-07-21T08:00:00.000Z',
  });
});

test('restart refuses to spawn until the incumbent runtime owner incarnation is known', () => {
  const harness = createHarness();

  const result = beginTuiRestartOperation({
    previousChild: harness.previousChild,
    previousRuntimeOwner: { ownerPid: 101, startedAt: 'not-a-timestamp' },
    restartArgs: ['stack', 'dev', 'exp1', '--watch', '--restart'],
    spawnChild: harness.spawnChild,
    trackChild: harness.trackChild,
    log: harness.log,
    refresh: harness.refresh,
  });

  assert.equal(result.started, false);
  assert.equal(result.reason, 'missing_runtime_owner');
  assert.equal(harness.spawnArgs.length, 0);
  assert.match(harness.logs.at(-1), /current runtime owner evidence is unavailable/i);
});

test('restart recovers a terminal child when no runtime owner remains', () => {
  const harness = createHarness();
  harness.previousChild.exit(1);

  const result = beginTuiRestartOperation({
    previousChild: harness.previousChild,
    previousRuntimeOwner: null,
    restartArgs: ['stack', 'dev', 'exp1', '--watch', '--restart'],
    spawnChild: harness.spawnChild,
    trackChild: harness.trackChild,
    log: harness.log,
    refresh: harness.refresh,
  });

  assert.equal(result.started, true);
  assert.equal(result.reason, 'started');
  assert.deepEqual(harness.spawnArgs, [['stack', 'dev', 'exp1', '--watch', '--restart']]);
  assert.equal(result.replacementChild, harness.replacementChild);
});

test('restart operation spawns the canonical candidate without terminating the previous child', () => {
  const harness = createHarness();

  const result = begin(harness);

  assert.equal(result.started, true);
  assert.deepEqual(harness.spawnArgs, [['stack', 'dev', 'exp1', '--watch', '--restart']]);
  assert.equal(harness.previousChild.killCalls, 0);
  assert.equal(harness.previousChild.exitCode, null);
  assert.equal(harness.tracked.at(-1), harness.previousChild);
  assert.deepEqual(result.operation.getActiveChildren(), [harness.previousChild, harness.replacementChild]);
});

test('failed candidate spawn and early candidate exit keep the previous active child tracked', () => {
  const spawnFailure = createHarness({ spawnError: new Error('spawn failed') });
  const failed = begin(spawnFailure);

  assert.equal(failed.started, false);
  assert.equal(failed.reason, 'spawn_failed');
  assert.equal(spawnFailure.tracked.at(-1), spawnFailure.previousChild);
  assert.equal(spawnFailure.previousChild.killCalls, 0);

  const earlyExit = createHarness();
  const started = begin(earlyExit);
  earlyExit.replacementChild.exit(1);

  assert.equal(started.operation.pending, false);
  assert.equal(earlyExit.tracked.at(-1), earlyExit.previousChild);
  assert.deepEqual(started.operation.getActiveChildren(), [earlyExit.previousChild]);
  assert.equal(earlyExit.refreshes.length, 1);
});

test('new runtime owner observation admits the replacement and transfers active-child ownership', () => {
  const harness = createHarness();
  const result = begin(harness);

  harness.previousChild.exit(0, 'SIGTERM');
  result.operation.observeRuntimeOwner({ ownerPid: 303, startedAt: '2026-07-21T08:00:00.000Z' });

  assert.equal(result.operation.pending, false);
  assert.equal(harness.tracked.at(-1), harness.replacementChild);
  assert.deepEqual(result.operation.getActiveChildren(), [harness.replacementChild]);
  assert.equal(harness.refreshes.length, 2);
});

test('previous wrapper exit does not admit a replacement until a new runtime owner incarnation is observed', () => {
  const harness = createHarness();
  const first = beginTuiRestartOperation({
    previousChild: harness.previousChild,
    previousRuntimeOwner: { ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' },
    restartArgs: ['stack', 'dev', 'exp1', '--watch', '--restart'],
    spawnChild: harness.spawnChild,
    trackChild: harness.trackChild,
    log: harness.log,
    refresh: harness.refresh,
  });

  harness.previousChild.exit(0, 'SIGTERM');
  const second = begin(harness, first.operation);

  assert.equal(first.operation.pending, true);
  assert.equal(harness.tracked.at(-1), harness.replacementChild);
  assert.equal(second.started, false);
  assert.equal(harness.spawnArgs.length, 1);
  assert.equal(first.operation.observeRuntimeOwner({ ownerPid: 101, startedAt: '2026-07-21T07:50:00.000Z' }), false);
  assert.equal(first.operation.pending, true);
  assert.equal(first.operation.observeRuntimeOwner({ ownerPid: 303, startedAt: 'not-a-timestamp' }), false);
  assert.equal(first.operation.observeRuntimeOwner({ ownerPid: 101, startedAt: '2026-07-21T08:00:00.000Z' }), true);
  assert.equal(first.operation.pending, false);
});

test('a second restart is suppressed while canonical admission is pending', () => {
  const harness = createHarness();
  const first = begin(harness);
  const second = begin(harness, first.operation);

  assert.equal(second.started, false);
  assert.equal(second.reason, 'in_progress');
  assert.equal(second.operation, first.operation);
  assert.equal(harness.spawnArgs.length, 1);
});

test('near-simultaneous exits settle once according to the first ownership event', () => {
  const replacementFirst = createHarness();
  const replacementFirstResult = begin(replacementFirst);
  replacementFirst.replacementChild.exit(1);
  replacementFirst.previousChild.exit(0, 'SIGTERM');

  assert.equal(replacementFirst.tracked.at(-1), replacementFirst.previousChild);
  assert.equal(replacementFirst.refreshes.length, 1);
  assert.deepEqual(replacementFirstResult.operation.getActiveChildren(), []);

  const previousFirst = createHarness();
  const previousFirstResult = begin(previousFirst);
  previousFirst.previousChild.exit(0, 'SIGTERM');
  previousFirst.replacementChild.exit(1);

  assert.equal(previousFirst.tracked.at(-1), previousFirst.replacementChild);
  assert.equal(previousFirst.refreshes.length, 2);
  assert.deepEqual(previousFirstResult.operation.getActiveChildren(), []);
});

test('shutdown sees both active children while admission is pending and only the survivor after settlement', () => {
  const harness = createHarness();
  const result = begin(harness);

  assert.deepEqual(
    resolveTuiShutdownChildren({ trackedChild: harness.previousChild, restartOperation: result.operation }),
    [harness.previousChild, harness.replacementChild],
  );

  harness.replacementChild.exit(1);

  assert.deepEqual(
    resolveTuiShutdownChildren({ trackedChild: harness.previousChild, restartOperation: result.operation }),
    [harness.previousChild],
  );
});
