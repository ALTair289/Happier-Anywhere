import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SERVER_SHUTDOWN_DEADLINE_MS,
  SERVER_PROCESS_EXIT_OVERHEAD_MS,
  resolveServerShutdownGraceMs,
} from './shutdown_grace.mjs';

test('resolveServerShutdownGraceMs gives the server deadline plus bounded process-exit overhead', () => {
  assert.equal(DEFAULT_SERVER_SHUTDOWN_DEADLINE_MS, 5_000);
  assert.equal(SERVER_PROCESS_EXIT_OVERHEAD_MS, 250);
  assert.equal(resolveServerShutdownGraceMs({}), 5_250);

  assert.equal(
    resolveServerShutdownGraceMs({ HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: ' 1200ms ' }),
    1_450,
  );
});

test('resolveServerShutdownGraceMs falls back for absent, invalid, and nonpositive deadlines', () => {
  for (const configured of [undefined, '', '   ', 'not-a-number', '0', '-20']) {
    const env = configured === undefined
      ? {}
      : { HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: configured };

    assert.equal(resolveServerShutdownGraceMs(env), 5_250, `configured=${String(configured)}`);
  }
});
