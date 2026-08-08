import { log } from '@/log';
import type { SyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { recordNativeCryptoWorkerFallback } from './nativeCryptoWorkerTelemetry';
import {
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    type NativeCryptoWorkerFallbackReason,
    type NativeCryptoWorkerOperation,
} from './types';

/**
 * Single owner for "native crypto degraded to the JS reference path" visibility.
 *
 * The native worker routes in `auto` mode, so a build whose `HappierCryptoWorker`
 * module is missing, stale, or broken silently runs every envelope open and every
 * payload decrypt on the JS thread. Degradation is therefore recorded here
 * unconditionally (counters + a first-occurrence log line per operation/reason,
 * at most one line per distinct degradation for the life of the process), and
 * verbosely when routing enables `logFallbacks`.
 */

const FALLBACK_REASONS: readonly NativeCryptoWorkerFallbackReason[] = Object.values(
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
);

export type NativeCryptoWorkerFallbackDiagnostics = Readonly<{
    totalFallbacks: number;
    countsByReason: Readonly<Record<NativeCryptoWorkerFallbackReason, number>>;
    lastReason: NativeCryptoWorkerFallbackReason | null;
    lastOperation: NativeCryptoWorkerOperation | null;
    lastFailureReason: number | null;
    lastDetail: string | null;
}>;

export type ReportNativeCryptoWorkerFallbackParams = Readonly<{
    operation: NativeCryptoWorkerOperation;
    reason: NativeCryptoWorkerFallbackReason;
    itemCount: number;
    payloadBytes: number;
    failureReason?: number | null;
    error?: unknown;
    /** Routing `logFallbacks`: log every degraded batch instead of only the first of its kind. */
    verbose?: boolean;
    telemetry?: SyncPerformanceTelemetry;
    telemetryEnabled?: boolean;
}>;

function createEmptyCounts(): Record<NativeCryptoWorkerFallbackReason, number> {
    return FALLBACK_REASONS.reduce((counts, reason) => {
        counts[reason] = 0;
        return counts;
    }, {} as Record<NativeCryptoWorkerFallbackReason, number>);
}

let totalFallbacks = 0;
let countsByReason = createEmptyCounts();
let lastReason: NativeCryptoWorkerFallbackReason | null = null;
let lastOperation: NativeCryptoWorkerOperation | null = null;
let lastFailureReason: number | null = null;
let lastDetail: string | null = null;
let loggedKinds = new Set<string>();

function describeError(error: unknown): string | null {
    if (error === undefined || error === null) return null;
    const message = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : typeof (error as { message?: unknown }).message === 'string'
                ? (error as { message: string }).message
                : String(error);
    const normalized = message.replace(/\s+/gu, ' ').trim();
    return normalized ? normalized.slice(0, 200) : null;
}

export function reportNativeCryptoWorkerFallback(params: ReportNativeCryptoWorkerFallbackParams): void {
    if (params.failureReason === NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unsupportedPlatform) {
        // Not a degradation: this platform has no native worker, so the JS path is
        // the intended implementation. Reporting it would bury the real signal.
        return;
    }

    totalFallbacks += 1;
    countsByReason[params.reason] += 1;
    lastReason = params.reason;
    lastOperation = params.operation;
    lastFailureReason = typeof params.failureReason === 'number' ? params.failureReason : null;
    lastDetail = describeError(params.error);

    const kind = `${params.operation}:${params.reason}`;
    const isFirstOfKind = !loggedKinds.has(kind);
    if (isFirstOfKind) {
        loggedKinds.add(kind);
    }
    if (isFirstOfKind || params.verbose === true) {
        const parts = [
            `⚠️ native crypto worker fell back to JS: operation=${params.operation}`,
            `reason=${params.reason}`,
            `items=${params.itemCount}`,
            `payloadBytes=${params.payloadBytes}`,
            `occurrences=${countsByReason[params.reason]}`,
        ];
        if (lastFailureReason !== null) parts.push(`failureReason=${lastFailureReason}`);
        if (lastDetail) parts.push(`detail=${lastDetail}`);
        log.log(parts.join(' '));
    }

    if (params.telemetryEnabled === true && params.telemetry) {
        recordNativeCryptoWorkerFallback(params.telemetry, {
            operation: params.operation,
            reason: params.reason,
            items: params.itemCount,
            payloadBytes: params.payloadBytes,
            failureReason: lastFailureReason ?? 0,
        });
    }
}

export function readNativeCryptoWorkerFallbackDiagnostics(): NativeCryptoWorkerFallbackDiagnostics {
    return {
        totalFallbacks,
        countsByReason: { ...countsByReason },
        lastReason,
        lastOperation,
        lastFailureReason,
        lastDetail,
    };
}

export function resetNativeCryptoWorkerFallbackDiagnosticsForTests(): void {
    totalFallbacks = 0;
    countsByReason = createEmptyCounts();
    lastReason = null;
    lastOperation = null;
    lastFailureReason = null;
    lastDetail = null;
    loggedKinds = new Set<string>();
}
