/**
 * Per-session leading+trailing rate limiter for targeted session shell
 * refreshes.
 *
 * Used by the socket durable-message path when a hidden session receives a
 * message whose fan-out payload lacks `attentionImpact` (legacy servers only —
 * current servers always attach it, see the server-side
 * `serializeUpdateMessage` fallback). The first request per session triggers
 * immediately; further requests within `floorMs` collapse into one trailing
 * trigger at floor expiry, which guarantees convergence for messages that
 * arrive while a refresh is already underway.
 */
type SessionShellRefreshEntry = {
    lastTriggeredAtMs: number;
    trailingTimer: ReturnType<typeof setTimeout> | null;
};

export type SessionShellRefreshCoalescer = Readonly<{
    request: (sessionId: string) => void;
    reset: () => void;
}>;

export function createSessionShellRefreshCoalescer(params: Readonly<{
    floorMs: number;
    trigger: (sessionId: string) => void;
}>): SessionShellRefreshCoalescer {
    const entries = new Map<string, SessionShellRefreshEntry>();

    const triggerNow = (sessionId: string, entry: SessionShellRefreshEntry): void => {
        entry.lastTriggeredAtMs = Date.now();
        params.trigger(sessionId);
    };

    return {
        request: (sessionId: string) => {
            const existing = entries.get(sessionId);
            if (!existing) {
                const entry: SessionShellRefreshEntry = { lastTriggeredAtMs: 0, trailingTimer: null };
                entries.set(sessionId, entry);
                triggerNow(sessionId, entry);
                return;
            }

            const elapsedMs = Date.now() - existing.lastTriggeredAtMs;
            if (elapsedMs >= params.floorMs) {
                if (existing.trailingTimer) {
                    clearTimeout(existing.trailingTimer);
                    existing.trailingTimer = null;
                }
                triggerNow(sessionId, existing);
                return;
            }

            if (existing.trailingTimer) return;
            existing.trailingTimer = setTimeout(() => {
                existing.trailingTimer = null;
                triggerNow(sessionId, existing);
            }, Math.max(0, params.floorMs - elapsedMs));
        },
        reset: () => {
            for (const entry of entries.values()) {
                if (entry.trailingTimer) {
                    clearTimeout(entry.trailingTimer);
                }
            }
            entries.clear();
        },
    };
}
