import type { SyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import {
    NATIVE_CRYPTO_WORKER_UNAVAILABLE_CAPABILITY,
    rememberNativeCryptoWorkerCapability,
    normalizeNativeCryptoWorkerRouting,
    type NativeCryptoWorkerRoutingInput,
} from './nativeCryptoWorkerRouting';
import { recordNativeCryptoWorkerCapability } from './nativeCryptoWorkerTelemetry';
import { reportNativeCryptoWorkerFallback } from './nativeCryptoWorkerFallbackReport';
import { createNativeCryptoWorker } from './nativeCryptoWorker';
import {
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
    NATIVE_CRYPTO_WORKER_OPERATION,
    NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON,
    type NativeCryptoWorker,
    type NativeCryptoWorkerCapability,
} from './types';

export type ProbeNativeCryptoWorkerCapabilitiesOptions = Readonly<{
    worker?: NativeCryptoWorker;
    capabilityCacheKey?: object;
    routing?: NativeCryptoWorkerRoutingInput;
    telemetry?: SyncPerformanceTelemetry;
}>;

export async function probeNativeCryptoWorkerCapabilities(
    options: ProbeNativeCryptoWorkerCapabilitiesOptions = {},
): Promise<NativeCryptoWorkerCapability | null> {
    const routing = normalizeNativeCryptoWorkerRouting(options.routing);
    if (routing.mode === 'off') {
        return null;
    }

    const worker = options.worker ?? createNativeCryptoWorker();
    let capability: NativeCryptoWorkerCapability = NATIVE_CRYPTO_WORKER_UNAVAILABLE_CAPABILITY;
    let probeError: unknown = null;
    try {
        capability = await worker.probe();
    } catch (error) {
        probeError = error;
        capability = {
            available: false,
            failureReason: NATIVE_CRYPTO_WORKER_PROBE_FAILURE_REASON.unknown,
        };
    }
    rememberNativeCryptoWorkerCapability(options.capabilityCacheKey ?? worker, capability);

    if (routing.telemetryEnabled) {
        recordNativeCryptoWorkerCapability(options.telemetry ?? syncPerformanceTelemetry, capability, { mode: routing.mode });
    }

    if (!capability.available) {
        // Startup warm-up is the earliest point at which a build with no usable
        // `HappierCryptoWorker` can be observed; without this the whole process
        // silently runs asymmetric + payload crypto on the JS thread.
        reportNativeCryptoWorkerFallback({
            operation: NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1,
            reason: NATIVE_CRYPTO_WORKER_FALLBACK_REASON.unavailable,
            itemCount: 0,
            payloadBytes: 0,
            failureReason: capability.failureReason,
            error: probeError,
            verbose: routing.logFallbacks,
            telemetry: options.telemetry ?? syncPerformanceTelemetry,
            telemetryEnabled: routing.telemetryEnabled,
        });
    }

    return capability;
}
