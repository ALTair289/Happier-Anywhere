type InFlightSteerRuntime = Readonly<{
    supportsInFlightSteer: () => boolean;
    supportsInFlightConfigApply?: () => boolean;
    isTurnInFlight: () => boolean;
    canSteerPrompt?: () => boolean;
}>;

export function shouldUseInFlightSteer(params: Readonly<{
    runtime: InFlightSteerRuntime | null;
    didChangePermissionMode: boolean;
    isPromptNonSteerable: boolean;
}>): boolean {
    const { runtime } = params;
    if (!runtime) return false;
    if (!runtime.supportsInFlightSteer()) return false;
    if (params.didChangePermissionMode && runtime.supportsInFlightConfigApply?.() !== true) return false;
    if (params.isPromptNonSteerable) return false;
    return runtime.canSteerPrompt ? runtime.canSteerPrompt() : runtime.isTurnInFlight();
}
