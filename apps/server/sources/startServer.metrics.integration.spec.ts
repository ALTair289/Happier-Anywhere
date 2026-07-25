import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createStartServerDbMocks,
    installStartServerCommonWiringMocks,
    installStartServerDbModuleMock,
} from '@/testkit/startServerMocks';
import { createStartServerHarness } from '@/testkit/startServerHarness';

vi.mock('@/storage/redis/redis', () => ({
    getRedisClient: () => ({ ping: vi.fn(async () => 'PONG') }),
}));

const startServerDbMocks = createStartServerDbMocks();
installStartServerDbModuleMock(startServerDbMocks);
installStartServerCommonWiringMocks();

vi.mock('@/utils/process/shutdown', () => ({
    onShutdown: vi.fn(),
    awaitShutdown: vi.fn(async () => {}),
}));

describe('startServer database metrics wiring', () => {
    const harness = createStartServerHarness({
        SERVER_ROLE: 'all',
        METRICS_ENABLED: 'false',
    });

    beforeEach(() => {
        startServerDbMocks.reset();
        harness.reset();
    });

    afterEach(() => {
        harness.restore();
    });

    it('does not run exact table-count metrics when the metrics server is disabled', async () => {
        harness.prepareImport();
        const metricsModule = await import('@/app/monitoring/metrics');
        const metrics2Module = await import('@/app/monitoring/metrics2');
        vi.mocked(metricsModule.startMetricsServer).mockResolvedValue(false);
        const { startServer } = await import('./startServer');

        await startServer('light');

        expect(metrics2Module.startDatabaseMetricsUpdater).not.toHaveBeenCalled();
    });

    it('does not run exact table-count metrics on the single-connection SQLite runtime', async () => {
        harness.prepareImport({ METRICS_ENABLED: 'true' });
        const metricsModule = await import('@/app/monitoring/metrics');
        const metrics2Module = await import('@/app/monitoring/metrics2');
        vi.mocked(metricsModule.startMetricsServer).mockResolvedValue(true);
        const { startServer } = await import('./startServer');

        await startServer('light');

        expect(metrics2Module.startDatabaseMetricsUpdater).not.toHaveBeenCalled();
    });

    it('retains database record metrics for an enabled non-SQLite runtime', async () => {
        harness.prepareImport({ METRICS_ENABLED: 'true' });
        const metricsModule = await import('@/app/monitoring/metrics');
        const metrics2Module = await import('@/app/monitoring/metrics2');
        vi.mocked(metricsModule.startMetricsServer).mockResolvedValue(true);
        const { startServer } = await import('./startServer');

        await startServer('full');

        expect(metrics2Module.startDatabaseMetricsUpdater).toHaveBeenCalledOnce();
    });
});
