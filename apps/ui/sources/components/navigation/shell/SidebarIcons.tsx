import * as React from 'react';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';

type SidebarIconProps = {
    size?: number;
    color?: string;
    /**
     * Which edge the sidebar being controlled lives on.
     *
     * The concept, not the drawing: HugeIcons has dedicated right-edge panel glyphs, while Phosphor
     * only draws the left-edge one and reaches the right by mirroring. Naming the edge lets each
     * family answer it the way it can — the alternative, mirroring everywhere, would flip HugeIcons'
     * purpose-built glyph into a left-facing one.
     */
    edge?: 'left' | 'right';
};

export const SidebarExpandIcon = React.memo(({ size = ICON_SIZE.md, color, edge = 'left' }: SidebarIconProps) => {
    return edge === 'right'
        ? <Icon name="sidebar-right-open" size={size} color={color} mirrored />
        : <Icon name="sidebar-simple" size={size} color={color} />;
});

export const SidebarCollapseIcon = React.memo(({ size = ICON_SIZE.md, color, edge = 'left' }: SidebarIconProps) => {
    return edge === 'right'
        ? <Icon name="sidebar-right-close" size={size} color={color} mirrored />
        : <Icon name="sidebar" size={size} color={color} />;
});
