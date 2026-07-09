# PHASE-2 M10 Terminal Consolidation Report

## Verdict

PASS. Terminal hard gate met exactly:

```text
26   apps/ui/sources/components/sessions/transcript/ChatList.tsx
2307 apps/ui/sources/components/sessions/transcript/ChatListInternal.tsx
167  apps/ui/sources/components/sessions/transcript/useChatListRootState.ts
2500 total
```

Gate: <= 2,500 combined. Stretch <= 2,000 not reached.

## Starting Census

Pre-M10 host total was 3,732 lines:

- `ChatList.tsx`: 26 public wrapper lines.
- `ChatListInternal.tsx`: 3,253 lines, still holding leftover session-entry lifecycle glue, native viewport lifecycle wiring, telemetry event/diagnostic callbacks, native inverted fact-source setup, measurement wiring, expansion state, motion/shell frame assembly, and command-host wiring.
- `useChatListRootState.ts`: 453 lines, mixing outer data assembly with derived item/message/pending/rollback/thinking/navigation helpers.

## Final Remaining Census

- `ChatList.tsx`: still only the public memo wrapper and root-state handoff.
- `ChatListInternal.tsx`: now the remaining owner coordinator. It keeps instantiate-once owners, host call ordering, refs/state that define the transcript viewport owner graph, and thin calls into focused hooks.
- `useChatListRootState.ts`: reduced to outer root assembly and handoff. Derived items/messages, pending requests, rollback actions, thinking state, and navigation state moved to focused root hooks.

No new host-orchestration file is counted toward the hard gate. `ChatListInternalFrame.tsx` is presentational frame rendering, not host orchestration.

## Batch Accounting

| Batch | Scope | Host total before | Host total after | Net |
|---|---:|---:|---:|---:|
| Baseline | `ChatList.tsx` + `ChatListInternal.tsx` + `useChatListRootState.ts` | 3,732 | 3,732 | 0 |
| Root-state extraction | Root derived-data/message/navigation/pending/rollback/thinking hooks | 3,732 | 3,446 | -286 |
| Terminal host extraction | Session-entry lifecycle, telemetry, measurement, expansion, native fact source, lifecycle, motion, shell frame, command/mount-settle wiring | 3,446 | 2,500 | -946 |
| Final | Hard-gate measured total | 3,732 | 2,500 | -1,232 |

## New Files Declared

All are focused owner/hook/component modules and are **not counted** as host-orchestration files:

- `ChatListInternalFrame.tsx` — presentational transcript frame.
- `items/useTranscriptRootDerivedItems.ts` — root derived item/cache assembly.
- `items/useTranscriptRootMessages.ts` — root message/fork/SWR fallback assembly.
- `items/useTranscriptRootPendingRequests.ts` — root pending request assembly.
- `items/useTranscriptRootRollbackActions.ts` — root rollback action resolver.
- `thinking/useTranscriptRootThinkingState.ts` — root thinking state.
- `navigation/useTranscriptRootNavigationState.ts` — root pins/navigation state.
- `motion/useTranscriptMotionConfig.ts` — transcript motion config derivation.
- `measurement/useTranscriptMeasurementHostWiring.ts` — row/measurement host wiring.
- `rowHost/useTranscriptExpansionState.ts` — row expansion state.
- `viewport/driver/useNativeInvertedFactSource.ts` — native inverted fact source hook.
- `viewport/driver/useTranscriptViewportCommandHostWiring.ts` — command host wiring.
- `viewport/entryRestore/host/useTranscriptNativeEntryRestorePaintRelease.ts` — native entry-restore paint release lifecycle.
- `viewport/entryRestore/host/useTranscriptSessionEntryLifecycle.ts` — session-entry lifecycle.
- `viewport/lifecycle/host/useTranscriptNativeMountSettleLifecycle.ts` — native mount-settle lifecycle.
- `viewport/lifecycle/host/useTranscriptNativeViewportLifecycle.ts` — native viewport lifecycle.
- `viewport/shell/useMainTranscriptRendererFrameHost.ts` — main shell frame host hook.
- `viewport/telemetryHost/useTranscriptViewportTelemetryEvents.ts` — viewport telemetry event host.
- `viewport/telemetryHost/useTranscriptWebViewportTelemetryDiagnostics.ts` — web viewport diagnostics host.

## Important Fix During Validation

The first full FlashList run exposed an extraction dependency regression: `useTranscriptSessionEntryLifecycle` had over-broad deps on inline/ref-forwarding wrapper params, which let a stale session-entry layout effect emit an anchorless viewport after a correct debounced anchor capture. The hook now uses the pre-M10 semantic dependency shape, preserving the original session-entry effect stability.

The shell-frame source assertions were updated to follow the extracted owner modules instead of expecting the implementation strings to remain in `ChatListInternal.tsx`.

## Validation

Passed:

- `ChatList.flashListV2.test.tsx` at 8GB: 265/265.
- `ChatList.flashListV2.test.tsx` at 8GB, second deterministic run: 265/265.
- Companion bundle at 8GB: 12 files, 148/148:
  - inverted: 71/71.
  - initial scroll behavior: 12/12.
  - shell frame: 51/51.
  - main renderer frame host: 6/6.
  - all identity/fallbackGuard tests included in the bundle.
- UI typecheck at 8GB: passed.
- `graphify update .`: passed; graphify-out updated.

Attempted but blocked:

- Autoreview: `/Users/leeroy/.agents/skills/autoreview/scripts/autoreview --mode local` failed before review with `Operation not permitted` while creating PATH aliases / initializing the in-process app-server client.

Known unrelated direct-owner failure observed during earlier focused probing:

- `viewport/driver/commandHost.test.ts` still had the pre-existing direct-owner failure for stale web anchor restore fallback (`scroll_requested` vs `restored`). It was not part of the M10 identity/fallback closeout bundle and was not changed here.
