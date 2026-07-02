import { describe, expect, it } from 'vitest';

import {
    buildSessionMessagesPath,
    parseSessionMessagesResponseJson,
} from './sessionMessagesApi';

function readSearchParams(path: string): URLSearchParams {
    const [, query = ''] = path.split('?');
    return new URLSearchParams(query);
}

describe('sessionMessagesApi', () => {
    it('builds the session messages page path with the canonical scope and range params', () => {
        const path = buildSessionMessagesPath({
            sessionId: 's1',
            scope: 'main',
            limit: 50,
            beforeSeq: 101,
        });

        expect(path.startsWith('/v1/sessions/s1/messages?')).toBe(true);
        const params = readSearchParams(path);
        expect(params.get('scope')).toBe('main');
        expect(params.get('limit')).toBe('50');
        expect(params.get('beforeSeq')).toBe('101');
        expect(params.has('afterSeq')).toBe(false);
        expect(params.has('sidechainId')).toBe(false);
    });

    it('includes sidechain id only for sidechain-scoped message pages', () => {
        const path = buildSessionMessagesPath({
            sessionId: 's1',
            scope: 'sidechain',
            sidechainId: 'chain-1',
            limit: 20,
            afterSeq: 100,
        });

        const params = readSearchParams(path);
        expect(params.get('scope')).toBe('sidechain');
        expect(params.get('sidechainId')).toBe('chain-1');
        expect(params.get('afterSeq')).toBe('100');
    });

    it('parses valid message page responses and rejects invalid shapes at the API boundary', () => {
        expect(parseSessionMessagesResponseJson({
            messages: [],
            hasMore: true,
            nextBeforeSeq: 10,
        })).toEqual({
            messages: [],
            hasMore: true,
            nextBeforeSeq: 10,
        });

        expect(() => parseSessionMessagesResponseJson({ messages: 'bad' })).toThrow('Invalid /messages response');
    });
});
