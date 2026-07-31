import * as React from 'react';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { useSessionMetadata, useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { resolveGitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { CockpitTabBar, type CockpitTabBarTabDefinition } from './CockpitTabBar';

type SessionCockpitTabBarProps = Readonly<{
    sessionId: string;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    onSurfacePress: (surface: SessionMobileSurface) => void;
}>;

type SessionCockpitTabDefinition = Readonly<{
    id: SessionMobileSurface;
    label: string;
    icon: CockpitTabBarTabDefinition<SessionMobileSurface>['icon'];
    badge?: CockpitTabBarTabDefinition<SessionMobileSurface>['badge'];
}>;

export const SessionCockpitTabBar = React.memo((props: SessionCockpitTabBarProps) => {
    const sessionMetadata = useSessionMetadata(props.sessionId);
    const scmStatus = useSessionProjectScmStatus(props.sessionId);
    const gitBadgeMode = useSetting('tabBarGitBadgeMode');
    const openTabsBadgeEnabled = useSetting('tabBarOpenTabsBadgeEnabled');
    const chatAgentId =
        resolveAgentIdFromSessionMetadata(sessionMetadata)
        ?? resolveAgentIdFromFlavor(sessionMetadata?.flavor)
        ?? DEFAULT_AGENT_ID;
    const gitBadge = resolveGitTabBadge(gitBadgeMode, scmStatus);
    const tabs: readonly SessionCockpitTabDefinition[] = [
        {
            id: 'chat',
            label: t(getAgentCore(chatAgentId).displayNameKey),
            icon: {
                render: ({ size, active }) => (
                    <AgentIcon
                        agentId={chatAgentId}
                        size={size}
                        style={{ opacity: active ? 1 : 0.68 }}
                        testID="session-cockpit-tab-chat-agent-icon"
                    />
                ),
            },
        },
        { id: 'browse', label: t('common.files'), icon: 'folder' },
        {
            id: 'git',
            label: t('session.rightPanel.tabs.git'),
            icon: 'git-branch',
            badge: gitBadge ?? undefined,
        },
        { id: 'navigation', label: t('session.transcriptNavigation.title'), icon: 'list' },
        {
            id: 'tabs',
            label: t('workspaceCockpit.tabs'),
            icon: 'stack',
            badge: openTabsBadgeEnabled && props.openDetailsTabCount > 0
                ? { kind: 'count', value: props.openDetailsTabCount }
                : undefined,
        },
        ...(props.terminalTabAvailable
            ? [{ id: 'terminal', label: t('settings.terminal'), icon: 'terminal' } satisfies SessionCockpitTabDefinition]
            : []),
    ];

    return (
        <CockpitTabBar
            activeSurface={props.activeSurface}
            barTestId={`session-cockpit-tabbar-${props.sessionId}`}
            tabs={tabs}
            tabTestIdPrefix="session-cockpit-tab-"
            onSurfacePress={props.onSurfacePress}
        />
    );
});
