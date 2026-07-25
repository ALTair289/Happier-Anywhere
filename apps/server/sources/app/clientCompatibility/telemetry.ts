import { CURRENT_SESSION_SYNC_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { Counter, register } from 'prom-client';

import type { SessionSyncCompatibilityEvaluation } from './decision';

export type SessionSyncCompatibilityTransport = 'http' | 'socket';

export interface SessionSyncCompatibilityTelemetryLabels {
    readonly transport: SessionSyncCompatibilityTransport;
    readonly client_kind: string;
    readonly protocol_bucket: 'missing' | 'malformed' | 'v1' | 'v2' | 'future';
    readonly decision: string;
}

const METRIC_NAME = 'session_sync_compatibility_decisions_total';
const compatibilityDecisionsCounter = (register.getSingleMetric(METRIC_NAME) as Counter | undefined)
    ?? new Counter({
        name: METRIC_NAME,
        help: 'Session-sync compatibility decisions by bounded transport and protocol buckets',
        labelNames: ['transport', 'client_kind', 'protocol_bucket', 'decision'] as const,
        registers: [register],
    });

export function buildSessionSyncCompatibilityTelemetryLabels(
    transport: SessionSyncCompatibilityTransport,
    evaluation: SessionSyncCompatibilityEvaluation,
): SessionSyncCompatibilityTelemetryLabels {
    const declaredProtocol = evaluation.declaration?.sessionSyncProtocolVersion;
    const protocolBucket = evaluation.outcome.includes('malformed')
        ? 'malformed'
        : declaredProtocol === undefined
            ? 'missing'
            : declaredProtocol === 1
                ? 'v1'
                : declaredProtocol === CURRENT_SESSION_SYNC_PROTOCOL_VERSION
                    ? 'v2'
                    : 'future';
    return {
        transport,
        client_kind: evaluation.declaration?.clientKind ?? 'unknown',
        protocol_bucket: protocolBucket,
        decision: evaluation.outcome,
    };
}

export function recordSessionSyncCompatibilityDecision(
    transport: SessionSyncCompatibilityTransport,
    evaluation: SessionSyncCompatibilityEvaluation,
): void {
    compatibilityDecisionsCounter.inc(buildSessionSyncCompatibilityTelemetryLabels(transport, evaluation));
}
