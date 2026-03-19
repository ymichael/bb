# QA Coverage Audit

This document tracks what the new QA structure already covers well and where the depth is still thin.

## Tester-Pass Notes

Reviewing the new QA system like a future tester surfaces these rough edges:

- the top-level docs need to map requests to both docs and commands, not just docs
- some surfaces still lack an exact scripted alias for their default pass
- provider depth is easy to understand conceptually, but the automated slices are still named around the older server-centric history
- CLI QA is now structurally clear, but still lighter on explicit automation than the other surfaces
- a tester-style dry run found that one early CLI smoke alias was accidentally wired to a fake-only test; the process should keep favoring real-provider-compatible scripts for public entrypoints
- a later tester-style dry run found that `qa:e2e:smoke` still included fake-only skipped tests and that the stress path had a broken restart filename; both are the kind of rough edge the public QA entrypoints should avoid
- the env-daemon recovery alias also needed tightening so the named pass resolves to the deterministic fake-provider suite rather than a mostly-skipped transitional real-provider script

The sections below track the substantive depth gaps by surface, not just the usability gaps.

## Current Strengths

### Server / E2E smoke

Already covered by checked-in automation:

- immediate follow-ups
- worktree follow-up
- primary checkout coherence
- shared environment roundtrip
- dynamic tools roundtrip

Representative files:

- `apps/server/src/__tests__/e2e/thread-immediate-followups-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-worktree-primary-checkout-roundtrip.test.ts`

### Env-daemon recovery

Already covered by checked-in automation:

- deterministic reconnect-after-restart and worker-loss recovery through the fake-provider suite
- provisioning responsiveness
- concurrent multi-thread stress

Representative files:

- `apps/server/src/__tests__/e2e/environment-daemon-restart-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-restart-recovery-matrix.test.ts`
- `apps/server/src/__tests__/e2e/thread-recovery-heavy-runbook.test.ts`
- `apps/server/src/__tests__/e2e/thread-multi-thread-stress.test.ts`

### Environments

Already covered by checked-in automation:

- worktree follow-up
- primary checkout behavior
- shared environment sibling behavior

Representative files:

- `apps/server/src/__tests__/e2e/thread-worktree-followup-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-worktree-primary-checkout-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/thread-shared-environment-roundtrip.test.ts`

### Providers

Already covered well enough for a baseline:

- provider smoke through shared/provider-specific smoke aliases
- dynamic tool roundtrip for real-provider paths

Representative files:

- `apps/server/src/__tests__/e2e/dynamic-tools-server-roundtrip.test.ts`
- `apps/server/src/__tests__/e2e/codex-dynamic-tools-server-roundtrip.test.ts`

## Current Gaps

### Server core still leans on older automation naming

What is weak today:

- server docs are clear, but the default server pass still maps to older `qa:server:*` names rather than a dedicated `qa:server:core`
- route/API contract checks and restart-visible-state checks are not clearly separated in automation
- real-provider smoke does not yet include a server-restart sanity check, so restart confidence still comes from deeper or fake-only paths

Recommended next depth increase:

- add a dedicated server-core automation alias or slice once the intended checklist is stable
- split route/API-focused checks from deeper restart-focused checks if the server surface grows further
- add one honest real-provider restart sanity slice if the harness can support it cheaply

### Env-daemon recovery still depends on fake-provider control hooks

What is weak today:

- the deterministic recovery path is now honestly exposed, but it still depends on fake-provider control hooks
- the broader real-provider stress path is useful as supplemental signal, not as the primary recovery entrypoint

Recommended next depth increase:

- add one or two real-provider recovery scenarios that can survive as non-skipping public commands
- keep the fake-provider recovery suite for exact worker-loss injection and stale-session control

### Provider depth is still too implicit

What is weak today:

- the shared provider matrix is documented, but most automated coverage is still embedded in server/e2e naming
- provider-specific overlays exist, but they do not yet contain explicit provider-only regressions or exclusions beyond setup notes
- multi-turn, context-preservation, and system-instruction checks are not yet called out as clearly named automated slices

Recommended next depth increase:

- add provider-focused automation entrypoints that map directly to the shared provider matrix
- add short provider overlay docs for known exclusions or provider-specific regressions as they appear
- add explicit coverage for multi-turn, context preservation, and system instructions as first-class scripted checks

### CLI depth is still mostly embedded in standalone flows

What is weak today:

- CLI smoke now has a dedicated entrypoint, but deeper CLI coverage is still thinner than the other surfaces
- most CLI depth still depends on broader standalone or e2e flows

Recommended next depth increase:

- keep the new CLI smoke slice, then define a deeper CLI-focused pass around inspection surfaces and control-plane commands
- add a second CLI-focused scripted slice if the current e2e harness supports it cheaply

### Environment depth can still go deeper on implicit attachment behavior

What is weak today:

- explicit worktree and shared-environment behavior is covered better than implicit local-environment attachment behavior
- attachment invariants are still easiest to infer from the shared-environment tests rather than a dedicated environment-focused slice

Recommended next depth increase:

- keep the new environment core slice, then add a more explicit check for implicit local-environment attachment and sibling reuse

### Regression depth is only partly normalized

What is weak today:

- owned regression docs now exist for `server` and `env-daemon`, but they are still seed catalogs rather than a full curated regression history
- some older regression knowledge still only exists implicitly in e2e scenario files or the newer deterministic recovery suite instead of curated regression docs

Recommended next depth increase:

- add concrete regression entries to the owned docs as fixes land
- lift high-value regression repros out of e2e scenario files and the fake recovery suite into the owned regression catalogs when they become stable operator checks

### Product QA is still detailed but not yet normalized

What is weak today:

- manager QA now has a normalized entrypoint, but the detailed history still lives in two larger supporting docs

Recommended next depth increase:

- keep adding new manager scenarios through `qa/product/manager-mode.md`
- fold duplicate scenario text out of the older supporting docs over time if they become hard to maintain

## Recommended Priority Order

1. Provider depth and explicit provider automation naming
2. CLI-focused smoke/core pass
3. Environment-focused attachment/reuse depth
4. Server-core automation naming that matches the docs
