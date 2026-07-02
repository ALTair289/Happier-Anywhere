import { describe, expect, it } from 'vitest';

import { isFileLogLevelEnabled, resolveFileLogLevel } from './logFileLevel';

describe('resolveFileLogLevel', () => {
  it('defaults session processes to info and daemon processes to debug', () => {
    expect(resolveFileLogLevel({ env: {}, isDaemonProcess: false })).toBe('info');
    expect(resolveFileLogLevel({ env: {}, isDaemonProcess: true })).toBe('debug');
  });

  it('enables debug when the DEBUG env var is set', () => {
    expect(resolveFileLogLevel({ env: { DEBUG: '1' }, isDaemonProcess: false })).toBe('debug');
  });

  it('honors HAPPIER_LOG_LEVEL over defaults and DEBUG', () => {
    expect(resolveFileLogLevel({ env: { HAPPIER_LOG_LEVEL: 'debug' }, isDaemonProcess: false })).toBe('debug');
    expect(resolveFileLogLevel({ env: { HAPPIER_LOG_LEVEL: 'warn', DEBUG: '1' }, isDaemonProcess: false })).toBe('warn');
    expect(resolveFileLogLevel({ env: { HAPPIER_LOG_LEVEL: 'silent' }, isDaemonProcess: true })).toBe('silent');
    expect(resolveFileLogLevel({ env: { HAPPIER_LOG_LEVEL: 'INFO' }, isDaemonProcess: true })).toBe('info');
  });

  it('ignores invalid HAPPIER_LOG_LEVEL values', () => {
    expect(resolveFileLogLevel({ env: { HAPPIER_LOG_LEVEL: 'verbose' }, isDaemonProcess: false })).toBe('info');
    expect(resolveFileLogLevel({ env: { HAPPIER_LOG_LEVEL: 'verbose' }, isDaemonProcess: true })).toBe('debug');
  });
});

describe('isFileLogLevelEnabled', () => {
  it('orders debug < info < warn < silent', () => {
    expect(isFileLogLevelEnabled('debug', 'debug')).toBe(true);
    expect(isFileLogLevelEnabled('info', 'debug')).toBe(false);
    expect(isFileLogLevelEnabled('info', 'info')).toBe(true);
    expect(isFileLogLevelEnabled('info', 'warn')).toBe(true);
    expect(isFileLogLevelEnabled('warn', 'info')).toBe(false);
    expect(isFileLogLevelEnabled('silent', 'warn')).toBe(false);
  });
});
