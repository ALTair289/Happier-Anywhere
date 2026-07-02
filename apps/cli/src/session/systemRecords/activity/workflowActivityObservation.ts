/**
 * Provider-agnostic per-run change observation consumed by the coalesced workflow activity
 * publisher (CWF3). A provider normalizer (Claude's tracker today) emits this after folding each
 * event; the publisher uses the run-id partitions to decide immediate vs debounced writes.
 *
 * Kept in the provider-agnostic `session/systemRecords/activity/` owner so the scheduler never
 * imports a Claude-specific type. The Claude tracker's `WorkflowActivityObservation` is structurally
 * compatible with this shape.
 */
export type WorkflowActivityObservationLike = Readonly<{
  changedRunIds: readonly string[];
  startedRunIds: readonly string[];
  terminalRunIds: readonly string[];
  statusChangedRunIds: readonly string[];
}>;
