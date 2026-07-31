import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    findTestInstanceByTypeWithProps,
    renderScreen,
} from '@/dev/testkit';
import { SESSION_HEADER_ICON_SIZE_PX } from './sessionHeaderIconMetrics';
import {
    installSessionActionsCommonModuleMocks,
    resetSessionActionsCommonModuleMockState,
} from './sessionActionsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionActionsCommonModuleMocks();

const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
const cockpitRegistrationState = vi.hoisted(() => ({
    registration: null as null | {
        sessionId: string;
        switchSurface: (surface: string) => void;
    },
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeId: 'session:s1',
        scopeState: {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
        },
        openRight: openRightSpy,
        closeRight: vi.fn(),
        setRightTab: setRightTabSpy,
        setRightTabState: vi.fn(),
        openBottom: vi.fn(),
        closeBottom: vi.fn(),
        setBottomTab: vi.fn(),
        setBottomTabState: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitChromeRegistry', () => ({
    useSessionCockpitChromeRegistration: () => cockpitRegistrationState.registration,
}));

describe('SessionHeaderTranscriptNavigationButton', () => {
    beforeEach(() => {
        resetSessionActionsCommonModuleMockState();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
        cockpitRegistrationState.registration = null;
    });

    it('opens the right panel on the navigation tab when pressed', async () => {
        const { SessionHeaderTranscriptNavigationButton } = await import('./SessionHeaderTranscriptNavigationButton');

        const screen = await renderScreen(
            <SessionHeaderTranscriptNavigationButton scopeId="session:s1" />
        );

        await screen.pressByTestIdAsync('session-header-transcript-navigation-button');

        expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'navigation' });
        expect(setRightTabSpy).toHaveBeenCalledWith('navigation');
        expect(findTestInstanceByTypeWithProps(screen, 'Icon', {
            name: 'list',
            size: SESSION_HEADER_ICON_SIZE_PX,
        })).toBeTruthy();
    });

    it('switches the active cockpit session to the transcript navigation surface when cockpit chrome owns panes', async () => {
        const switchSurface = vi.fn();
        cockpitRegistrationState.registration = {
            sessionId: 's1',
            switchSurface,
        };
        const { SessionHeaderTranscriptNavigationButton } = await import('./SessionHeaderTranscriptNavigationButton');

        const screen = await renderScreen(
            <SessionHeaderTranscriptNavigationButton scopeId="session:s1" sessionId="s1" />
        );

        await screen.pressByTestIdAsync('session-header-transcript-navigation-button');

        expect(switchSurface).toHaveBeenCalledWith('navigation');
        expect(openRightSpy).not.toHaveBeenCalled();
        expect(setRightTabSpy).not.toHaveBeenCalled();
    });
});
