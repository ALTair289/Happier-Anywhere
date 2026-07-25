# Evidence Contract

Every lane must leave evidence under the live workspace `evidence/` or in an existing repo log path referenced from the lane document.

Good evidence:
- exact command run
- start/end timestamp
- exit code
- concise output summary
- full log path when logs are large
- environment identity: OS, arch, VM name, host, port, release channel, candidate version
- account/browser state identity for auth/session continuity flows
- before/after version and daemon/service status for upgrade flows
- artifact source for installer/update/release-validation lanes: immutable stable/preview component version tag and commit (rolling tag only as discovery), published artifact URL/release evidence and checksum when practical, or local candidate path/URL plus destination path for VM/Windows transfers
- compatibility direction: old/new producer and consumer roles, upgrade/coexistence/rollback reason, and `required`/`unreachable`/`unsupported` classification
- persisted-state provenance: which exact version created the session/settings/queue/service state later read or migrated by the candidate
- targeted RED/GREEN proof for behavior-changing fixes
- broader rerun proof before lane completion

Bad evidence:
- “looks good” without command/log/observable result
- screenshots as the only proof
- manual notes that do not identify account/server/daemon state
- claims that a fix is complete without rerun evidence
- “compatible with preview/stable” without component-specific immutable tag/artifact provenance and the direction actually exercised
- historical fixtures reconstructed solely from current types or current implementation logic

Reviewer agents must mark a lane `NEEDS-MORE-EVIDENCE` if the lane claim is not supported by evidence paths.
