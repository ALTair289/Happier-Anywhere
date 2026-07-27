import { describe, expect, it } from 'vitest';

import {
  resolveDaemonSessionRunnerRestartTimeoutMs,
} from './controlClient';

describe('resolveDaemonSessionRunnerRestartTimeoutMs', () => {
  it('defaults to a completion-sized bound that exceeds the daemon respawn-completion timeout, NOT the generic 10s daemonPost default', () => {
    // The restart handler awaits the respawn completion (default 60s). A 10s client abort while the
    // daemon respawns seconds later is the false-negative window: the ack request is aborted and the
    // succeeding restart is reported as a failure.
    expect(resolveDaemonSessionRunnerRestartTimeoutMs({})).toBeGreaterThan(60_000);
  });

  it('honors the env override within bounds', () => {
    expect(resolveDaemonSessionRunnerRestartTimeoutMs({
      HAPPIER_DAEMON_SESSION_RUNNER_RESTART_HTTP_TIMEOUT_MS: '90000',
    })).toBe(90_000);
    expect(resolveDaemonSessionRunnerRestartTimeoutMs({
      HAPPIER_DAEMON_SESSION_RUNNER_RESTART_HTTP_TIMEOUT_MS: '1',
    })).toBe(1_000);
    expect(resolveDaemonSessionRunnerRestartTimeoutMs({
      HAPPIER_DAEMON_SESSION_RUNNER_RESTART_HTTP_TIMEOUT_MS: '99999999',
    })).toBe(300_000);
    expect(resolveDaemonSessionRunnerRestartTimeoutMs({
      HAPPIER_DAEMON_SESSION_RUNNER_RESTART_HTTP_TIMEOUT_MS: 'garbage',
    })).toBe(resolveDaemonSessionRunnerRestartTimeoutMs({}));
  });
});
