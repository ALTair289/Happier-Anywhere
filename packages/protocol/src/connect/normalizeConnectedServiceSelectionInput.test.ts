import { describe, expect, it } from 'vitest';

import { normalizeConnectedServiceSelectionInput } from './normalizeConnectedServiceSelectionInput.js';

describe('normalizeConnectedServiceSelectionInput', () => {
    it('treats undefined/null as no explicit selection (account default)', () => {
        expect(normalizeConnectedServiceSelectionInput(undefined)).toEqual({ ok: true, bindings: undefined });
        expect(normalizeConnectedServiceSelectionInput(null)).toEqual({ ok: true, bindings: undefined });
    });

    it('normalizes a bare service id to the account default (no explicit binding)', () => {
        expect(normalizeConnectedServiceSelectionInput('openai-codex')).toEqual({ ok: true, bindings: undefined });
    });

    it('normalizes "<service>:<profileId>" to a profile binding', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:team');
        expect(result).toEqual({
            ok: true,
            bindings: {
                v: 1,
                bindingsByServiceId: {
                    'openai-codex': { source: 'connected', selection: 'profile', profileId: 'team' },
                },
            },
        });
    });

    it('normalizes the explicit "<service>:profile:<profileId>" form', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:profile:team');
        expect(result.ok).toBe(true);
        expect(result.ok && result.bindings?.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'profile',
            profileId: 'team',
        });
    });

    it('normalizes "<service>:group:<groupId>" to a group binding', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:group:happier');
        expect(result.ok).toBe(true);
        expect(result.ok && result.bindings?.bindingsByServiceId['openai-codex']).toEqual({
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
        });
    });

    it('normalizes "<service>:native" to a native (opt-out) binding', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:native');
        expect(result.ok).toBe(true);
        expect(result.ok && result.bindings?.bindingsByServiceId['openai-codex']).toEqual({ source: 'native' });
    });

    it('accepts an array of tokens across services', () => {
        const result = normalizeConnectedServiceSelectionInput(['openai-codex:group:happier', 'anthropic:work']);
        expect(result.ok).toBe(true);
        expect(result.ok && Object.keys(result.bindings?.bindingsByServiceId ?? {})).toEqual(['openai-codex', 'anthropic']);
    });

    it('accepts the full bindings object power form', () => {
        const input = {
            v: 1,
            bindingsByServiceId: {
                'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' },
            },
        };
        expect(normalizeConnectedServiceSelectionInput(input)).toEqual({ ok: true, bindings: input });
    });

    it('rejects an unknown service id with a typed error naming the valid forms', () => {
        const result = normalizeConnectedServiceSelectionInput('not-a-service:team');
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/Unknown connected service id/);
        expect(result.ok === false && result.error).toMatch(/<serviceId>:group:<groupId>/);
    });

    it('rejects a group form missing its group id', () => {
        const result = normalizeConnectedServiceSelectionInput('openai-codex:group');
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/missing a group id/);
    });

    it('rejects duplicate selections for the same service', () => {
        const result = normalizeConnectedServiceSelectionInput(['openai-codex:team', 'openai-codex:group:happier']);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/Duplicate selection/);
    });

    it('rejects a malformed object', () => {
        const result = normalizeConnectedServiceSelectionInput({ nope: true });
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error).toMatch(/Invalid connected-services object/);
    });
});
