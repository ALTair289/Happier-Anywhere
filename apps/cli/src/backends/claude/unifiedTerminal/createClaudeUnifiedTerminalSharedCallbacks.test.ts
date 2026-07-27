import { describe, expect, it, vi } from 'vitest';

import { createClaudeUnifiedTerminalSharedCallbacks } from './createClaudeUnifiedTerminalSharedCallbacks';

describe('createClaudeUnifiedTerminalSharedCallbacks', () => {
  it('shares clear and metadata-applier lifecycle behavior across launcher corridors', async () => {
    const wakePendingMaterialization = vi.fn();
    const flushPendingMetadataMode = vi.fn(async () => undefined);
    let metadataApplier: ((mode: never) => Promise<never>) | null = null;
    const callbacks = createClaudeUnifiedTerminalSharedCallbacks({
      sessionClient: {
        sendSessionEvent: vi.fn(),
        hasActiveCanonicalTurn: () => false,
      },
      observeInFlightSteerAvailabilitySnapshot: vi.fn(),
      sustainedPendingDeliveryBlockHandler: {
        blockForSustainedBlocker: vi.fn(async () => false),
        wakePendingMaterialization,
      },
      dialogChoiceBroker: {} as never,
      tuiRuntimeControlEnabled: true,
      registerStatuslineRuntimeReconciler: vi.fn(() => () => undefined),
      getMetadataRuntimeModeApplier: () => metadataApplier,
      setMetadataRuntimeModeApplier: (apply) => {
        metadataApplier = apply as typeof metadataApplier;
      },
      flushPendingMetadataMode,
      logPrefix: '[test]',
      logDebug: vi.fn(),
    });

    callbacks.onDraftGuardClear?.();
    callbacks.tuiRuntimeControl.onBlockedApplyClear?.();
    expect(wakePendingMaterialization).toHaveBeenCalledTimes(2);

    const apply = vi.fn(async () => ({ promptMayProceed: true, attempted: true }));
    const unregister = callbacks.tuiRuntimeControl.registerMetadataRuntimeModeApplier?.(apply);
    expect(metadataApplier).toBe(apply);
    expect(flushPendingMetadataMode).toHaveBeenCalledOnce();

    unregister?.();
    expect(metadataApplier).toBeNull();
  });
});
