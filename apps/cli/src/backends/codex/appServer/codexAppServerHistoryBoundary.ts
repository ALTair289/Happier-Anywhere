type NotificationEnvelope = Readonly<{
    method: string;
    params: unknown;
}>;

type BufferedNotification = Readonly<{
    notification: NotificationEnvelope;
    emit: () => void | Promise<void>;
}>;

type BoundaryPhase = 'hydrating' | 'releasing' | 'live' | 'failed';

const MAX_BUFFERED_NOTIFICATIONS = 4_096;

export class CodexAppServerHistoryBoundaryOverflowError extends Error {
    readonly code = 'codex_app_server_history_boundary_overflow';

    constructor() {
        super('codex_app_server_history_boundary_overflow');
        this.name = 'CodexAppServerHistoryBoundaryOverflowError';
    }
}

/**
 * Owns the app-server boundary between provider history hydration and live notifications.
 * The durable source is Codex's resumed thread snapshot; the retained sets below are
 * process-local indexes rebuilt from that snapshot after every process/client restart.
 */
export class CodexAppServerHistoryBoundary {
    private phase: BoundaryPhase = 'hydrating';
    private bufferedNotifications: BufferedNotification[] = [];
    private failure: Error | null = null;
    private primaryThreadId: string | null = null;
    private readonly hydratedThreadIds = new Set<string>();
    private readonly consumedTurnIdsByScope = new Map<string, Set<string>>();
    private readonly consumedItemIdsByScope = new Map<string, Set<string>>();
    private readonly reservedTerminalTurnIdsByScope = new Map<string, Set<string>>();
    private readonly reservedCompletedItemIdsByScope = new Map<string, Set<string>>();

    beginHydration(): void {
        this.phase = 'hydrating';
        this.bufferedNotifications = [];
        this.failure = null;
        this.primaryThreadId = null;
        this.hydratedThreadIds.clear();
        this.consumedTurnIdsByScope.clear();
        this.consumedItemIdsByScope.clear();
        this.reservedTerminalTurnIdsByScope.clear();
        this.reservedCompletedItemIdsByScope.clear();
    }

    async onNotification(
        notification: NotificationEnvelope,
        emit: () => void | Promise<void>,
    ): Promise<void> {
        if (this.phase === 'failed') {
            throw this.failure ?? new Error('codex_app_server_history_boundary_failed');
        }
        if (this.phase !== 'live') {
            if (this.bufferedNotifications.length >= MAX_BUFFERED_NOTIFICATIONS) {
                const failure = new CodexAppServerHistoryBoundaryOverflowError();
                this.failure = failure;
                this.phase = 'failed';
                this.bufferedNotifications = [];
                throw failure;
            }
            this.bufferedNotifications.push({ notification, emit });
            return;
        }
        await this.emitIfLive(notification, emit);
    }

    async onRequest<T>(
        request: NotificationEnvelope,
        deny: () => T | Promise<T>,
        emit: () => T | Promise<T>,
    ): Promise<T> {
        if (this.phase === 'failed') {
            throw this.failure ?? new Error('codex_app_server_history_boundary_failed');
        }
        // A server request cannot wait in the notification buffer without deadlocking the
        // provider RPC that may be producing the hydration response. Until durable history is
        // authoritative, deny it without invoking any user-facing request path.
        if (this.phase !== 'live' || this.isConsumed(request)) {
            return await deny();
        }
        return await emit();
    }

    async hydrateFromThreadSnapshot(snapshot: unknown): Promise<void> {
        if (this.phase === 'failed') {
            throw this.failure ?? new Error('codex_app_server_history_boundary_failed');
        }
        const primaryThreadId = this.rememberSnapshot(snapshot);
        if (!primaryThreadId) {
            const failure = new Error('codex_app_server_history_identity_unavailable');
            this.failure = failure;
            this.phase = 'failed';
            this.bufferedNotifications = [];
            throw failure;
        }
        this.primaryThreadId = primaryThreadId;
        this.hydratedThreadIds.add(primaryThreadId);
        this.phase = 'releasing';
        while (this.bufferedNotifications.length > 0) {
            const batch = this.bufferedNotifications;
            this.bufferedNotifications = [];
            for (const buffered of batch) {
                const identity = readNotificationIdentity(buffered.notification.params);
                const scope = identity.threadId ?? primaryThreadId;
                // A foreign child scope omitted from the authoritative parent snapshot has no
                // durable boundary. It may be replayed child JSONL, so buffered evidence for that
                // scope fails closed. Once live, a genuinely new child is handled normally.
                if (!this.hydratedThreadIds.has(scope)) continue;
                await this.emitIfLive(buffered.notification, buffered.emit);
            }
        }
        this.phase = 'live';
    }

    hasConsumedTurn(turnId: string, candidateScopes: readonly (string | null | undefined)[]): boolean {
        const scopes = candidateScopes.filter((scope): scope is string => Boolean(scope));
        if (scopes.some((scope) => this.consumedTurnIdsByScope.get(scope)?.has(turnId))) {
            return true;
        }
        if (scopes.length > 0) return false;
        return [...this.consumedTurnIdsByScope.values()].some((ids) => ids.has(turnId));
    }

    rememberConsumedTurn(scope: string | null | undefined, turnId: string | null | undefined): void {
        if (!scope || !turnId) return;
        rememberIdentity(this.consumedTurnIdsByScope, scope, turnId);
    }

    rememberConsumedItem(
        scope: string | null | undefined,
        itemId: string | null | undefined,
        turnId?: string | null,
    ): boolean {
        const resolvedScope = scope ?? this.primaryThreadId;
        if (!resolvedScope || !itemId) return false;
        const itemIdentity = buildItemIdentity(turnId ?? null, itemId);
        const existing = this.consumedItemIdsByScope.get(resolvedScope);
        if (existing?.has(itemIdentity)) return false;
        rememberIdentity(this.consumedItemIdsByScope, resolvedScope, itemIdentity);
        return true;
    }

    private async emitIfLive(
        notification: NotificationEnvelope,
        emit: () => void | Promise<void>,
    ): Promise<void> {
        if (this.isConsumed(notification)) return;

        const identity = readNotificationIdentity(notification.params);
        const scope = identity.threadId ?? this.primaryThreadId;
        const itemIdentity = identity.itemId ? buildItemIdentity(identity.turnId, identity.itemId) : null;
        // Reserve terminal identities synchronously. Notification handlers can overlap while an
        // earlier transcript write awaits, and recording after that await admits duplicates.
        if (notification.method === 'item/completed' && itemIdentity) {
            if (!scope || hasConsumedIdentity(this.reservedCompletedItemIdsByScope, scope, itemIdentity)) return;
            rememberIdentity(this.reservedCompletedItemIdsByScope, scope, itemIdentity);
        }
        if (
            (notification.method === 'turn/completed' || notification.method === 'turn/interrupted')
            && identity.turnId
        ) {
            if (!scope || hasConsumedIdentity(this.reservedTerminalTurnIdsByScope, scope, identity.turnId)) return;
            rememberIdentity(this.reservedTerminalTurnIdsByScope, scope, identity.turnId);
        }

        await emit();
    }

    private isConsumed(notification: NotificationEnvelope): boolean {
        const identity = readNotificationIdentity(notification.params);
        const scope = identity.threadId ?? this.primaryThreadId;
        const itemIdentity = identity.itemId ? buildItemIdentity(identity.turnId, identity.itemId) : null;
        const isTerminalNotification = notification.method === 'turn/completed'
            || notification.method === 'turn/interrupted';
        return Boolean(
            (identity.turnId && this.hasConsumedTurn(identity.turnId, [scope]))
            || (isTerminalNotification && identity.turnId && hasConsumedIdentity(this.reservedTerminalTurnIdsByScope, scope, identity.turnId))
            || (itemIdentity && hasConsumedIdentity(this.consumedItemIdsByScope, scope, itemIdentity))
            || (itemIdentity && hasConsumedIdentity(this.reservedCompletedItemIdsByScope, scope, itemIdentity)),
        );
    }

    private rememberSnapshot(snapshot: unknown): string | null {
        const root = asRecord(snapshot);
        const thread = asRecord(root?.thread);
        const threadId = readNonEmptyString(thread?.id) ?? readNonEmptyString(root?.threadId);
        const turns = [
            ...asArray(thread?.turns),
            ...asArray(root?.turns),
            ...asArray(asRecord(root?.initialTurnsPage)?.data),
        ];
        for (const value of turns) {
            const turn = asRecord(value);
            const turnId = readNonEmptyString(turn?.id);
            const status = readNonEmptyString(turn?.status);
            // Only an explicit in-progress turn remains eligible for post-boundary live evidence.
            // Missing/unknown status fails closed as historical rather than becoming current work.
            if (status !== 'inProgress') {
                this.rememberConsumedTurn(threadId, turnId);
            }
            for (const itemValue of asArray(turn?.items)) {
                const item = asRecord(itemValue);
                const itemId = readNonEmptyString(item?.id);
                if (readNonEmptyString(item?.status) === 'inProgress') {
                    continue;
                }
                this.rememberConsumedItem(threadId, itemId, turnId);
                // Some app-server notifications omit their turn id. Retain a fail-closed wildcard
                // for that incomplete replay identity without making it collide with exact live
                // turn+item identities in later turns.
                if (threadId && itemId) {
                    rememberIdentity(this.consumedItemIdsByScope, threadId, buildItemIdentity(null, itemId));
                }
            }
        }
        return threadId;
    }
}

function buildItemIdentity(turnId: string | null, itemId: string): string {
    return `${turnId ?? '*'}\u0000${itemId}`;
}

function rememberIdentity(target: Map<string, Set<string>>, scope: string, identity: string): void {
    const existing = target.get(scope);
    if (existing) {
        existing.add(identity);
        return;
    }
    target.set(scope, new Set([identity]));
}

function hasConsumedIdentity(
    target: ReadonlyMap<string, ReadonlySet<string>>,
    scope: string | null,
    identity: string,
): boolean {
    if (scope) return target.get(scope)?.has(identity) === true;
    return [...target.values()].some((ids) => ids.has(identity));
}

function readNotificationIdentity(value: unknown): Readonly<{
    threadId: string | null;
    turnId: string | null;
    itemId: string | null;
}> {
    const record = asRecord(value);
    const turn = asRecord(record?.turn);
    const item = asRecord(record?.item);
    return {
        threadId: readNonEmptyString(record?.threadId) ?? readNonEmptyString(record?.thread_id),
        turnId: readNonEmptyString(record?.turnId)
            ?? readNonEmptyString(record?.turn_id)
            ?? readNonEmptyString(turn?.id),
        itemId: readNonEmptyString(record?.itemId)
            ?? readNonEmptyString(record?.item_id)
            ?? readNonEmptyString(item?.id),
    };
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asArray(value: unknown): readonly unknown[] {
    return Array.isArray(value) ? value : [];
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
