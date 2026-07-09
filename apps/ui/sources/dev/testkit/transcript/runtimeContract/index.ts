/**
 * Transcript device/perf RUNTIME contract harness (lane H1, the keystone).
 *
 * A real-scroll runtime harness that asserts OBSERVABLE on-screen position + performance outcomes
 * (not captured prop objects). Phase 1–3 lanes add scenarios via `TranscriptRuntimeContract` or by
 * composing `FlashListRuntimeModel` + `TranscriptPerfContractTracker` directly. See the module
 * headers for the fidelity model and the canonical-owner composition.
 */
export * from './flashListRuntimeModel';
export * from './legendListRuntimeModel';
export * from './perfContractTracker';
export * from './transcriptRuntimeContract';
export * from './sidechainShellRuntimeModel';
export * from './webDomNavigationRuntimeModel';
export * from './webScrollRuntimeModel';
