import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

import { logConnectedServiceDaemonRestartDiagnostic } from './logConnectedServiceDaemonRestartDiagnostic';
import type { ConnectedServiceDaemonRestartDiagnosticRecord } from './requestConnectedServiceSessionRestartSignal';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('logConnectedServiceDaemonRestartDiagnostic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps restart diagnostics in the debug file instead of the user console', () => {
    const record: ConnectedServiceDaemonRestartDiagnosticRecord = {
      type: 'connected_service_daemon_restart',
      trigger: 'manual_switch',
      status: 'requested',
      sessionId: 'session-1',
      agentId: 'claude',
      serviceId: 'claude-subscription',
      profileId: 'profile-1',
      groupId: null,
      generation: null,
      reason: 'manual',
      pid: 123,
      processGroupPid: 123,
      delayMs: 250,
      atMs: 1_700_000_000_000,
    };

    logConnectedServiceDaemonRestartDiagnostic(record);

    expect(logger.debug).toHaveBeenCalledWith(
      '[DAEMON RUN] Connected-service daemon restart diagnostic',
      record,
    );
  });
});
