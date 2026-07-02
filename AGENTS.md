# Agent Constitution

This file is the canonical cross-tool constitution for this repository. Re-read it at the start of each task and after context compaction. Also read the nearest package `AGENTS.md`/`CLAUDE.md` for package-specific rules.

## Read order

1. Root `AGENTS.md` (this file).
2. Nearest package instructions:
   - UI: `apps/ui/AGENTS.md`
   - CLI: `apps/cli/AGENTS.md`
   - Server: `apps/server/AGENTS.md`
   - Stack: `apps/stack/AGENTS.md`
3. Task-specific skills when relevant, especially:
   - `skills/happier-testing` for repo-specific testing and lane selection.
   - `skills/happier-diagnose` for Happier daemon/session/provider/auth issues.
   - `test-driven-development` before behavior-changing implementation.
   - `context7-mcp` before using post-training library/package knowledge.
   - `agent-browser` / `agent-device` / Argent skills for browser or device QA.
   - `autoreview` for closeout review after non-trivial edits.

## Core operating policy

- **Follow through:** if the user's intent is clear and the next step is reversible and low-risk, proceed without asking.
- Ask permission only when a step is irreversible, has external side effects, requires sensitive information, or requires a material product/design choice.
- Treat the task as incomplete until all requested items are handled or explicitly marked `[blocked]` with the missing data.
- For multi-item work, keep an internal checklist and verify coverage before finalizing.
- Persist to an implemented, verified, clearly reported outcome whenever feasible.
- Prefer parallel tool calls for independent retrieval/lookup steps; do not parallelize dependent or speculative work.
- Protect context: load the minimum relevant snippets, avoid dumping logs/build artifacts, and summarize large artifacts by path.

## Product priorities

Performance and long-term maintainability are paramount product requirements, not afterthoughts.

- Treat responsiveness, scalability, and resource usage as acceptance criteria for user-facing, sync, transcript, terminal, provider, server, and daemon flows.
- Do not trade away correctness, accessibility, state continuity, privacy, or user trust for micro-optimizations.
- Prefer measured evidence for performance-sensitive work: before/after timings, render counts, profiler output, targeted performance tests, or a clear explanation of why measurement was not feasible.
- Long-term maintainability matters more than preserving a small diff. If the correct fix requires a coherent refactor, do it and validate it.
- Favor fixes that simplify the durable architecture: fewer competing paths, clearer ownership, stronger invariants, and less future drift.

## Evidence-first work

Base fixes and refactors on observed facts, not assumptions.

- Inspect current code, call sites, tests, logs, schemas, and runtime behavior before changing code.
- For bugs, reproduce or identify the failing path before fixing whenever feasible.
- Distinguish observed facts, hypotheses, and decisions in reasoning and final reports.
- Do not infer behavior solely from file names, comments, or stale docs; verify against implementation or tests.
- Prefer instrumentation or focused tests over speculative fixes when the cause is unclear.
- If evidence is missing, say what is missing and what would verify it.
- Do not claim a test, typecheck, build, or manual QA passed unless it actually ran.
- If blocked, name the blocker and the next concrete action.

## Root-cause discipline

Fix the cause, not the symptom.

- Do not implement workarounds, band-aids, duplicate paths, or similar-but-different logic when the owning cause can be fixed.
- If a temporary mitigation is genuinely necessary, keep it narrow, label why it exists, test it, and state the follow-up root-cause fix.
- When fixing a bug, search for the same pattern in nearby owners and shared abstractions.
- Centralize or reuse the canonical path when the same issue exists elsewhere; do not leave parallel implementations to drift.
- If the root cause crosses package boundaries, identify the owning boundary first, then make the smallest coherent cross-package change.

## Systemic changes and split-brain prevention

Treat split-brain implementations as correctness bugs. A split brain is any case where two or more active owners, registries, parsers, state machines, schemas, feature gates, provider paths, or normalization layers can make independent decisions for the same domain concept.

- Do not hand off patchwork fixes. A local fix is acceptable only when the behavior truly belongs locally; otherwise fix the owning choke point.
- Before changing behavior, map the relevant system path: inputs, normalization, state/persistence, feature gates, provider/catalog hooks, callers, readers, tests, and user-visible outputs.
- Search beyond the immediate file for parallel logic using symbols, routes, commands, config keys, feature ids, provider ids, event types, storage keys, schema names, env vars, test fixtures, and UI identifiers.
- If multiple paths implement the same concept, choose or create one canonical owner and migrate all in-scope callers/readers/writers to it in the same coherent change.
- Reuse, extend, move, or extract existing code before adding new logic. New duplicate registries, fallback branches, helper stacks, or similar-but-different implementations are forbidden unless required for deployed compatibility.
- Apply invariants at the correct layer: parse/normalize at boundaries, enforce domain rules in the domain owner, and keep UI/CLI/server adapters thin unless the behavior is adapter-specific.
- Do not centralize coincidental duplication. If similar code represents genuinely different bounded contexts, keep it separate and name the distinction.
- Compatibility paths must be narrow, boundary-owned, tested, and documented by the deployed shape/version they support. New writes should use the canonical path.
- If the systemic fix is too large or blocked, do not disguise a workaround as complete. Mark `[blocked]`, explain the required canonical fix, and keep any temporary mitigation narrow and tested.
- Before handoff, search for bypasses of the canonical owner, stale alternate paths, duplicate registries, direct callers, and compatibility leftovers; remove them or explain why they remain.

## Execution loop

Use this loop for implementation work:

1. Understand current behavior and reproduce/observe the issue when feasible.
2. Map the relevant code paths, owners, readers, writers, and tests.
3. Find the existing canonical owner/pattern.
4. Write or adjust the smallest meaningful test when behavior changes.
5. Make the smallest coherent systemic change at the owning choke point.
6. Run the narrowest relevant check.
7. Broaden validation before handoff.
8. Self-review for duplicate paths, bypasses, and split-brain risk.

## Multi-agent safety

This repo is often edited by multiple agents at once.

- Never remove, revert, overwrite, or “clean up” unrelated changes just because they are unexpected.
- Before touching a file, assume uncommitted changes may belong to another in-flight agent unless proven otherwise.
- If a change appears accidental but is unrelated to your task, ask before altering it.
- Do not create ad-hoc summary/report/status files. Use the final response or approved project locations only.

## Git safety (non-negotiable)

- Never switch branches in the primary checkout.
- Do not create/delete branches unless explicitly requested.
- Never run or emulate destructive git cleanup without explicit approval, including:
  - `git reset`
  - `git restore`
  - `git clean`
  - `git checkout`
  - `git switch`
  - any command whose purpose is to discard local work
- Use read-only git commands for inspection (`status`, `diff`, `log --no-pager`) unless the user asked for a mutation.

## Testing and TDD

### Behavior-change rule

- Any production behavior change requires TDD: write/update a relevant failing test first, verify RED, implement minimal GREEN, refactor with tests green.
- Do a test inventory before adding tests: search existing coverage by symbol/module, route/command, config key, feature id, component, error code, and package-local harnesses.
- Prefer updating or consolidating existing tests over adding overlapping tests.
- If implementation already exists before a test, stop and restore test-first order where feasible; otherwise explicitly report the exception and rationale.

### What does not need new tests

- Content-only Markdown/template/copy changes that do not affect executable runtime behavior.
- CSS/styling-only changes unless they alter interaction, accessibility, or visibility semantics.
- Mechanical renames/moves/formatting with no runtime effect, though relevant existing checks should still run.

### Test quality rules

- No content-policing tests that primarily pin wording, Markdown formatting, whitespace, or example config values.
- Assert observable behavior and stable contracts, not incidental implementation details or exact user-facing prose.
- Test error type/code/shape/status rather than full message wording unless the message is a published contract.
- Keep positive fixtures aligned with the real runtime contract when capabilities, feature flags, session state, or availability become required.
- Reset shared state in tests using dynamic imports, module caches, mutable globals, or reused mocks.

### No internal mocks

- Test real internal behavior. Do not mock domain logic, reducers/selectors, parsers, normalization, permission/state machines, store logic, or orchestration helpers.
- Boundary mocks are allowed for system boundaries only: third-party APIs, payment/email providers, platform/native SDKs, OS/process/time/random/env adapters.
- If a boundary mock is used, document why and assert outcomes/state, not only call counts.
- Use canonical package testkits/helpers before creating new mocks or fixtures.
- UI tests should prefer `apps/ui/sources/dev/testkit/**` and imports from `@/dev/testkit` for common boundaries (`expo-router`, `@/text`, `@/modal`, `react-native`, `react-native-unistyles`, storage).

### Validation lanes

- For tight RED/GREEN loops, run the smallest relevant test slice.
- Before handoff, run the touched package typecheck/build lane and the relevant broader test lane.
- Canonical repo lanes are documented in `docs/testing.md` and `apps/docs/content/docs/development/testing.mdx`.
- TypeScript changes require the relevant package typecheck/build-enforcing lane before handoff.

## Type safety and code hygiene

- TypeScript must remain strict. Do not weaken `tsconfig` or type rules to make tests/builds pass.
- `@ts-ignore` is forbidden.
- `@ts-expect-error` is allowed only with a short rationale and only on the exact expected-failure line.
- Broad `as any` casts are forbidden except in narrow boundary fixtures/harnesses with a one-line justification.
- Prefer `satisfies`, explicit interfaces, typed fixtures, and canonical schemas over casting.
- No TODO/FIXME placeholders in production code.
- No stray `console.log` or debug statements.
- Remove dead code and commented-out code blocks.

## Engineering taste

- Optimize for readability over cleverness.
- Prefer one obvious path over multiple parallel mechanisms.
- Do not invent abstractions until repeated real use justifies them.
- Do add or extract an abstraction when it removes real duplication, prevents competing logic, or makes an illegal state unrepresentable.
- Make illegal states unrepresentable where practical.
- Delete obsolete code when your change makes it obsolete.
- “Simple” means lower long-term system complexity, not necessarily fewer changed lines or the smallest immediate patch.
- Keep changes coherent and reviewable; avoid unrelated drive-by edits.
- If a refactor is necessary to solve the problem well, do it as part of the same coherent change and explain why.
- If you notice a valuable but unrelated refactor, mention it or ask before doing it.

## Implementation quality

- Read first: inspect existing owners, helpers, harnesses, builders, and patterns before implementing.
- Reuse or extend canonical implementations instead of adding similar-but-different logic.
- Before adding new logic, search by symbol, route/command, config key, feature id, store key, error code, provider id, and test helper to find the existing owner.
- If similar logic already exists, extend or extract the canonical owner instead of creating a second path.
- Keep code with its natural owner: shared primitives in shared packages, package-specific logic in the owning package.
- Prefer focused modules and cohesive folders over god files or grab-bag folders.
- Before handoff, search for stale alternate paths, duplicate registries, leftover compatibility layers, and direct callers that bypass the canonical abstraction.

## Files, folders, and ownership

Prefer small, focused files organized under coherent domain folders.

- Avoid god files. If a file mixes responsibilities or becomes hard to scan, split it into domain-owned pieces.
- Prefer a folder with several focused files over one large file with unrelated sections.
- Reuse the nearest existing domain folder before creating a new top-level folder.
- Keep related behavior together under the same domain owner; do not scatter one feature across unrelated areas.
- When a folder accumulates too many files to scan comfortably, introduce meaningful subfolders and regroup related files by domain/behavior.
- Use folder context to keep filenames short. Do not encode the whole path into the filename.
  - Prefer `agents/providers/claude/install.ts`.
  - Avoid `agents/providers/claude/claudeProviderInstallationManager.ts`.
- Do not create parent folders solely to shorten filenames or satisfy a mechanical split. A nested folder must represent a real domain/subdomain with a coherent owner.
- Compound folder names are acceptable when the compound term is the domain concept. Do not split `terminalHost` into `terminal/host` unless `terminal` is itself a real parent domain with meaningful sibling subdomains.
- Names should be short but purpose-revealing; do not make them cryptic.
- Short generic filenames such as `registry.ts`, `resolve.ts`, `adapter.ts`, or `types.ts` are acceptable only inside a narrow folder that supplies the missing domain context. At broad roots, use more specific names.
- Avoid vague files such as `utils.ts`, `helpers.ts`, `manager.ts`, `misc.ts`, or `common.ts` unless the surrounding folder gives them a narrow, obvious meaning.
- Local one-off helpers should stay near their only use. Shared files should represent a real shared domain concept.
- Split by responsibility/domain boundary, not mechanically one function per file or one noun per folder.

## Renames, moves, and canonical paths

When introducing a new canonical path, finish the migration.

- Update all imports/callers in the same change.
- Do not leave old and new paths in parallel.
- Do not add compatibility shims for internal moves unless explicitly requested or required for a published external API.
- Use codemods/search-replace for broad moves, but verify the result with targeted grep and typecheck.
- Preserve canonical import style:
  - Keep `@/...` aliases in UI code.
  - Do not convert alias imports into fragile long relative imports.
  - Respect package-local aliases and package export boundaries.
- Update related barrels, package exports, tests, docs, mocks, and testkits when they reference the moved path.
- If full migration is genuinely blocked, stop and report `[blocked]` with the exact remaining callers and blocker.

## Path canonicalization

Do not hand-roll `~` or home-directory path handling. Use the owning helper for the layer you edit:

- UI absolute expansion: `apps/ui/sources/utils/path/pathUtils.ts#resolveAbsolutePath`
- UI display formatting: `apps/ui/sources/utils/sessions/formatPathRelativeToHome.ts`
- CLI env/path expansion: `apps/cli/src/utils/path/expandHomeDirPath.ts`
- CLI handoff normalization: `apps/cli/src/session/handoff/paths/sessionHandoffPathNormalization.ts`

When editing path behavior, treat Windows as first-class:

- accept both `~/...` and `~\\...`
- trim trailing `/` and `\\` at the home boundary
- normalize mixed separators when values are used for equality, dedupe, repo identity, or persistence keys
- guard against sibling-prefix collisions (`C:\\Users\\alice` must not match `C:\\Users\\alice2`)

## Provider and catalog architecture

Provider-specific behavior must live behind the canonical catalog/registry surfaces.

- Shared provider facts belong in `packages/agents/*`.
- CLI executable provider wiring belongs in `apps/cli/src/backends/catalog.ts` and `apps/cli/src/backends/<provider>/index.ts`.
- UI provider composition belongs in `apps/ui/sources/agents/registry/*` and `apps/ui/sources/agents/providers/<provider>/*`.
- Internal packages use `src/providers/<providerId>`; `backends/` is reserved for `apps/cli`.
- Protocol provider-specific executable logic/policy/defaults must live under `packages/protocol/src/providers/<providerId>/**` when protocol is the owning layer.
- Shared/core code must not branch on provider names when the behavior can be obtained through a catalog entry, adapter hook, or registry result.
- If a cross-provider feature needs provider-specific behavior, extend the canonical entry/hook shape and implement it in provider-owned modules.

The detailed provider architecture lives in `docs/agents-catalog.md`.

## Feature gating

Use the canonical feature system only. Do not add ad-hoc env checks, direct payload poking, or feature-specific inference logic.

- Feature ids/dependencies live in `packages/protocol/src/features/catalog.ts`.
- Feature decisions live in protocol decision helpers and package-local decision services.
- Server-represented gates are booleans under `features.<featureId path>.enabled`.
- `capabilities` may explain details/diagnostics but must not be used as a gate.
- Treat missing or malformed server enabled bits as disabled. Checks must be `readServerEnabledBit(payload, featureId) === true`.
- Enforce dependencies through `applyFeatureDependencies(...)`; do not duplicate dependency logic at call sites.
- Server route gating must use the central server feature gate helpers.

Details: `docs/feature-gating.md`.

## Encryption storage modes

Happier supports encrypted-at-rest and plaintext-at-rest session storage. This is a storage-mode choice, not a transport/authentication choice.

- Server storage policy: `required_e2ee | optional | plaintext_only`.
- Account/session encryption mode: `e2ee | plain`.
- Message/pending content envelope:
  - encrypted: `{ t: 'encrypted', c: string }`
  - plain: `{ t: 'plain', v: unknown }`
- Always enforce mode/content-kind compatibility at HTTP, socket, and pending write choke points.
- Never assume content is encrypted. Parse the envelope and branch explicitly.
- Plain sessions must not require `encryptedDataKey` for sharing; e2ee sharing/public-share must require a valid encrypted data-key envelope.
- Gate plaintext behavior only through canonical feature ids: `encryption.plaintextStorage`, `encryption.accountOptOut`.

Details: `docs/encryption.md`.

## Binary-safe runtime and internal packages

Happier ships binary installers. First-party runtime paths must work on machines without system `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx`.

- Do not directly spawn `node` or package managers in product runtime paths; use centralized managed runtime/tool abstractions.
- Before adding/changing provider install/update/runtime flows, classify the path as system-first backend CLI, managed-first prerequisite, managed package, vendor install recipe, or managed JS-runtime-dependent.
- Provider detection, install status, daemon validation, runtime spawning, and installables must share the same source of truth.
- Backend CLIs should prefer user/system installs by default unless an explicit source-preference setting says otherwise.
- Internal workspace dependencies must be declared by the package that imports them. Published hosts must bundle the internal workspace dependency closure.

Details: `docs/binary-runtime.md` and `docs/cli-architecture.md`.

## Package-specific instruction highlights

### UI (`apps/ui`)

- Use themed colors/tokens, app text primitives, translated strings, layout width constraints, and the app modal/popover systems.
- Treat UI responsiveness, state continuity, scroll stability, and render efficiency as core UX requirements.
- Do not introduce provider branching in generic UI/sync code; consume provider behavior through the UI registry.
- Follow `apps/ui/AGENTS.md` for UI structure, i18n, typography, settings, modal/popover, and workspace/worktree UX rules.

### CLI (`apps/cli`)

- Keep provider execution in `apps/cli/src/backends/<provider>/**` and shared runtime logic provider-agnostic.
- Preserve file logging/no-console-noise behavior for agent sessions.
- Follow `apps/cli/AGENTS.md` for CLI layout, daemon, backend catalog, binary-runtime, and packaging rules.

### Server (`apps/server`)

- Do not change Prisma schema unless schema/data-model changes are explicitly in scope.
- When schema changes are in scope, own the complete migration work: update schemas, create migrations, inspect SQL, keep affected providers in sync, and validate.
- Migration reset/db-push/custom SQL is allowed when appropriate for the task and target database, but shared/staging/production/user-data databases require explicit approval.
- Use transactions and `afterTx` correctly; do not perform non-transactional side effects inside DB transactions.
- Validate inputs with Zod and keep retryable API operations idempotent.
- Follow `apps/server/AGENTS.md` for server-specific storage/action/privacy rules.

### Stack (`apps/stack`)

- Use `hstack` for stack/worktree/dev/test orchestration.
- Preserve stack-owned process isolation, ephemeral-port behavior, and multi-daemon expectations.
- Follow `apps/stack/AGENTS.md` for stack-specific command discipline and test lanes.

## Context7 and current docs

Use Context7 before implementing or validating work that touches configured post-training packages or when current library/framework/API behavior matters. If Context7 is unavailable, state that and use the best available official docs/source.

## Graphify

This project has a graphify knowledge graph at `graphify-out/`.

- Before architecture/codebase relationship answers, read `graphify-out/GRAPH_REPORT.md` for corpus/community context.
- If `graphify-out/wiki/index.md` exists, navigate it before raw files.
- Prefer graphify queries/paths/explanations for cross-module relationship questions when graphify tooling is available.
- After modifying code files in a session, run `graphify update .` when a shell is available; if not available, report that it remains to do.

## Final handoff

Before finalizing:

- Verify every requested item is covered or marked `[blocked]`.
- Report tests/typechecks/docs checks actually run; do not fabricate evidence.
- Mention any validation you could not run and why.
- For non-trivial behavior changes, report the canonical owner/choke point used and any duplicate or legacy paths removed or intentionally left.
- Ensure no unapproved `*_SUMMARY.md`, `*_ANALYSIS.md`, or similar report files were created.

## Critical reminder

- Do not discard unrelated work.
- Behavior-changing code needs test-first validation.
- Mock only system boundaries, never internal logic.
- Use canonical catalogs/helpers instead of parallel implementations.
- Keep feature gates fail-closed, encryption envelopes explicit, and runtime paths binary-safe.
