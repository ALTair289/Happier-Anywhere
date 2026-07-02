import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

describe('logger.debugLargeJson', () => {
    const envKeys = ['DEBUG', 'HAPPIER_HOME_DIR'] as const;
    let envScope = createEnvKeyScope(envKeys);
    let tempDir: string;
    let originalArgv: string[];

    beforeEach(() => {
        envScope = createEnvKeyScope(envKeys);
        tempDir = createTempDirSync('happier-cli-logger-test-');
        originalArgv = [...process.argv];
        envScope.patch({
            HAPPIER_HOME_DIR: tempDir,
            DEBUG: undefined,
        });
        vi.resetModules();
    });

    afterEach(() => {
        removeTempDirSync(tempDir);
        envScope.restore();
        process.argv = originalArgv;
    });

    it('does not write to log file when DEBUG is not set', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });

        expect(existsSync(logger.getLogPath())).toBe(false);
    });

    it('writes to log file when DEBUG is set', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debugLargeJson('[TEST] debugLargeJson', { secret: 'value' });

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] debugLargeJson');
    });

    it('writes Error objects with message/stack instead of "{}" when DEBUG is set', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        logger.debug('[TEST] error serialization', new Error('boom'));

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] error serialization');
        expect(content).toContain('boom');
    });

    it('does not throw when debugLargeJson receives circular objects', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const obj: { a: number; self?: unknown } = { a: 1 };
        obj.self = obj;

        expect(() => {
            logger.debugLargeJson('[TEST] circular json', obj);
        }).not.toThrow();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] circular json');
    });

    it('does not throw when logging a cross-realm Error with circular refs', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');

        const ctx = createContext({});
        const err = runInContext(
            "(() => { const e = new Error('boom'); e.error = e; return e; })()",
            ctx,
        );

        expect(err instanceof Error).toBe(false);

        expect(() => {
            logger.debug('[TEST] cross-realm error', err);
        }).not.toThrow();

        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] cross-realm error');
        expect(content).toContain('boom');
    });

    it('creates logs dir on demand when writing the first debug entry', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const logsDir = dirname(logger.getLogPath());
        rmSync(logsDir, { recursive: true, force: true });

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            logger.debugLargeJson('[TEST] create logs dir', { secret: 'value' });
        } finally {
            errorSpy.mockRestore();
        }

        expect(existsSync(logsDir)).toBe(true);
        expect(existsSync(logger.getLogPath())).toBe(true);
        const content = readFileSync(logger.getLogPath(), 'utf8');
        expect(content).toContain('[TEST] create logs dir');
    });

    it('does not throw if log file cannot be written (even when DEBUG is set)', async () => {
        process.env.DEBUG = '1';

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        // Deterministic cross-platform write failure: path points to a directory, not a file.
        mkdirSync(logger.getLogPath(), { recursive: true });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            expect(() => {
                logger.debugLargeJson('[TEST] debugLargeJson write should not throw', { secret: 'value' });
            }).not.toThrow();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('does not throw when console logging hits EPIPE', async () => {
        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        const epipeError = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {
            throw epipeError;
        });

        try {
            expect(() => {
                logger.warn('[TEST] warn survives broken stdout');
            }).not.toThrow();
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it('prunes daemon logs best-effort when constructing a daemon logger', async () => {
        process.argv = ['node', 'happier', 'daemon', 'start'];
        const logsDir = join(tempDir, 'logs');
        mkdirSync(logsDir, { recursive: true });
        for (let index = 0; index < 52; index += 1) {
            writeFileSync(
                join(logsDir, `2026-06-30-10-${String(index).padStart(2, '0')}-00-pid-${index}-daemon.log`),
                `old ${index}\n`,
                'utf8',
            );
        }

        const { logger } = (await import('@/ui/logger')) as typeof import('@/ui/logger');
        logger.debug('[TEST] current daemon log');

        await vi.waitFor(() => {
            const daemonLogs = readdirSync(logsDir).filter(file => file.endsWith('-daemon.log'));
            expect(daemonLogs).toHaveLength(50);
            expect(daemonLogs).toContain(logger.getLogPath().split('/').pop());
        });
    });
});
