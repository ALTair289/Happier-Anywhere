import { describe, expect, it } from 'vitest';

import { parsePlainSessionAgentState, parsePlainSessionMetadata } from './parsePlainSessionPayload';

describe('parsePlainSessionPayload', () => {
    it('parses valid plaintext session metadata JSON through the canonical metadata schema', () => {
        expect(parsePlainSessionMetadata(JSON.stringify({
            name: 'Plain title',
            path: '/repo',
            host: 'dev-host',
            summary: { text: 'Plain summary', updatedAt: 1 },
        }))).toEqual(expect.objectContaining({
            name: 'Plain title',
            path: '/repo',
            host: 'dev-host',
            summary: { text: 'Plain summary', updatedAt: 1 },
        }));
    });

    it('fails closed for malformed plaintext session metadata and agent state', () => {
        expect(parsePlainSessionMetadata('{broken-json')).toBeNull();
        expect(parsePlainSessionAgentState('{broken-json')).toEqual({});
    });

    it('accepts a completed source-owned Claude dialog choice without reviving the pending request', () => {
        const parsed = parsePlainSessionAgentState(JSON.stringify({
            requests: {},
            completedRequests: {
                claude_dialog_choice_1: {
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    source: 'claude_unified_terminal_dialog_choice',
                    arguments: {
                        questions: [{
                            header: 'Claude needs attention',
                            question: 'Yes, I trust this folder',
                            options: [],
                            multiSelect: false,
                        }],
                    },
                    createdAt: 100,
                    completedAt: 200,
                    status: 'approved',
                    decision: 'allow',
                    answers: { 'Yes, I trust this folder': 'trust_once' },
                    dialogId: 'trust_folder',
                    dialogChoice: 'trust_once',
                },
            },
        }));

        expect(parsed.requests).toEqual({});
        expect(parsed.completedRequests?.claude_dialog_choice_1).toMatchObject({
            status: 'approved',
            source: 'claude_unified_terminal_dialog_choice',
            answers: { 'Yes, I trust this folder': 'trust_once' },
            dialogId: 'trust_folder',
            dialogChoice: 'trust_once',
        });
    });
});
