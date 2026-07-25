import { describe, expect, it } from 'vitest';

import type { SessionSyncCompatibilityEvaluation } from './decision';
import { buildSessionSyncCompatibilityTelemetryLabels } from './telemetry';

describe('session-sync compatibility telemetry labels', () => {
    it('uses bounded buckets without exact versions or identifiers', () => {
        const evaluation: SessionSyncCompatibilityEvaluation = {
            accepted: true,
            outcome: 'accepted',
            declaration: {
                v: 1,
                clientKind: 'ui-web',
                appVersion: '0.2.10-preview.12345',
                releaseChannel: 'preview',
                sessionSyncProtocolVersion: 3,
            },
            upgradeRequired: null,
        };

        expect(buildSessionSyncCompatibilityTelemetryLabels('socket', evaluation)).toEqual({
            transport: 'socket',
            client_kind: 'ui-web',
            protocol_bucket: 'future',
            decision: 'accepted',
        });
    });
});
