import {
    loadPersistedAgentInputLocalUiState,
    savePersistedAgentInputLocalUiState,
} from '@/sync/domains/state/agentInputLocalUiStatePersistence';
import { agentInputLocalUiStateStorageKey } from '@/sync/domains/state/sessionLocalStateKeys';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type AgentInputDraftOwner =
    | Readonly<{ kind: 'session'; sessionId: string }>
    | Readonly<{ kind: 'newSession'; flowId: string }>;

export type AgentInputTextSelection = Readonly<{
    start: number;
    end: number;
}>;

export type AgentInputLocalUiStateV1 = Readonly<{
    v: 1;
    expanded?: boolean;
    scrollY?: number;
    selection?: AgentInputTextSelection;
    textLength?: number;
    fontScale?: number;
    updatedAt: number;
}>;

type ScopeCache = {
    values: Record<string, AgentInputLocalUiStateV1>;
    dirty: boolean;
};

const AGENT_INPUT_LOCAL_UI_STATE_TTL_DAYS = 7;
const AGENT_INPUT_SCROLL_TEXT_LENGTH_DRIFT_RATIO = 0.5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const cachesByScopeKey = new Map<string, ScopeCache>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
    const numberValue = finiteNumber(value);
    if (numberValue === null || !Number.isInteger(numberValue) || numberValue < 0) return null;
    return numberValue;
}

function nonNegativeFiniteNumber(value: unknown): number | null {
    const numberValue = finiteNumber(value);
    return numberValue !== null && numberValue >= 0 ? numberValue : null;
}

function positiveFiniteNumber(value: unknown): number | null {
    const numberValue = finiteNumber(value);
    return numberValue !== null && numberValue > 0 ? numberValue : null;
}

function areJsonValuesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function normalizeOwnerId(value: string): string | null {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function agentInputDraftOwnerKey(owner: AgentInputDraftOwner | null | undefined): string | null {
    if (!owner) return null;
    if (owner.kind === 'session') {
        const sessionId = normalizeOwnerId(owner.sessionId);
        return sessionId ? `session:${sessionId}` : null;
    }
    const flowId = normalizeOwnerId(owner.flowId);
    return flowId ? `new-session:${flowId}` : null;
}

function isSupportedAgentInputDraftOwnerKey(ownerKey: string): boolean {
    if (ownerKey.startsWith('session:')) {
        const sessionId = normalizeOwnerId(ownerKey.slice('session:'.length));
        return Boolean(sessionId) && ownerKey === `session:${sessionId}`;
    }
    if (ownerKey.startsWith('new-session:')) {
        const flowId = normalizeOwnerId(ownerKey.slice('new-session:'.length));
        return Boolean(flowId) && ownerKey === `new-session:${flowId}`;
    }
    return false;
}

function parseSelection(value: unknown): AgentInputTextSelection | undefined {
    if (!isRecord(value)) return undefined;
    const start = nonNegativeInteger(value.start);
    const end = nonNegativeInteger(value.end);
    if (start === null || end === null || end < start) return undefined;
    return { start, end };
}

function sanitizeState(value: unknown): AgentInputLocalUiStateV1 | null {
    if (!isRecord(value) || value.v !== 1) return null;
    const updatedAt = finiteNumber(value.updatedAt);
    if (updatedAt === null) return null;

    const expanded = typeof value.expanded === 'boolean' ? value.expanded : undefined;
    const scrollY = nonNegativeFiniteNumber(value.scrollY);
    const selection = parseSelection(value.selection);
    const textLength = nonNegativeInteger(value.textLength);
    const fontScale = positiveFiniteNumber(value.fontScale);

    const state: AgentInputLocalUiStateV1 = {
        v: 1,
        ...(typeof expanded === 'boolean' ? { expanded } : {}),
        ...(scrollY !== null ? { scrollY } : {}),
        ...(selection ? { selection } : {}),
        ...(textLength !== null ? { textLength } : {}),
        ...(fontScale !== null ? { fontScale } : {}),
        updatedAt,
    };
    if (
        typeof state.expanded !== 'boolean'
        && typeof state.scrollY !== 'number'
        && typeof state.selection === 'undefined'
        && typeof state.textLength !== 'number'
        && typeof state.fontScale !== 'number'
    ) {
        return null;
    }
    return state;
}

function sanitizeMap(input: Record<string, unknown>): {
    values: Record<string, AgentInputLocalUiStateV1>;
    changed: boolean;
} {
    const values: Record<string, AgentInputLocalUiStateV1> = {};
    let changed = false;
    for (const [ownerKey, rawState] of Object.entries(input)) {
        if (!isSupportedAgentInputDraftOwnerKey(ownerKey)) {
            changed = true;
            continue;
        }
        const state = sanitizeState(rawState);
        if (!state) {
            changed = true;
            continue;
        }
        values[ownerKey] = state;
        if (!areJsonValuesEqual(rawState, state)) {
            changed = true;
        }
    }
    return { values, changed };
}

function getCacheKey(scope?: ServerAccountScope | null): string {
    return agentInputLocalUiStateStorageKey(scope);
}

function getScopeCache(scope?: ServerAccountScope | null): ScopeCache {
    const key = getCacheKey(scope);
    const existing = cachesByScopeKey.get(key);
    if (existing) return existing;
    const sanitized = sanitizeMap(loadPersistedAgentInputLocalUiState(scope));
    const cache = {
        values: sanitized.values,
        dirty: sanitized.changed,
    };
    cachesByScopeKey.set(key, cache);
    return cache;
}

function clampSelection(selection: AgentInputTextSelection | undefined, textLength: number | undefined): AgentInputTextSelection | undefined {
    if (!selection || typeof textLength !== 'number') return selection;
    const clampedStart = Math.min(selection.start, textLength);
    const clampedEnd = Math.min(selection.end, textLength);
    return {
        start: Math.min(clampedStart, clampedEnd),
        end: Math.max(clampedStart, clampedEnd),
    };
}

function shouldDropScrollY(
    state: AgentInputLocalUiStateV1,
    options: Readonly<{ textLength?: number; fontScale?: number }> | undefined,
): boolean {
    if (typeof state.scrollY !== 'number') return false;
    if (typeof options?.fontScale === 'number' && typeof state.fontScale === 'number' && options.fontScale !== state.fontScale) {
        return true;
    }
    if (typeof options?.textLength !== 'number' || typeof state.textLength !== 'number') {
        return false;
    }
    if (state.textLength === 0) return options.textLength !== 0;
    return Math.abs(options.textLength - state.textLength) / state.textLength > AGENT_INPUT_SCROLL_TEXT_LENGTH_DRIFT_RATIO;
}

/**
 * Whether the persisted state's text basis matches the live text closely
 * enough for its transient payload (scroll/selection) to be applied. On
 * session open the composer mounts before the draft text is adopted (live
 * textLength 0 vs persisted textLength N), so the payload is withheld or
 * clamped; restore consumers use this predicate to know when the basis has
 * been adopted. Uses the same drift tolerance as the scrollY guard above.
 */
export function isAgentInputLocalUiStateTextBasisApplicable(
    state: AgentInputLocalUiStateV1 | null,
    textLength: number | undefined,
): boolean {
    if (!state) return true;
    if (typeof textLength !== 'number' || typeof state.textLength !== 'number') return true;
    if (state.textLength === 0) return textLength === 0;
    return Math.abs(textLength - state.textLength) / state.textLength <= AGENT_INPUT_SCROLL_TEXT_LENGTH_DRIFT_RATIO;
}

export function readAgentInputLocalUiState(
    scope: ServerAccountScope | null | undefined,
    owner: AgentInputDraftOwner,
    options?: Readonly<{ textLength?: number; fontScale?: number }>,
): AgentInputLocalUiStateV1 | null {
    const ownerKey = agentInputDraftOwnerKey(owner);
    if (!ownerKey) return null;
    const cache = getScopeCache(scope);
    const state = cache.values[ownerKey];
    if (!state) return null;

    // The transient payload (scroll + selection) only means anything against the text it
    // was captured for. On session open the composer mounts empty and adopts the draft a
    // commit later, so this is read with textLength 0 first. Returning a CLAMPED selection
    // there produced a truthy {0,0} that consumers restored as "caret at start" — and that
    // programmatic apply echoed back through onSelectionChangePersist, overwriting the
    // stored basis with textLength 0 and destroying the real scroll/selection before the
    // draft ever loaded. Withhold the selection on a non-applicable basis, exactly as
    // scrollY already is, so the payload survives until the basis is adopted.
    const basisApplies = isAgentInputLocalUiStateTextBasisApplicable(state, options?.textLength);
    const nextState: AgentInputLocalUiStateV1 = {
        ...state,
        ...(shouldDropScrollY(state, options) ? { scrollY: undefined } : {}),
        selection: basisApplies ? clampSelection(state.selection, options?.textLength) : undefined,
    };
    if (typeof nextState.scrollY === 'undefined') {
        const { scrollY: _scrollY, ...withoutScroll } = nextState;
        return withoutScroll;
    }
    return nextState;
}

export function patchAgentInputLocalUiState(
    scope: ServerAccountScope | null | undefined,
    owner: AgentInputDraftOwner,
    patch: Readonly<{
        expanded?: boolean;
        scrollY?: number;
        selection?: AgentInputTextSelection;
        textLength?: number;
        fontScale?: number;
    }>,
    options: Readonly<{ now?: number; flush?: boolean }> = {},
): void {
    const ownerKey = agentInputDraftOwnerKey(owner);
    if (!ownerKey) return;
    const cache = getScopeCache(scope);
    const previous = cache.values[ownerKey];
    if (previous) {
        const candidate = sanitizeState({
            ...previous,
            ...patch,
            v: 1,
            updatedAt: previous.updatedAt,
        });
        if (candidate && areJsonValuesEqual(previous, candidate)) return;
    }
    const next = sanitizeState({
        ...(previous ?? {}),
        ...patch,
        v: 1,
        updatedAt: options.now ?? Date.now(),
    });
    if (!next || (previous && areJsonValuesEqual(previous, next))) return;
    cache.values[ownerKey] = next;
    cache.dirty = true;
    if (options.flush !== false) {
        flushAgentInputLocalUiState(scope);
    }
}

export function clearAgentInputLocalUiState(
    scope: ServerAccountScope | null | undefined,
    owner: AgentInputDraftOwner,
    options: Readonly<{ flush?: boolean }> = {},
): void {
    const ownerKey = agentInputDraftOwnerKey(owner);
    if (!ownerKey) return;
    const cache = getScopeCache(scope);
    if (!cache.values[ownerKey]) return;
    delete cache.values[ownerKey];
    cache.dirty = true;
    if (options.flush !== false) {
        flushAgentInputLocalUiState(scope);
    }
}

export function clearAgentInputLocalUiStateForSession(
    scope: ServerAccountScope | null | undefined,
    sessionId: string,
    options: Readonly<{ flush?: boolean }> = {},
): void {
    clearAgentInputLocalUiState(scope, { kind: 'session', sessionId }, options);
}

export function clearAgentInputLocalUiStateForNewSession(
    scope: ServerAccountScope | null | undefined,
    flowId: string,
    options: Readonly<{ flush?: boolean }> = {},
): void {
    clearAgentInputLocalUiState(scope, { kind: 'newSession', flowId }, options);
}

export function garbageCollectAgentInputLocalUiState(
    scope: ServerAccountScope | null | undefined,
    options: Readonly<{ now: number; reason: 'scopeActivated' | 'foreground' | 'idle'; flush?: boolean }>,
): void {
    const cache = getScopeCache(scope);
    let changed = false;
    for (const [ownerKey, state] of Object.entries(cache.values)) {
        if (options.now - state.updatedAt > AGENT_INPUT_LOCAL_UI_STATE_TTL_DAYS * MS_PER_DAY) {
            delete cache.values[ownerKey];
            changed = true;
        }
    }
    if (!changed) return;
    cache.dirty = true;
    if (options.flush !== false) {
        flushAgentInputLocalUiState(scope);
    }
}

export function flushAgentInputLocalUiState(scope?: ServerAccountScope | null): void {
    const cache = getScopeCache(scope);
    if (!cache.dirty) return;
    savePersistedAgentInputLocalUiState(cache.values, scope);
    cache.dirty = false;
}

export function invalidateAgentInputLocalUiStateCache(scope?: ServerAccountScope | null): void {
    cachesByScopeKey.delete(getCacheKey(scope));
}

export function resetAgentInputLocalUiStateCachesForTests(): void {
    cachesByScopeKey.clear();
}
