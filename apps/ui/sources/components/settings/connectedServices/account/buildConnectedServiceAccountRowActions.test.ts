import { describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceAccountRowActions } from './buildConnectedServiceAccountRowActions';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('buildConnectedServiceAccountRowActions', () => {
    it('keeps retryable refresh-failure credentials removable because they remain connected records', () => {
        const actions = buildConnectedServiceAccountRowActions({
            kind: 'oauth',
            status: 'refresh_failed_retryable',
            onDisconnect: vi.fn(),
        });

        expect(actions.some((action) => action.id === 'disconnect')).toBe(true);
    });
});
