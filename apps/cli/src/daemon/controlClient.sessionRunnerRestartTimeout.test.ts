import { describe, expect, it } from 'vitest';

import {
  resolveDaemonConnectedServiceGroupGenerationApplyTimeoutMs,
  resolveDaemonSessionRunnerRestartTimeoutMs,
} from './controlClient';

describe('resolveDaemonSessionRunnerRestartTimeoutMs', () => {
  it('defaults to a completion-sized bound that exceeds the daemon respawn-completion timeout, NOT the generic 10s daemonPost default', () => {
    // The restart handler awaits the respawn completion (default 60s). A 10s client abort while the
    // daemon respawns seconds later is the false-negative window: the ack request is aborted and the
    // succeeding restart is reported as a failure.
    expect(resolveDaemonSessionRunnerRestartTimeoutMs({})).toBeGreaterThan(60_000);
  });

  it('sizes the group-generation apply timeout for a fan-out that awaits per-session turn-boundary deferrals', () => {
    // Live incident 2026-07-10 16:29: the apply RPC aborted at the generic 10s daemonPost default
    // while the daemon-side fan-out (per-session deferrals up to 60s + restarts) kept running — the
    // UI reported divergence on every pool switch with active sessions even though the apply
    // succeeded. The client bound must exceed the deferral window with restart margin.
    expect(resolveDaemonConnectedServiceGroupGenerationApplyTimeoutMs({})).toBeGreaterThan(60_000);
    expect(resolveDaemonConnectedServiceGroupGenerationApplyTimeoutMs({
      HAPPIER_DAEMON_CONNECTED_SERVICE_GROUP_APPLY_HTTP_TIMEOUT_MS: '120000',
    })).toBe(120_000);
    expect(resolveDaemonConnectedServiceGroupGenerationApplyTimeoutMs({
      HAPPIER_DAEMON_CONNECTED_SERVICE_GROUP_APPLY_HTTP_TIMEOUT_MS: 'garbage',
    })).toBe(resolveDaemonConnectedServiceGroupGenerationApplyTimeoutMs({}));
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
