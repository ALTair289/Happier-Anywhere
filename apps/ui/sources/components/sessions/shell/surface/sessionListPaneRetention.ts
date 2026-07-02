import * as React from 'react';

import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import type { SessionListStorageFilter } from '@/sync/domains/session/sessionStorageKind';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import {
    serverAccountScopeKeySuffix,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

export type RetainedSessionListPaneState = Readonly<{
    sessionListViewData: SessionListViewItem[] | null;
    visibleSessionCount: number;
    hasHiddenInactiveSessions: boolean;
}>;

export function areRetainedSessionListPaneStatesEqual(
    previous: RetainedSessionListPaneState,
    next: RetainedSessionListPaneState,
): boolean {
    return previous.sessionListViewData === next.sessionListViewData
        && previous.visibleSessionCount === next.visibleSessionCount
        && previous.hasHiddenInactiveSessions === next.hasHiddenInactiveSessions;
}

export type SessionListPaneRetentionSnapshot = Readonly<{
    activeSessionId: string | null;
    paneState: RetainedSessionListPaneState;
    pathname: string;
    sourceScopeKey: string;
    storageKind: string;
}>;

type SessionListPaneRetentionIdentity = Readonly<{
    pathname?: string | null;
    sourceScopeKey?: string | null;
    storageKind?: SessionListStorageFilter | string | null;
}>;

type SessionListPaneRetentionSelection = Readonly<{
    activeServerId?: string | null;
    allowedServerIds?: ReadonlyArray<string> | null;
    enabled?: boolean | null;
    presentation?: string | null;
    activeTarget?: Readonly<{
        kind?: string | null;
        id?: string | null;
        serverId?: string | null;
        groupId?: string | null;
        serverIds?: ReadonlyArray<string> | null;
    }> | null;
}>;

const retainedPaneSnapshotsByKey = new Map<string, SessionListPaneRetentionSnapshot>();

function normalizeRetentionPathname(pathname: string | null | undefined): string {
    const normalized = typeof pathname === 'string' ? pathname.trim() : '';
    return normalized || '/';
}

function normalizeRetentionStorageKind(storageKind: SessionListStorageFilter | string | null | undefined): string {
    const normalized = typeof storageKind === 'string' ? storageKind.trim() : '';
    return normalized || 'all';
}

function normalizeRetentionSourceScopeKey(sourceScopeKey: string | null | undefined): string {
    const normalized = typeof sourceScopeKey === 'string' ? sourceScopeKey.trim() : '';
    return normalized || 'source:default';
}

function normalizeSourceScopePart(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function encodeSourceScopePart(value: unknown): string {
    const normalized = normalizeSourceScopePart(value);
    return `${normalized.length}:${normalized}`;
}

function encodeSourceScopeList(values: ReadonlyArray<string> | null | undefined): string {
    if (!Array.isArray(values)) return '0:';
    return values
        .map((value) => normalizeSourceScopePart(value))
        .filter((value) => value.length > 0)
        .map(encodeSourceScopePart)
        .join('');
}

function buildActiveTargetScopeKey(target: SessionListPaneRetentionSelection['activeTarget']): string {
    if (!target) return 'none';
    return [
        encodeSourceScopePart(target.kind),
        encodeSourceScopePart(target.id),
        encodeSourceScopePart(target.serverId),
        encodeSourceScopePart(target.groupId),
        encodeSourceScopeList(target.serverIds),
    ].join('');
}

function buildSessionListPaneRetentionKey(identity: SessionListPaneRetentionIdentity): string {
    return [
        normalizeRetentionStorageKind(identity.storageKind),
        normalizeRetentionPathname(identity.pathname),
        normalizeRetentionSourceScopeKey(identity.sourceScopeKey),
    ].join('\u0000');
}

export function buildSessionListPaneSourceScopeKey(params: Readonly<{
    accountScope?: ServerAccountScope | null;
    selection?: SessionListPaneRetentionSelection | null;
}>): string {
    const selection = params.selection;
    const accountScopeKey = params.accountScope
        ? serverAccountScopeKeySuffix(params.accountScope)
        : 'none';
    return [
        `account:${accountScopeKey}`,
        `selection:${selection?.enabled === true ? 'enabled' : 'single'}`,
        `active:${encodeSourceScopePart(selection?.activeServerId)}`,
        `allowed:${encodeSourceScopeList(selection?.allowedServerIds)}`,
        `presentation:${encodeSourceScopePart(selection?.presentation)}`,
        `target:${buildActiveTargetScopeKey(selection?.activeTarget)}`,
    ].join('|');
}

export function useSessionListPaneSourceScopeKey(): string {
    const selection = useResolvedActiveServerSelection();
    const accountScope = useActiveServerAccountScope();
    return React.useMemo(
        () => buildSessionListPaneSourceScopeKey({
            accountScope,
            selection,
        }),
        [accountScope, selection],
    );
}

function isRetainablePaneState(paneState: RetainedSessionListPaneState): boolean {
    return paneState.sessionListViewData !== null;
}

export function readRetainedSessionListPaneSnapshot(
    identity: SessionListPaneRetentionIdentity,
): SessionListPaneRetentionSnapshot | null {
    return retainedPaneSnapshotsByKey.get(buildSessionListPaneRetentionKey(identity)) ?? null;
}

export function retainSessionListPaneSnapshot(params: SessionListPaneRetentionIdentity & Readonly<{
    activeSessionId: string | null;
    paneState: RetainedSessionListPaneState;
}>): void {
    if (!isRetainablePaneState(params.paneState)) return;
    const pathname = normalizeRetentionPathname(params.pathname);
    const sourceScopeKey = normalizeRetentionSourceScopeKey(params.sourceScopeKey);
    const storageKind = normalizeRetentionStorageKind(params.storageKind);
    retainedPaneSnapshotsByKey.set(buildSessionListPaneRetentionKey({ pathname, sourceScopeKey, storageKind }), {
        activeSessionId: params.activeSessionId,
        paneState: params.paneState,
        pathname,
        sourceScopeKey,
        storageKind,
    });
}

export function updateRetainedSessionListPaneActiveSessionId(
    identity: SessionListPaneRetentionIdentity,
    activeSessionId: string | null,
): void {
    const key = buildSessionListPaneRetentionKey(identity);
    const retained = retainedPaneSnapshotsByKey.get(key);
    if (!retained || retained.activeSessionId === activeSessionId) return;
    retainedPaneSnapshotsByKey.set(key, {
        ...retained,
        activeSessionId,
    });
}

export function resetSessionListPaneRetentionForTests(): void {
    retainedPaneSnapshotsByKey.clear();
}
