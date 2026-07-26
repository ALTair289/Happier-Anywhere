import { describe, expect, it } from 'vitest';

import type { SessionMediaItemV1, SessionMediaUnavailableV1 } from '@happier-dev/protocol';

import { boundSessionMediaEnvelopeEntries } from './boundSessionMediaEnvelopeEntries';

const media = (id: string): SessionMediaItemV1 => ({
    id,
    role: 'output',
    category: 'generated',
    mediaKind: 'image',
    mimeType: 'image/png',
    name: `${id}.png`,
    path: `.happier/uploads/generated/${id}.png`,
    sizeBytes: 1,
    origin: { source: 'provider-generated' },
});

const unavailable = (id: string): SessionMediaUnavailableV1 => ({
    id,
    role: 'output',
    category: 'generated',
    mediaKind: 'image',
    code: 'provider_file_unavailable',
    origin: { source: 'provider-generated' },
});

describe('boundSessionMediaEnvelopeEntries', () => {
    it('uses one combined budget with persisted media retained before unavailable states', () => {
        expect(boundSessionMediaEnvelopeEntries({
            media: [media('m1'), media('m2')],
            unavailable: [unavailable('u1'), unavailable('u2')],
            maxEntries: 3,
        })).toEqual({
            media: [media('m1'), media('m2')],
            unavailable: [unavailable('u1')],
            droppedCount: 1,
        });
    });

    it('returns an empty bounded result for a non-positive budget', () => {
        expect(boundSessionMediaEnvelopeEntries({
            media: [media('m1')],
            unavailable: [unavailable('u1')],
            maxEntries: 0,
        })).toEqual({ media: [], unavailable: [], droppedCount: 2 });
    });
});
