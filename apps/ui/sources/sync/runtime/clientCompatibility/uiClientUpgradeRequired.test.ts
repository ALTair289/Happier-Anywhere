import { describe, expect, it, vi } from 'vitest';

import {
    applyUiClientUpgradeRequired,
    parseUiClientUpgradeRequired,
} from './uiClientUpgradeRequired';

const payload = {
    error: 'client-upgrade-required',
    requirement: {
        v: 1,
        minimumSessionSyncProtocolVersion: 2,
        clientKind: 'ui-ios',
        minimumAppVersion: '0.3.0',
        updateUrl: 'https://apps.example.test/happier',
    },
} as const;

describe('UI client-upgrade-required convergence', () => {
    it('parses the same payload from HTTP bodies and Socket.IO connect errors', () => {
        expect(parseUiClientUpgradeRequired(payload)).toEqual(payload);
        expect(parseUiClientUpgradeRequired({ data: payload })).toEqual(payload);
        expect(parseUiClientUpgradeRequired(Object.assign(new Error('upgrade'), { data: payload }))).toEqual(payload);
    });

    it('publishes a required non-dismissible update state through the existing update owner', () => {
        const apply = vi.fn();
        expect(applyUiClientUpgradeRequired(payload, apply)).toBe(true);
        expect(apply).toHaveBeenCalledWith({
            available: true,
            required: true,
            minimumAppVersion: '0.3.0',
            updateUrl: 'https://apps.example.test/happier',
        });
    });

    it('retains the required state when the server has no safe update URL', () => {
        const apply = vi.fn();
        expect(applyUiClientUpgradeRequired({
            ...payload,
            requirement: { ...payload.requirement, updateUrl: null },
        }, apply)).toBe(true);
        expect(apply).toHaveBeenCalledWith({
            available: true,
            required: true,
            minimumAppVersion: '0.3.0',
        });
    });

    it('converges a required version-check response on the same sticky update owner', () => {
        const apply = vi.fn();
        expect(applyUiClientUpgradeRequired({
            v: 1,
            status: 'upgrade-required',
            minimumAppVersion: '0.3.0',
            updateUrl: null,
        }, apply)).toBe(true);
        expect(apply).toHaveBeenCalledWith({
            available: true,
            required: true,
            minimumAppVersion: '0.3.0',
        });
    });
});
