import React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';

import { sessionTagKey } from './sessionTagUtils';

const EMPTY_SEARCH_TEXT_BY_SESSION_KEY: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_SESSION_KEYS: ReadonlyArray<SessionSearchKey> = Object.freeze([]);

export type SessionSearchKey = Readonly<{
    serverId: string;
    sessionId: string;
    key: string;
}>;

function readMessageText(message: Message): string | null {
    if (message.kind === 'user-text') {
        return message.displayText ?? message.text;
    }
    if (message.kind === 'agent-text') return message.text;
    if (message.kind === 'tool-call') {
        return message.tool.description ?? null;
    }
    return null;
}

function appendText(parts: string[], value: string | null | undefined): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length > 0) parts.push(trimmed);
}

function collectSessionKeys(items: ReadonlyArray<SessionListViewItem>): ReadonlyArray<SessionSearchKey> {
    const keys: SessionSearchKey[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (item.type !== 'session') continue;
        const serverId = String(item.serverId ?? '').trim();
        const sessionId = String(item.session?.id ?? '').trim();
        if (!serverId || !sessionId) continue;
        const key = sessionTagKey(serverId, sessionId);
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push({ serverId, sessionId, key });
    }
    return keys;
}

function findSessionKey(
    items: ReadonlyArray<SessionListViewItem>,
    targetSessionId: string,
): SessionSearchKey | null {
    for (const item of items) {
        if (item.type !== 'session') continue;
        const serverId = String(item.serverId ?? '').trim();
        const sessionId = String(item.session?.id ?? '').trim();
        if (!serverId || sessionId !== targetSessionId) continue;
        return { serverId, sessionId, key: sessionTagKey(serverId, sessionId) };
    }
    return null;
}

function useIncrementalSessionKeys(
    items: ReadonlyArray<SessionListViewItem>,
): ReadonlyArray<SessionSearchKey> {
    const delta = getStorage()((state) => state.sessionListRenderableDelta);
    const cacheRef = React.useRef<{
        items: ReadonlyArray<SessionListViewItem> | null;
        deltaRevision: number | null;
        keys: ReadonlyArray<SessionSearchKey>;
        keyBySessionId: Map<string, SessionSearchKey>;
    }>({
        items: null,
        deltaRevision: null,
        keys: EMPTY_SESSION_KEYS,
        keyBySessionId: new Map(),
    });
    const cache = cacheRef.current;

    if (items === cache.items && (delta?.revision ?? null) === cache.deltaRevision) {
        return cache.keys;
    }

    const canApplyDelta = delta
        && cache.items !== null
        && cache.deltaRevision !== null
        && delta.revision !== cache.deltaRevision
        && delta.rebuiltSessionListViewData !== true;
    if (canApplyDelta) {
        let changed = false;
        const nextBySessionId = new Map(cache.keyBySessionId);
        for (const sessionId of delta.removedSessionIds) {
            changed = nextBySessionId.delete(sessionId) || changed;
        }
        for (const sessionId of delta.changedSessionIds) {
            if (!nextBySessionId.has(sessionId)) {
                const entry = findSessionKey(items, sessionId);
                if (!entry) {
                    cache.items = items;
                    cache.deltaRevision = delta.revision;
                    cache.keys = collectSessionKeys(items);
                    cache.keyBySessionId = new Map(cache.keys.map((key) => [key.sessionId, key]));
                    return cache.keys;
                }
                nextBySessionId.set(sessionId, entry);
                changed = true;
            }
        }
        cache.items = items;
        cache.deltaRevision = delta.revision;
        if (changed) {
            cache.keys = cache.keys
                .filter((entry) => nextBySessionId.has(entry.sessionId))
                .concat(
                    Array.from(nextBySessionId.values()).filter((entry) => !cache.keyBySessionId.has(entry.sessionId)),
                );
            cache.keyBySessionId = nextBySessionId;
        }
        return cache.keys;
    }

    cache.items = items;
    cache.deltaRevision = delta?.revision ?? null;
    cache.keys = collectSessionKeys(items);
    cache.keyBySessionId = new Map(cache.keys.map((key) => [key.sessionId, key]));
    return cache.keys;
}

function buildSearchTextForSession(state: StorageState, sessionId: string): string | null {
    const parts: string[] = [];
    const committed = state.sessionMessages[sessionId];
    if (committed) {
        const ids = committed.messageIdsOldestFirst;
        const messages = Array.isArray(ids) && ids.length > 0
            ? ids.map((id) => committed.messagesById[id]).filter((message): message is Message => message != null)
            : Object.values(committed.messagesById ?? {});
        for (const message of messages) {
            appendText(parts, readMessageText(message));
        }
    }

    const pending = state.sessionPending[sessionId];
    for (const pendingMessage of (pending?.messages ?? []) as PendingMessage[]) {
        appendText(parts, pendingMessage.displayText ?? pendingMessage.text);
    }
    for (const discardedMessage of (pending?.discarded ?? []) as PendingMessage[]) {
        appendText(parts, discardedMessage.displayText ?? discardedMessage.text);
    }

    return parts.length > 0 ? parts.join('\n') : null;
}

export function createSessionListSearchTextSelector(sessionKeys: ReadonlyArray<SessionSearchKey>) {
    let previousDeltaRevision: number | null = null;
    let previousByKey: Readonly<Record<string, string>> = EMPTY_SEARCH_TEXT_BY_SESSION_KEY;
    const keyBySessionId = new Map(sessionKeys.map((entry) => [entry.sessionId, entry.key]));

    return (state: StorageState): Readonly<Record<string, string>> => {
        const delta = state.sessionListRenderableDelta;
        const canApplyDelta = delta
            && previousDeltaRevision !== null
            && delta.revision !== previousDeltaRevision
            && delta.rebuiltSessionListViewData !== true;
        if (canApplyDelta) {
            let changed = false;
            const next: Record<string, string> = { ...previousByKey };
            for (const sessionId of delta.removedSessionIds) {
                const key = keyBySessionId.get(sessionId);
                if (key && Object.prototype.hasOwnProperty.call(next, key)) {
                    delete next[key];
                    changed = true;
                }
            }
            for (const sessionId of delta.changedSessionIds) {
                const key = keyBySessionId.get(sessionId);
                if (!key) continue;
                const text = buildSearchTextForSession(state, sessionId);
                if (text) {
                    if (next[key] !== text) {
                        next[key] = text;
                        changed = true;
                    }
                } else if (Object.prototype.hasOwnProperty.call(next, key)) {
                    delete next[key];
                    changed = true;
                }
            }
            previousDeltaRevision = delta.revision;
            if (!changed) return previousByKey;
            previousByKey = Object.keys(next).length > 0 ? next : EMPTY_SEARCH_TEXT_BY_SESSION_KEY;
            return previousByKey;
        }

        const out: Record<string, string> = {};
        for (const entry of sessionKeys) {
            const text = buildSearchTextForSession(state, entry.sessionId);
            if (text) out[entry.key] = text;
        }
        previousDeltaRevision = delta?.revision ?? null;
        previousByKey = Object.keys(out).length > 0 ? out : EMPTY_SEARCH_TEXT_BY_SESSION_KEY;
        return previousByKey;
    };
}

export function useSessionListSearchTextByKey(
    items: ReadonlyArray<SessionListViewItem>,
    enabled: boolean,
): Readonly<Record<string, string>> {
    const sessionKeys = useIncrementalSessionKeys(items);
    const selector = React.useMemo(
        () => createSessionListSearchTextSelector(sessionKeys),
        [sessionKeys],
    );
    return getStorage()(useShallow((state) => {
        if (!enabled || sessionKeys.length === 0) return EMPTY_SEARCH_TEXT_BY_SESSION_KEY;
        return selector(state);
    }));
}
