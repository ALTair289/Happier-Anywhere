import { describe, expect, it } from 'vitest';

describe('vitest integration config', () => {
    it('does not exclude integration patterns inherited from unit config', async () => {
        const module = await import('../../vitest.integration.config');
        const testConfig = (module.default as any)?.test ?? {};

        const excluded = testConfig.exclude ?? [];
        expect(excluded).toContain(module.NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB);
        for (const inheritedUnitPattern of [
            'sources/**/*.integration.test.{ts,tsx}',
            'sources/**/*.real.integration.test.{ts,tsx}',
            'sources/**/*.integration.spec.{ts,tsx}',
            'sources/**/*.e2e.test.{ts,tsx}',
        ]) {
            expect(excluded).not.toContain(inheritedUnitPattern);
        }
    });
});
