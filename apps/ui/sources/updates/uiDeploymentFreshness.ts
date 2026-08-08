export type UiDeploymentFreshnessState = Readonly<{ baselineId: string | null; updateAvailable: boolean }>;
const ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export function reduceUiDeploymentFreshness(state: UiDeploymentFreshnessState, observedId: unknown): UiDeploymentFreshnessState {
    const currentId = String(observedId ?? '').trim();
    if (!ID_PATTERN.test(currentId) || state.updateAvailable) return state;
    if (!state.baselineId) return { baselineId: currentId, updateAvailable: false };
    if (state.baselineId === currentId) return state;
    return { baselineId: state.baselineId, updateAvailable: true };
}
