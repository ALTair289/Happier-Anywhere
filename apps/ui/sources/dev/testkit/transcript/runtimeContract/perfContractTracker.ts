/**
 * Performance-contract instrumentation for the transcript runtime harness (lane H1).
 *
 * The committed plan makes performance a FIRST-CLASS gate, not an afterthought: referential
 * stability for unchanged rows/maps/arrays, bounded render counts under streaming, and "MVCP
 * config does not value-churn (no disabled↔start-rendering-from-bottom flips mid-stream)".
 *
 * The prop-capture suite cannot see any of these as outcomes — it captures one prop snapshot per
 * render and asserts a value. This tracker records the SEQUENCE of derived states the harness
 * produced across a scenario so a test can assert:
 *   - render count per streamed token (a render budget),
 *   - referential identity of a value across frames (Object.is, the unchanged-rows contract),
 *   - that the MVCP policy string did not churn while streaming.
 *
 * It is a passive recorder driven by the scenario layer; no production code is mocked.
 */

export type MvcpPolicySample = 'disabled' | 'start-rendering-from-bottom' | 'autoscroll-threshold';

export class TranscriptPerfContractTracker {
    private renderCount = 0;
    private readonly referenceSamples = new Map<string, unknown[]>();
    private readonly mvcpPolicySamples: MvcpPolicySample[] = [];

    /** Count one render/commit pass. */
    markRender(): void {
        this.renderCount += 1;
    }

    renders(): number {
        return this.renderCount;
    }

    /** Record the current value held under `label` for later referential-stability assertions. */
    sampleReference(label: string, value: unknown): void {
        const existing = this.referenceSamples.get(label) ?? [];
        existing.push(value);
        this.referenceSamples.set(label, existing);
    }

    /** Record one MVCP policy observation (for the no-churn contract). */
    sampleMvcpPolicy(policy: MvcpPolicySample): void {
        this.mvcpPolicySamples.push(policy);
    }

    /**
     * Distinct number of referentially-different values seen under `label`. 1 = fully stable
     * (Object.is identical across every sample). Throws if the label was never sampled so a typo
     * cannot silently pass.
     */
    distinctReferences(label: string): number {
        const samples = this.referenceSamples.get(label);
        if (!samples || samples.length === 0) {
            throw new Error(`No reference samples recorded under '${label}'`);
        }
        const distinct: unknown[] = [];
        for (const value of samples) {
            if (!distinct.some((seen) => Object.is(seen, value))) distinct.push(value);
        }
        return distinct.length;
    }

    referenceWasStable(label: string): boolean {
        return this.distinctReferences(label) === 1;
    }

    /** True if the MVCP policy never changed value across the recorded window. */
    mvcpPolicyDidNotChurn(): boolean {
        return new Set(this.mvcpPolicySamples).size <= 1;
    }

    mvcpPolicyTransitions(): readonly MvcpPolicySample[] {
        const transitions: MvcpPolicySample[] = [];
        for (const policy of this.mvcpPolicySamples) {
            if (transitions[transitions.length - 1] !== policy) transitions.push(policy);
        }
        return transitions;
    }

    reset(): void {
        this.renderCount = 0;
        this.referenceSamples.clear();
        this.mvcpPolicySamples.length = 0;
    }
}
