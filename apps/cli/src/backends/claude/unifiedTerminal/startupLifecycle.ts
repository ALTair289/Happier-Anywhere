export type ClaudeUnifiedStartupLifecycleIntent =
  | Readonly<{ kind: 'new_session' }>
  | Readonly<{ kind: 'resume_native'; providerSessionId: string }>
  | Readonly<{ kind: 'continue_native' }>;

export type ClaudeUnifiedNativeContinuationIntent = Exclude<
  ClaudeUnifiedStartupLifecycleIntent,
  Readonly<{ kind: 'new_session' }>
>;

export type ClaudeUnifiedStartupLifecycleBinding = Readonly<{
  recordProviderResumeStarted(input: ClaudeUnifiedNativeContinuationIntent): Promise<void>;
  recordProviderResumeSessionStarted(): void;
  recordProviderStartupReady(): Promise<void>;
}>;

/**
 * Prepares callbacks that bind exact provider launch and startup evidence to the canonical
 * foreground-turn lifecycle. Preparation is intentionally inert: a native resume may adopt an
 * already-running provider host, so only the launch-disposition owner may open the provisional
 * resume barrier.
 */
export async function prepareClaudeUnifiedStartupLifecycle(input: Readonly<{
  intent: ClaudeUnifiedStartupLifecycleIntent;
  binding: ClaudeUnifiedStartupLifecycleBinding;
}>): Promise<Readonly<{
  onProviderLaunchStarting(): Promise<void>;
  onProviderSessionStarted(): void;
  onStartupReady(): Promise<void>;
}>> {
  const continuationIntent = input.intent.kind === 'new_session' ? null : input.intent;
  let providerLaunchStartingPromise: Promise<void> | null = null;
  return {
    onProviderLaunchStarting: () => {
      if (!continuationIntent) return Promise.resolve();
      providerLaunchStartingPromise ??= Promise.resolve()
        .then(() => input.binding.recordProviderResumeStarted(continuationIntent));
      return providerLaunchStartingPromise;
    },
    onProviderSessionStarted: () => {
      input.binding.recordProviderResumeSessionStarted();
    },
    onStartupReady: () => input.binding.recordProviderStartupReady(),
  };
}
