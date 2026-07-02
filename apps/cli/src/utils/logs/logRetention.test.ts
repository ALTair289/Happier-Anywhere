import { describe, expect, it } from 'vitest';

import {
  DAEMON_LOG_SUFFIX,
  DEFAULT_DAEMON_LOG_KEEP_COUNT,
  DEFAULT_SESSION_LOG_KEEP_COUNT,
  LOG_FILE_SUFFIX,
  resolveDaemonLogKeepCount,
  resolveSessionLogKeepCount,
} from './logRetention';

describe('logRetention', () => {
  it('exposes stable suffix constants', () => {
    expect(DAEMON_LOG_SUFFIX).toBe('-daemon.log');
    expect(LOG_FILE_SUFFIX).toBe('.log');
  });

  it('falls back to defaults when env values are missing or invalid', () => {
    expect(resolveDaemonLogKeepCount({})).toBe(DEFAULT_DAEMON_LOG_KEEP_COUNT);
    expect(resolveSessionLogKeepCount({})).toBe(DEFAULT_SESSION_LOG_KEEP_COUNT);
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: 'nope' })).toBe(DEFAULT_DAEMON_LOG_KEEP_COUNT);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '-4' })).toBe(DEFAULT_SESSION_LOG_KEEP_COUNT);
  });

  it('honors env overrides, flooring fractional values and accepting zero', () => {
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: '10' })).toBe(10);
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: '0' })).toBe(0);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '25.9' })).toBe(25);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '0' })).toBe(0);
  });
});
