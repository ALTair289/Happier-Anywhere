import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionSettingsEntryModuleMocks();

const installPendingQueueSettingsFixture = () => {
    sessionSettingsEntryState.settingsState = {
        agentInputEnterToSend: true,
        agentInputHistoryScope: 'perSession',
        sessionMessageSendMode: 'server_pending',
        sessionBusySteerSendPolicy: 'steer_immediately',
        sessionPendingQueueDrainMode: 'one_at_a_time',
        sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
        alwaysShowContextSize: true,
        agentInputActionBarLayout: 'auto',
        agentInputChipDensity: 'auto',
    };
};

beforeEach(() => {
    installPendingQueueSettingsFixture();
});

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Session composer settings pending queue drain mode', () => {
    it('renders one-at-a-time and drain-all choices when Pending can be used', async () => {
        const mod = await import('@/app/(app)/settings/session/composer');
        const SessionComposerSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsScreen));

        expect(screen.findGroup('settingsSession.messageSending.pendingDrainModeTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.messageSending.pendingDrainMode.oneAtATimeTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.messageSending.pendingDrainMode.drainAllTitle')).toBeTruthy();
    });

    it('renders foreground-ready and runtime-idle delivery timing choices when Pending can be used', async () => {
        const mod = await import('@/app/(app)/settings/session/composer');
        const SessionComposerSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsScreen));

        expect(screen.findGroup('settingsSession.messageSending.pendingDeliveryTimingTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.messageSending.pendingDeliveryTiming.afterForegroundReadyTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsSession.messageSending.pendingDeliveryTiming.afterRuntimeIdleTitle')).toBeTruthy();
    });

    it('persists the runtime-idle delivery timing choice when selected', async () => {
        const mod = await import('@/app/(app)/settings/session/composer');
        const SessionComposerSettingsScreen = mod.default;
        const screen = await renderSettingsView(React.createElement(SessionComposerSettingsScreen));

        screen.pressRowByTitle('settingsSession.messageSending.pendingDeliveryTiming.afterRuntimeIdleTitle');

        expect(sessionSettingsEntryState.settingsState.sessionPendingQueueDeliveryTiming).toBe('after_runtime_idle');
    });
});
