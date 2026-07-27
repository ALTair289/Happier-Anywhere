import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/sync/ops', () => ({
    sessionAllow: vi.fn(async () => {}),
    sessionAllowWithPermissionUpdates: vi.fn(async () => {}),
    sessionDeny: vi.fn(async () => {}),
    sessionAbort: vi.fn(async () => {}),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => {}),
    },
}));

installPermissionShellCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => ({ updateSessionPermissionMode: vi.fn() }) },
        });
    },
});

vi.mock('@/agents/catalog/resolve', () => ({
    resolveAgentIdForPermissionUi: () => 'codex',
}));

vi.mock('@/agents/catalog/permissionUiCopy', () => ({
    getPermissionFooterCopy: () => ({
        protocol: 'codexDecision',
        yesAlwaysAllowCommandKey: 'codex.permissions.yesAlwaysAllowCommand',
        yesForSessionKey: 'codex.permissions.yesForSession',
        stopKey: 'codex.permissions.stop',
    }),
}));

describe('PermissionFooter (codexDecision)', () => {
    function getTextStyleFragments(button: ReactTestInstance) {
        const textNode = button.findByType('Text' as any);
        const style = textNode.props.style;
        return (Array.isArray(style) ? style : [style]).filter(Boolean) as Array<Record<string, unknown>>;
    }

    function getStyleFragments(node: ReactTestInstance) {
        const style = node.props.style;
        return (Array.isArray(style) ? style : [style]).filter(Boolean) as Array<Record<string, unknown>>;
    }

    function expectTextOnlyActionButton(styles: Array<Record<string, unknown>>, actionBackground: string) {
        expect(styles.some((style) => style.backgroundColor === 'transparent')).toBe(true);
        expect(styles.some((style) => style.backgroundColor === actionBackground)).toBe(false);
    }

    it('does not repeat the request summary (the tool UI already shows it)', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'execute',
            toolInput: { command: 'pwd' },
            metadata: { flavor: 'codex' },
        }));

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Run: pwd')).toBeUndefined();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'common.yes')).toBeTruthy();

        // Stable locators for Maestro flows.
        const allow = screen.findByProps({ testID: 'permission-footer.allow' });
        const allowForSession = screen.findByProps({ testID: 'permission-footer.allow-for-session' });
        const deny = screen.findByProps({ testID: 'permission-footer.deny' });
        const stop = screen.findByProps({ testID: 'permission-footer.stop' });
        expect(allow).toBeTruthy();
        expect(allowForSession).toBeTruthy();
        expect(deny).toBeTruthy();
        expect(stop).toBeTruthy();

        const allowStyles = getTextStyleFragments(allow);
        const allowForSessionStyles = getTextStyleFragments(allowForSession);
        const denyStyles = getTextStyleFragments(deny);
        const stopStyles = getTextStyleFragments(stop);
        const allowButtonStyles = getStyleFragments(allow);
        const allowForSessionButtonStyles = getStyleFragments(allowForSession);
        const denyButtonStyles = getStyleFragments(deny);
        const stopButtonStyles = getStyleFragments(stop);

        expect(allowStyles.some((style) => style.color === lightTheme.colors.permissionButton.allow.text)).toBe(true);
        expect(allowForSessionStyles.some((style) => style.color === lightTheme.colors.permissionButton.allow.text)).toBe(true);
        expect(denyStyles.some((style) => style.color === lightTheme.colors.permissionButton.deny.text)).toBe(true);
        expect(stopStyles.some((style) => style.color === lightTheme.colors.permissionButton.deny.text)).toBe(true);
        expectTextOnlyActionButton(allowButtonStyles, lightTheme.colors.permissionButton.allow.background);
        expectTextOnlyActionButton(allowForSessionButtonStyles, lightTheme.colors.permissionButton.allowAll.background);
        expectTextOnlyActionButton(denyButtonStyles, lightTheme.colors.permissionButton.deny.background);
        expectTextOnlyActionButton(stopButtonStyles, lightTheme.colors.permissionButton.deny.background);
    });

    it('approves execpolicy amendment using the latest proposed_execpolicy_amendment payload', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        const { sessionAllow } = await import('@/sync/ops');

        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p1', status: 'pending' },
            sessionId: 's1',
            toolName: 'execute',
            toolInput: { proposed_execpolicy_amendment: ['allow', 'read'] },
            metadata: { flavor: 'codex' },
        }));

        const execPolicyButton = findTestInstanceByTypeContainingText(
            screen.tree,
            'TouchableOpacity',
            'codex.permissions.yesAlwaysAllowCommand',
        );
        expect(execPolicyButton).toBeTruthy();
        const execPolicyTextStyle = getTextStyleFragments(execPolicyButton as ReactTestInstance);
        const execPolicyButtonStyle = getStyleFragments(execPolicyButton as ReactTestInstance);
        expect(execPolicyTextStyle.some((style) => style.color === lightTheme.colors.permissionButton.allowAll.text)).toBe(true);
        expectTextOnlyActionButton(execPolicyButtonStyle, lightTheme.colors.permissionButton.allowAll.background);

        await pressTestInstanceAsync(execPolicyButton, 'execpolicy approval button');

        expect(sessionAllow).toHaveBeenCalledWith(
            's1',
            'p1',
            undefined,
            undefined,
            'approved_execpolicy_amendment',
            { command: ['allow', 'read'] },
        );
    });

    it('dispatches one approval when the same control is activated twice before React commits', async () => {
        const { PermissionFooter } = await import('../permissions/PermissionFooter');
        const { sessionAllow } = await import('@/sync/ops');
        vi.mocked(sessionAllow).mockClear();

        const screen = await renderScreen(React.createElement(PermissionFooter, {
            permission: { id: 'p-double-allow', status: 'pending' },
            sessionId: 's1',
            toolName: 'execute',
            toolInput: { command: 'pwd' },
            metadata: { flavor: 'codex' },
        }));
        const allow = screen.findByProps({ testID: 'permission-footer.allow' });

        await act(async () => {
            await Promise.all([allow.props.onPress(), allow.props.onPress()]);
        });

        expect(sessionAllow).toHaveBeenCalledTimes(1);
    });
});
