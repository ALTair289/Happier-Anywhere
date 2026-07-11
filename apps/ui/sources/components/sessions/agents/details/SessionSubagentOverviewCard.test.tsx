import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { renderScreen } from '@/dev/testkit';
import { installSessionSubagentCommonModuleMocks } from '../sessionSubagentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSubagentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
                React.createElement('View', props, children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, values?: Record<string, unknown>) => {
                if (key === 'session.subagents.kind.execution_run') return 'Subagent';
                if (key === 'session.subagents.intent.review') return 'Review';
                if (key === 'session.subagents.panel.typeFact' && values?.value) return `Type: ${values.value}`;
                if (key === 'session.subagents.panel.backendFact' && values?.value) return `Backend: ${values.value}`;
                if (key === 'session.subagents.panel.intentFact' && values?.value) return `Intent: ${values.value}`;
                if (key === 'session.subagents.panel.nativeTypeFact' && values?.value) return `Native type: ${values.value}`;
                if (key === 'session.subagents.panel.modelFact' && values?.value) return `Model: ${values.value}`;
                if (key === 'session.subagents.panel.agentIdFact' && values?.value) return `Agent ID: ${values.value}`;
                if (key === 'session.subagents.panel.durationFact' && values?.value) return `Duration: ${values.value}`;
                return key;
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#111',
                    surfaceHigh: '#222',
                    divider: '#333',
                    text: '#eee',
                    textSecondary: '#aaa',
                },
            },
        });
    },
});

describe('SessionSubagentOverviewCard', () => {
    it('renders the shared compact fact pills for execution runs', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');

        const subagent: SessionSubagent = {
            id: 'execution_run:run_1',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'run_1' },
            transcript: { toolMessageRouteId: 'tool:toolu_1', toolId: 'toolu_1', sidechainId: 'toolu_1' },
            runRef: { runId: 'run_1', backendId: 'codex', intent: 'review', runClass: 'long_lived' },
            recipient: { kind: 'execution_run', runId: 'run_1', label: 'run_1' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        };

        const screen = await renderScreen(<SessionSubagentOverviewCard subagent={subagent} />);
        const textContent = screen.getTextContent();

        expect(textContent).toContain('Type: Subagent');
        expect(textContent).toContain('Backend: codex');
        expect(textContent).toContain('Intent: Review');
    });

    it('renders bounded provider-neutral native task evidence through the shared fact pills', async () => {
        const { SessionSubagentOverviewCard } = await import('./SessionSubagentOverviewCard');

        const subagent: SessionSubagent = {
            id: 'subagent_sidechain:opaque-task',
            kind: 'subagent_sidechain',
            status: 'succeeded',
            display: { title: 'Inspect integration', providerLabel: 'Cursor' },
            transcript: { toolMessageRouteId: 'server:message-1', toolId: 'opaque-task' },
            nativeRef: {
                lifecycle: 'completion_only',
                type: 'custom',
                customType: 'specialist',
                model: 'cursor-model',
                agentId: 'cursor-agent-1',
                durationMs: 1_500,
            },
            recipient: null,
            capabilities: { canOpen: true, canSend: false, canStop: false, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: false },
            timestamps: { finishedAtMs: 2_000 },
        };

        const screen = await renderScreen(<SessionSubagentOverviewCard subagent={subagent} />);
        const textContent = screen.getTextContent();

        expect(textContent).toContain('Native type: specialist');
        expect(textContent).toContain('Model: cursor-model');
        expect(textContent).toContain('Agent ID: cursor-agent-1');
        expect(textContent).toContain('Duration: 1.5s');
    });
});
