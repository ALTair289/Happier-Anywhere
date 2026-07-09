import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('getCachedIntlDateTimeFormat', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('reuses DateTimeFormat instances for equivalent locale and options', async () => {
        const DateTimeFormatSpy = vi.spyOn(Intl, 'DateTimeFormat');
        const { getCachedIntlDateTimeFormat } = await import('./cachedIntlFormatters');

        const first = getCachedIntlDateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
        const second = getCachedIntlDateTimeFormat(undefined, {
            timeStyle: 'short',
            dateStyle: 'medium',
        });

        expect(second).toBe(first);
        expect(DateTimeFormatSpy).toHaveBeenCalledTimes(1);
    });

    it('partitions DateTimeFormat instances by locale and options', async () => {
        const DateTimeFormatSpy = vi.spyOn(Intl, 'DateTimeFormat');
        const { getCachedIntlDateTimeFormat } = await import('./cachedIntlFormatters');

        const enShort = getCachedIntlDateTimeFormat('en-US', { month: 'short', day: 'numeric' });
        const deShort = getCachedIntlDateTimeFormat('de-DE', { month: 'short', day: 'numeric' });
        const enHour = getCachedIntlDateTimeFormat('en-US', { hour: 'numeric' });

        expect(deShort).not.toBe(enShort);
        expect(enHour).not.toBe(enShort);
        expect(DateTimeFormatSpy).toHaveBeenCalledTimes(3);
    });
});
