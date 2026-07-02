import { describe, expect, it } from 'vitest';

import {
    CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
    CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
} from '../providers/claude/permissionRequestSource';
import { isAgentStateRequestCoveredByCompletedRequests } from './agentStateRequestCoverage';

const bridgeCoverageOptions = {
    equivalentSources: [CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE],
    equivalentCompletedStatuses: ['canceled'],
    equivalentCompletedReasons: [CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON],
} as const;

describe('isAgentStateRequestCoveredByCompletedRequests', () => {
    it('covers same-id requests when the completed entry is newer', () => {
        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'req-1',
            request: { tool: 'Write', arguments: {}, createdAt: 10 },
            completedRequests: {
                'req-1': { tool: 'Write', arguments: {}, completedAt: 20 },
            },
        })).toBe(true);
    });

    it('does not cover same-id requests when the completed entry has different tool input', () => {
        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'req-1',
            request: { tool: 'Bash', arguments: { command: ['bash', '-lc', 'echo new'] }, createdAt: 10 },
            completedRequests: {
                'req-1': {
                    tool: 'Bash',
                    arguments: { command: ['bash', '-lc', 'echo old'] },
                    completedAt: 20,
                },
            },
        })).toBe(false);
    });

    it('covers fresh generated local-bridge requests when a canonical bridge cancellation has the same payload', () => {
        const question = { questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] };

        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'perm_generated',
            request: {
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: question,
                createdAt: 10_400,
                source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            },
            completedRequests: {
                toolu_canonical: {
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: question,
                    createdAt: 1_000,
                    completedAt: 10_000,
                    status: 'canceled',
                    reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                    source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                },
            },
            options: bridgeCoverageOptions,
        })).toBe(true);
    });

    it('does not cover old repeated local-bridge questions outside the race window', () => {
        const question = { questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] };

        expect(isAgentStateRequestCoveredByCompletedRequests({
            requestId: 'perm_later',
            request: {
                tool: 'AskUserQuestion',
                kind: 'user_action',
                arguments: question,
                createdAt: 20_000,
                source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
            },
            completedRequests: {
                toolu_canonical: {
                    tool: 'AskUserQuestion',
                    kind: 'user_action',
                    arguments: question,
                    completedAt: 10_000,
                    status: 'canceled',
                    reason: CLAUDE_LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
                    source: CLAUDE_LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
                },
            },
            options: bridgeCoverageOptions,
        })).toBe(false);
    });
});
