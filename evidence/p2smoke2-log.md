# PHASE2-SMOKE-2 Evidence Log

Run: 2026-07-06. Stack: http://happier-repo-remote-dev-d72117acdb.localhost:18829/?happier_hmr=0
Agent-browser session: p2smoke2. Key: TKKFL-2B6NN-ZNTCZ-L5E3I-KBMHM-V5AV7-M4K2R-GL2M5-6ZLUA-GMPNK-6Q

## ChatList stamps

| Gate | Lines | Timestamp |
|---|---|---|
| P1-start (T0) | 5992 | 2026-07-06T12:02:58Z |
| P2 | 5992 | 2026-07-06T12:02:58Z |
| P4 first attempt | 5992 → 5133 (M6 active) | 2026-07-06T12:25:26Z |
| M6 stable poll 1 | 4894→4869 | 12:27:24Z–12:31:46Z |
| P4/P5 re-attempt at 4869 | BLOCKED (TDZ crash) | 2026-07-06T12:31:46Z+ |

## Bundle attestation (at 5992 stamp)

- `useTranscriptBottomFollowHost`: 10 ✓
- `followBottomIntent`: 23 ✓
- `useTranscriptEntryHost`: 10 ✓
- `anchorSeqLoaded`: 5 ✓
- `performWebWindowLanding`: 3 ✓
- `resolveWebGenuineScrollMovement`: 7 ✓

## Bundle attestation (at 4869 stable stamp)

- `useTranscriptBottomFollowHost`: 10 ✓
- `useTranscriptEntryHost`: 10 ✓
- `performWebWindowLanding`: 3 ✓
- `hasOpenEntryRestoreTransactionForSession`: 4 (call sites in bundle, but TDZ at runtime)
- `drainDeferredNewerMessages`: 10 ✓

## P1: Cold open large session ×3 (5992 stamp)

Session: cmr3a270d070ytmtmkfnoqwq6

| Run | Samples | dfb min | dfb max | dfb>1 |
|---|---|---|---|---|
| R1 | 30×500ms | 0 | 0 | 0 |
| R2 | 30×500ms | 0 | 0 | 0 |
| R3 | 30×500ms | 0 | 0 | 0 |

P1 total: 90 samples, dfb=0 all. sh=29634, ch=317. **PASS ×3**

## P2: Pinned streaming burst (5992 stamp)

Burst 1: Response completed before dense monitoring window.
- Before: sh=29720, dfb=0
- During (hasWorking=true sampled): sh=31952, dfb=0 (+2232px growth)
- After: sh=31952, dfb=0 (response complete, hasWorking=false)

Burst 2 (dense 250ms monitoring, immediate after send):
- Initial: sh=32045, dfb=0
- Samples: sh=32038, dfb=7 (×80 samples, samples 20-100); sh=33812, dfb=0 (sample 120 stable)
- Growth: +1767px total
- maxDfb=7, yanks>50: 0

**PASS** — sh grew 32045→33812 (+1767px), maxDfb=7, zero yanks (>50px). Pin battery (M5 gate) held throughout.

## P3: Escape-during-stream

**SKIPPED-ENV** — genuine-scroll guard (`resolveWebGenuineScrollMovement`) cannot be satisfied by programmatic scroll (same permanent env limit as WQA-5 S3g/WQA-3/4).

## P4: Route jumpSeq=41 target mounts visible ×2 (5992 stamp)

URL: /session/cmr3a270d070ytmtmkfnoqwq6?jumpSeq=41

| Run | st | sh | dfb | Visible content | Verdict |
|---|---|---|---|---|---|
| R1 | 16013 | 41517 | 25187 | "For the settle at the end of this batch..." (top=58) | PASS |
| R2 (reload) | 15923 | 43622 | 27382 | "Jul 2, 2026, 5:35 PM" (top=106) | PASS |

**PASS ×2** — both runs: non-tail dfb, visible content, jump fired and landed.

## M6 TDZ crash: P4/P5 blocked at 4869 stamp

When re-running P4 at stable 4869 stamp:
- App crashes with: `ReferenceError: hasOpenEntryRestoreTransactionForSession is not defined`
- URL: redirects to /?id=cmr3a270d070ytmtmkfnoqwq6 on crash
- Root cause: ChatList.tsx:2784 has `hasOpenEntryRestoreTransactionForSession` in a useCallback dep array, but `const hasOpenEntryRestoreTransactionForSession = ...` is defined at :2820 (AFTER the dep array evaluation) — temporal dead zone violation introduced by M6 reorganization.
- Affected: ALL sessions (ChatList always renders with this dep array)
- Crashes occur at stable 4869 stamp and all subsequent M6-active stamps

## P5: In-app switch-return (5992 stamp)

P5 R1 attempted via pushState: returned st=19346, sh=40557, dfb=20894 (captured offsetY=28259). dfb did not match captured offsetY (diff=7365px). Content visible = "Shadow paging" text. Not byte-exact match.

P5 re-run at stable 4869 stamp: BLOCKED by M6 TDZ crash (same crash as P4 re-run).

## P6: Console errors

Errors=0 across P1-P4 runs at 5992 stamp. Post-M6 crash: JS runtime errors introduced by M6 TDZ (not pre-existing). At 5992 stamp: **PASS (0 errors)**.

## M6 TDZ bug evidence

File: `apps/ui/sources/components/sessions/transcript/ChatList.tsx`
- Line 2771: `const handleRowLayoutMutation = React.useCallback((...) => {`
- Line 2779: `hasOpenEntryRestoreTransactionForSession()` — called in callback body
- Line 2784: `hasOpenEntryRestoreTransactionForSession,` — in dep array (evaluated at render time)
- Line 2820: `const hasOpenEntryRestoreTransactionForSession = React.useCallback(...)` — DEFINED AFTER usage in dep array at 2784

TDZ violation: the dep array at 2784 is evaluated when `handleRowLayoutMutation` useCallback runs (line 2771), but the `const` at 2820 is not yet initialized at that point in the function body.
