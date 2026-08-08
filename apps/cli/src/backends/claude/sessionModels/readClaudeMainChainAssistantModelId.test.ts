import { describe, expect, it } from 'vitest';

import { readClaudeMainChainAssistantModelId } from './readClaudeMainChainAssistantModelId';

describe('readClaudeMainChainAssistantModelId', () => {
    it('rejects a synthetic provider-error assistant row', () => {
        expect(readClaudeMainChainAssistantModelId({
            type: 'assistant',
            uuid: 'synthetic-auth-error',
            model: '<synthetic>',
            error: 'authentication_failed',
            isApiErrorMessage: true,
            message: {
                role: 'assistant',
                model: '<synthetic>',
                content: [{ type: 'text', text: 'OAuth access token has expired' }],
            },
        })).toBeNull();
    });

    it('returns real main-chain assistant model evidence', () => {
        expect(readClaudeMainChainAssistantModelId({
            type: 'assistant',
            message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [] },
        })).toBe('claude-sonnet-4-6');
    });

    it('rejects sidechain assistant model evidence', () => {
        expect(readClaudeMainChainAssistantModelId({
            type: 'assistant',
            parent_tool_use_id: 'tool-1',
            message: { role: 'assistant', model: 'claude-haiku-4-5', content: [] },
        })).toBeNull();
    });
});
