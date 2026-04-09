# Agent Provider Package Extraction

## Status

- Draft
- Phase 0 complete
- Phase 1 complete
- Phase 2 complete
- Phase 3 in progress

## Goal

Extract shared provider, auth, secret-storage, and runtime-material logic out of `apps/server` into reusable packages with clear one-way dependencies, while keeping server and daemon orchestration in the apps that own it.

## Proposed Packages

### Rename `@bb/provider-audit` -> `@bb/agent-provider-audit`

Purpose:
- Keep provider-related package naming aligned under the `agent-provider-*` family

Why:
- `@bb/provider-audit` predates the proposed extraction names
- once `@bb/agent-providers` and `@bb/agent-provider-auth` exist, the old name becomes the odd one out
- the renamed package will read as part of the same provider architecture instead of a generic audit utility

Expected impact:
- mostly package rename and import-path churn
- little or no ownership change

### `@bb/agent-providers`

Purpose:
- Shared provider catalog and capability declarations
- Provider IDs, display names, default models, auth modes, and runtime compatibility

Should own:
- Shared provider/domain metadata currently duplicated across server, app, and `@bb/agent-runtime`
- Runtime consumer relationships such as:
  - Codex subscription auth -> Codex CLI
  - Codex subscription auth -> Pi `openai-codex`
  - Claude subscription auth -> Claude Code
  - Claude subscription auth -> Pi `anthropic`

Should not own:
- OAuth exchange/refresh
- DB/storage
- runtime execution

Estimated code moved:
- Out of `apps/server`: `120-220` LOC
- Out of `packages/agent-runtime`: `80-140` LOC
- Out of `apps/app`: `30-80` LOC

### `@bb/agent-provider-auth`

Purpose:
- Provider-specific auth logic and auth materialization

Should own:
- OAuth provider definitions
- Exchange and refresh behavior
- Account metadata extraction and label derivation
- Credential serialization/deserialization codecs
- Sandbox auth material builders for Claude, Codex, and Pi subscription auth

Should not own:
- HTTP routes
- OAuth attempt state machines
- DB orchestration
- runtime execution

Estimated code moved:
- Out of `apps/server`: `900-1050` LOC

### `@bb/secret-storage`

Purpose:
- Installation-local secret files and encryption primitives

Should own:
- File-backed secret creation/loading
- AES-GCM helpers for encrypted strings / JSON payloads

Should not own:
- provider-specific auth logic
- DB code

Estimated code moved:
- Out of `apps/server`: `160-190` LOC

### `@bb/host-runtime-material`

Purpose:
- Shared runtime-material snapshot semantics and managed-file rules

Should own:
- Runtime material snapshot/value types
- Versioning and hashing helpers
- Managed file normalization rules
- Shared file/path semantics that server and daemon both rely on

Should not own:
- server lifecycle orchestration
- daemon command dispatch

Estimated code moved:
- Out of `apps/server`: `120-200` LOC
- Out of `apps/host-daemon`: `90-140` LOC

## Dependency Rules

Required dependency shape:

- `@bb/agent-providers`
  - no dependency on `apps/server`, `apps/host-daemon`, or `@bb/agent-runtime`
- `@bb/agent-provider-auth`
  - may depend on `@bb/agent-providers`
  - may depend on `@bb/secret-storage`
  - must not depend on `@bb/agent-runtime`
- `@bb/agent-runtime`
  - may depend on `@bb/agent-providers`
  - must not depend on `@bb/agent-provider-auth`
- `apps/server`
  - may depend on `@bb/agent-providers`
  - may depend on `@bb/agent-provider-auth`
  - may depend on `@bb/host-runtime-material`
  - must not depend on `@bb/agent-runtime`
- `apps/host-daemon`
  - may depend on `@bb/agent-providers`
  - may depend on `@bb/host-runtime-material`
  - should not depend on `@bb/agent-provider-auth`

## Non-Goals

- Do not extract `host-lifecycle.ts` orchestration into a new package yet
- Do not move server routes or daemon command handlers into packages
- Do not change product behavior as part of the first extraction pass

## Migration Order

### Phase 0: rename `@bb/provider-audit`

Rename `@bb/provider-audit` to `@bb/agent-provider-audit` first so the provider package family is coherent before new packages land.

Exit criteria:
- package name and import paths are updated everywhere
- no behavioral changes

Status:
- Complete

### Phase 1: `@bb/agent-providers`

Move shared provider declarations first so server, app, and runtime consume one catalog.

Exit criteria:
- provider IDs, display names, default-model declarations, and auth capability metadata are no longer duplicated across server/app/runtime
- `apps/server` does not import provider facts from `@bb/agent-runtime`

### Phase 2: `@bb/secret-storage`

Extract encryption and file-backed secret helpers next.

Exit criteria:
- cloud auth and sandbox env encryption use `@bb/secret-storage`
- no cloud-auth-specific crypto helpers remain under `apps/server/src/services/lib`

### Phase 3: `@bb/agent-provider-auth`

Move provider auth logic out of server while leaving route/service orchestration in `apps/server`.

Exit criteria:
- provider OAuth definitions, metadata extraction, storage codecs, and auth material builders live in `@bb/agent-provider-auth`
- `apps/server` cloud-auth service becomes orchestration-only

### Phase 4: `@bb/host-runtime-material`

Extract shared runtime-material semantics last, once provider materializers are stable.

Exit criteria:
- snapshot versioning and managed-file semantics live outside `apps/server` and `apps/host-daemon`
- server and daemon both consume the same shared runtime-material model

## Validation

For each phase:

- `pnpm exec turbo run typecheck --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/agent-runtime --force`
- package-specific tests for any new package
- existing server and daemon tests stay green
- `rg` import scan confirms the intended dependency shape

For the full extraction:

- live cloud auth / sandbox smoke still passes via [e2b-smoke.mts](/Users/michael/.codex/worktrees/34d8/bb/scripts/qa/e2b-smoke.mts)
- no import edge from `apps/server` to `@bb/agent-runtime`
- no import edge from `@bb/agent-runtime` to `@bb/agent-provider-auth`

## Completion Bar

This plan is complete when:
- the four packages exist with the boundaries above
- server and daemon orchestration remain in app packages
- provider facts are declared once in `@bb/agent-providers`
- the dependency rules above are enforced by actual imports

Delete this plan after the extraction is finished or replaced by a more detailed implementation plan.
