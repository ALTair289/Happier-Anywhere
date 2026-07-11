# Pending delivery architecture

This document is the tracked architecture contract for durable user-input delivery. It distinguishes the released Pending Queue V2 storage/materialization contract from Pending Delivery Attempt V1 (`attempt_v1`). The attempt controls are off by default; this document does not authorize admission, migration, promotion, runtime refresh, or release.

## Frozen vocabulary

- A **pending row** is the exact durable user envelope, stable local id, role, and order owned by the server pending aggregate.
- The sole session contract is derived from `pendingDeliveryProtocolFloor`: floor 1 is `tag_queue_v2`; floor 2 is `attempt_v1`. Rows never select or persist their own contract.
- An **attempt** is one authorized effort to dispatch the FIFO head. Its public attempt id is correlation, never authority.
- `reserved` is positively pre-write. `write_authorized` means the host CAS succeeded and bytes may have been written after its acknowledgement.
- Reserved expiry has one no-write outcome literal: `expired_pre_write` with `no_provider_write`.
- **Terminal custody** means the provider/TUI surface visibly owns the prompt. It is not provider acceptance and cannot satisfy `runtime_handoff`.
- **Exact acceptance** is attempt-bound evidence under an adopted provider-session, attachment, cursor, and receipt scope.
- **Ambiguous after write** means a write may have occurred. Automatic resend is forbidden.
- `runtime_handoff` is legal only when a non-TUI provider-submission boundary returns a positive synchronous acknowledgement stronger than injection or custody.
- `attempt_evidence` requires exact, replay-safe provider evidence. Missing evidence ownership, uniqueness, or replay-horizon facts make the runtime `unsupported`.
- Runtime-input handoff and provider-delivery mode are separate declarations. Durable floor-1 input ownership does not imply provider delivery or promotion eligibility.
- Claim credentials, runtime authority, human requests, and server transitions are distinct authority domains.

## Canonical owners

| Concern | Owner |
|---|---|
| Feature ids and dependency graph | `packages/protocol/src/features/catalog.ts` |
| Public attempt vocabulary and runtime declaration validation | `packages/protocol/src/sessionMessages/pendingDeliveryAttemptV1.ts` |
| Server feature environment | `apps/server/sources/app/features/catalog/readFeatureEnv.ts` |
| Sharing payload assembly | `apps/server/sources/app/features/sharingFeature.ts` |
| Dependency closure and route gate decisions | server feature payload/gate helpers |
| Contract, promotion, claim admission decisions | `pendingDeliveryAttemptAdmissionPolicy.ts` |
| Human action requirements | `pendingDeliveryAttemptAuthorization.ts` |
| Durable rows, attempts, barriers, outcomes, receipts, FIFO and transitions | the server pending aggregate introduced by D1 |
| Runtime election and runtime authority | the current-runtime owner introduced by R0 |
| Provider evidence | provider-owned adapters behind the provider-neutral attempt interface |
| Pending-to-transcript projection and ready/attention effects | the O1b transaction owner |

Protocol schemas validate boundary shapes. They do not implement a durable transition kernel. Routes, runtimes, providers, UI code, migrations, and test harnesses must call the canonical owners rather than reproduce their decisions.

## Receipt identity boundary

The public protocol exposes only the `provider_session_epoch | global_unique` receipt-scope schema and inferred type as a runtime capability fact. Receipt namespace, scope id, aliases, registry and authority revisions, digest, key version, raw receipt, and acceptance internals remain private server facts; API, socket, UI, log, metric, and shared-QA projection of those facts is forbidden.

`provider_session_epoch` is selected from a private server-owned epoch bound to one Happier session and the adopted provider-session, attachment, and cursor origin. Its private receipt identity commits the Happier session. `global_unique` instead proves uniqueness across Happier sessions inside one server-owned collision domain: Happier `sessionId` is attribution only and cannot partition the collision identity.

One allowlisted private registry owns the collision namespace and compatibility-stable canonical global scope. Compatible scope-id renames are lookup-only aliases, and delayed predecessor evidence cannot be relabeled as current. One private aggregate-owned receipt-write authority serializes acceptance with key and registry rotation; the keyring remains the sole crypto and key-version owner, while D1a remains the future HMAC, database, and acceptance implementation owner.

Retained keys, authority epochs, canonical and alias scopes, receipts, outcomes, and replay tombstones cannot be retired while referenced or while provider evidence remains replayable. An unknown replay horizon makes `attempt_evidence` unsupported.

## Feature and admission contract

Two server-represented features fail closed:

- `sharing.pendingDeliveryAttempts` depends on `sharing.pendingQueueV2` and controls floor-2 new-session creation and owner-approved promotion.
- `sharing.pendingDeliveryAttemptClaims` depends on `sharing.pendingDeliveryAttempts` and controls new claims.

Both server environment controls default to disabled. Disabling admission never disables exact completion, cancellation, or owner-authorized manual recovery of already admitted work.

The admission policy has three independent decisions:

1. An authorized, approved new-session creator may create floor 2 and its exact initial row atomically before provider launch. No current runtime is required; the row parks until a capable runtime binds.
2. Existing-session promotion is owner-only. It requires the contract gate, approved cohort, capable current runtime, a generation/epoch-fenced legacy-input drain, and separate closure of every provider-delivery lineage.
3. A new claim requires the claim gate, an existing floor-2 session, a capable elected runtime, and valid runtime authority.

The July `sharing.pendingDeliveryState` feature is compatibility-only. It is not attempt admission or claim authority.

## Transition contract

| From | To/result | Required evidence | Forbidden inference |
|---|---|---|---|
| no attempt | `reserved` | FIFO head, claim admission, capable current runtime, runtime authority | account/session ownership alone |
| `reserved` | `write_authorized` | provider `ready_to_write` followed by host phase CAS | composer emptiness, presence, time |
| `reserved` | `expired_pre_write` or another pre-write terminal result | locked server-time expiry or other positive `no_provider_write` proof | timeout after authorization |
| `write_authorized` | `terminal_custody` | bounded custody observation | acceptance or later-row credit |
| authorized/custody | exact accepted/rejected result | matching attempt evidence or eligible provider-submission acknowledgement | text equality, banner, output, heartbeat |
| authorized/custody | `ambiguous_after_write` | lost/uncertain post-write result | automatic retry |
| any active phase | `cancel_requested` or terminal cancellation | phase-aware canonical transition | physical row deletion |

Lease expiry never manufactures provider acceptance or rejection. Reserved expiry closes as `expired_pre_write` with `no_provider_write`, and a later attempt receives a new id and credential. Expiry after authorization is an ordering barrier. A duplicate-risk resend is a separate owner-authorized operation with a new stable local id.

## Human authorization

- Authorized viewers may list derived pending state.
- Editors and owners may enqueue and perform ordinary pre-write edit, reorder, discard, restore, dispatch, steer, and separately receipted interrupt requests.
- `cancel` is a distinct editor-or-owner action. D1a/D1b enforce phase behavior: pre-write cancellation may close no-write; post-write cancellation only requests provider cancellation and preserves possible-write ambiguity until exact closure.
- Only the session owner may promote an existing session, resolve possible-write/input ambiguity, or authorize duplicate-risk resend.
- Human authority never substitutes for runtime credentials or provider evidence. Runtime credentials never grant edit/share authority.

The policy maps actions to canonical access requirements; route/service integration must continue using the existing session access helpers so forbidden/not-found privacy behavior is preserved.

## Mode B compatibility boundary

Bounded coexistence is mandatory while deployment, database, or runner facts remain unknown. Floor-1 and floor-2 adapters stay physically separate but converge on one pending aggregate action router.

Promotion snapshots an immutable cutoff and closes new legacy admissions. Runtime-input retirement accounts for every HTTP, socket, and in-process range/ordinal plus the elected input owner's authenticated cutoff acknowledgement. Provider-delivery retirement separately requires an exact attempt receipt, an exact eligible `runtime_handoff` outcome, or session-owner resolution for every lineage. Transcript presence, input handoff, custody, assistant output, queue emptiness, liveness, and time cannot close provider delivery.

If either retirement proof is missing, the session remains floor 1 with a typed blocker and the compatibility adapter remains live. A feature marker or row marker cannot fence a genuinely old server binary. After floor-2 state exists, rollback is forward-fix to an attempt-aware build with new admission off unless a complete tested back-migration runs under quiescence.

## User-visible guarantees

- The exact original envelope is durable before dispatch or provider launch.
- A queued row remains visible and ordered until a canonical transition resolves it.
- Custody/possible-write states are attention-worthy and never silently resent.
- Accepted input projects pending-to-transcript once; provider acceptance, output durability, participant readiness, and notification remain distinct facts.
- Unknown runtime declarations and future states fail closed as upgrade-required/unsupported rather than falling back to direct text delivery.
- Delivery failure never authorizes host destruction or automatic runner refresh.

## Privacy bounds

Public API/socket/UI presentation may include session/local/public-attempt correlation, bounded phase/reason/action, and CAS versions. It must not contain raw or digested runtime/claim/recovery credentials, receipt namespace/scope/digest, provider session ids, raw receipt/hook/screen evidence, or prompt fingerprints.

Raw credentials and provider receipts are transient within their authenticated runtime/server request boundary. Server storage retains only the contract-approved keyed verifier/outcome/receipt material. Logs, metrics, telemetry, snapshots, and QA evidence follow the sink-specific allowlist in `docs/encryption.md` and the living reliability plan; content and secrets are never copied for diagnostics.

## Supersession and deletion ledger

The following are bounded compatibility surfaces, not alternate attempt owners:

- `sharing.pendingDeliveryState` and `PendingDeliveryStatusV1` describe July/tag-era behavior only.
- Tag-era materialization and watermark/catch-up remain only behind the floor-1 adapter.
- Local-id-only accept/block/retry/handled routes, custody-as-acceptance callbacks, provider-local conversation FIFO, and caller-selected materialize/claim branches must be fenced and removed by their owning implementation corridors.
- Runtime-input cursors must never be relabeled as provider-acceptance cursors.
- Testkits may parse raw responses and compose real HTTP/session-RPC owners, but may not define attempt phases, outcomes, a queue, an aggregate, or transition decisions.

Compatibility code is deleted only after supported floor-1 sessions/runtimes are absent, every input admission is accounted for, every provider-delivery lineage is closed, and the zero-bypass searches pass. Until then it remains narrow, boundary-owned, and unreachable for floor-2 input.
