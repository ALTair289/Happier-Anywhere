import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../cli/args.mjs';
import { resolveIosProfilingRuntimeMode } from './profiling_runtime_mode.mjs';

function modeFor(argv) {
  return resolveIosProfilingRuntimeMode(parseArgs(argv));
}

test('resolveIosProfilingRuntimeMode keeps profiling runtime off by default', () => {
  assert.equal(modeFor([]), 'off');
});

test('resolveIosProfilingRuntimeMode supports the existing standard profiling flags', () => {
  assert.equal(modeFor(['--profiling-runtime']), 'standard');
  assert.equal(modeFor(['--profiling']), 'standard');
});

test('resolveIosProfilingRuntimeMode supports explicit memory-attribution mode', () => {
  assert.equal(modeFor(['--memory-attribution']), 'memory');
  assert.equal(modeFor(['--profiling-runtime=memory']), 'memory');
  assert.equal(modeFor(['--profiling=memory']), 'memory');
});

test('resolveIosProfilingRuntimeMode rejects unknown profiling runtime modes', () => {
  assert.throws(() => modeFor(['--profiling-runtime=turbo']), /Unsupported iOS profiling runtime mode/);
});
