export type DeferredSessionBufferLimits = Readonly<{
  maxEntries: number;
  maxBytes: number;
}>;

export type DeferredSessionBufferDropReason = 'cancelled' | 'overflow' | 'flush_error';

export type DeferredSessionBufferEntry<TTarget> = Readonly<{
  approxBytes: number;
  flush: (target: TTarget) => void | Promise<void>;
  onDrop?: (reason: DeferredSessionBufferDropReason) => void;
  onError?: (error: unknown) => void;
}>;

export type DeferredSessionBufferStats = Readonly<{
  entryCount: number;
  approxBytes: number;
  overflowed: boolean;
}>;
