import { describe, expect, it } from 'vitest';

import { mergeNativeUpdateStatus } from './realtime';

describe('mergeNativeUpdateStatus', () => {
    it('does not let a later optional/current result dismiss a required upgrade', () => {
        const required = {
            available: true,
            required: true,
            minimumAppVersion: '0.3.0',
            updateUrl: 'https://apps.example.test/happier',
        } as const;

        expect(mergeNativeUpdateStatus(required, { available: false })).toEqual(required);
        expect(mergeNativeUpdateStatus(required, null)).toEqual(required);
    });

    it('allows a newer required payload to refine the canonical update hint', () => {
        expect(mergeNativeUpdateStatus({
            available: true,
            required: true,
            minimumAppVersion: '0.3.0',
        }, {
            available: true,
            required: true,
            minimumAppVersion: '0.3.1',
            updateUrl: 'https://apps.example.test/happier',
        })).toEqual({
            available: true,
            required: true,
            minimumAppVersion: '0.3.1',
            updateUrl: 'https://apps.example.test/happier',
        });
    });
});
