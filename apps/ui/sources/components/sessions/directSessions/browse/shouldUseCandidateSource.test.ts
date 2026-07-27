import { describe, expect, it } from 'vitest';

import { shouldUseCandidateSource } from './shouldUseCandidateSource';

describe('shouldUseCandidateSource', () => {
    it('uses group identity instead of a rotating member profile', () => {
        expect(shouldUseCandidateSource(
            {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceGroupId: 'primary-pool',
                connectedServiceProfileId: 'member-a',
            },
            {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceGroupId: 'primary-pool',
                connectedServiceProfileId: 'member-b',
            },
        )).toBe(true);

        expect(shouldUseCandidateSource(
            {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceGroupId: 'primary-pool',
            },
            {
                kind: 'codexHome',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceGroupId: 'backup-pool',
            },
        )).toBe(false);
    });
});
