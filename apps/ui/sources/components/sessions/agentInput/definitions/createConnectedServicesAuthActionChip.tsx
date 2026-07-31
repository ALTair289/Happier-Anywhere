import * as React from 'react';
import { Platform, Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputPopoverContent } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE, AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

export function createConnectedServicesAuthActionChip(params: Readonly<{
    key?: string;
    testID?: string;
    label: string;
    authSource?: 'native' | 'connected';
    connectedCount: number;
    popoverContent: AgentInputPopoverContent;
    maxHeightCap?: number;
    maxWidthCap?: number;
}>): AgentInputExtraActionChip {
    const testID = params.testID ?? 'new-session-connected-services-auth-chip';
    const webStateProps = Platform.OS === 'web' && params.authSource
        ? ({ dataSet: { authSource: params.authSource } } as const)
        : undefined;

    return {
        key: params.key ?? 'new-session-connected-services-auth',
        controlId: 'connectedServices',
        collapsedContentPopover: {
            title: params.label,
            label: params.label,
            icon: (tint: string) =>
                normalizeNodeForView(<Icon name="key" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />),
            renderContent: params.popoverContent,
            maxHeightCap: params.maxHeightCap,
            maxWidthCap: params.maxWidthCap,
            scrollEnabled: false,
        },
        render: ({ chipStyle, iconColor, showLabel, textStyle, countTextStyle, chipAnchorRef, toggleCollapsedPopover }) => (
            <Pressable
                ref={chipAnchorRef}
                testID={testID}
                {...webStateProps}
                onPress={() => toggleCollapsedPopover?.(params.key ?? 'new-session-connected-services-auth')}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
            >
                {normalizeNodeForView(<Icon name="key" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={iconColor} style={AGENT_INPUT_CHIP_ICON_STYLE} />)}
                {showLabel ? (
                    <AgentInputChipLabel
                        label={params.label}
                        count={params.connectedCount}
                        textStyle={textStyle}
                        countTextStyle={countTextStyle}
                    />
                ) : null}
            </Pressable>
        ),
    };
}
