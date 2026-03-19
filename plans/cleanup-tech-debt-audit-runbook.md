# Goal

Provide a reusable runbook for auditing the bb monorepo for cleanup, legacy code, and mid-migration debt so the same process can be rerun later against a newer `main` branch.

This runbook is not a one-time findings doc. It is a repeatable method for:

- finding likely cleanup candidates
- separating justified compatibility from stale internal debt
- prioritizing what to delete, finish, or consolidate
- turning findings into implementation-ready plan docs and PR slices

# Scope

In scope:

- Unused or legacy internal code paths
- Parallel internal surfaces that should be canonicalized
- Mid-migration compatibility branches
- Repeated internal helpers/types that create drift and repeated bugs
- Large-file audits for architectural and ownership seams
- Historical compatibility that may have outlived its purpose

Out of scope:

- Generated code under `packages/core/src/generated/**`
- Pure formatting/style cleanup
- Normal open-ended tolerance for external/upstream/provider-owned payloads unless it leaks into internal contracts
- One-off micro-optimizations without clear maintenance payoff

# Implementation Steps

1. Start with a coarse repository scan for migration and compatibility signals.

   Look for:

   - `legacy`
   - `deprecated`
   - `compat`
   - `backward`
   - `fallback`
   - `migration`
   - `migrate`
   - `shim`
   - `temporary`
   - `transitional`
   - `remove after`
   - `historical`

   Also scan plan docs under `plans/` and architecture docs for cleanup work that was identified but not finished.

   Purpose:

   - build an initial candidate list quickly
   - find active or abandoned migrations
   - identify likely package boundaries to inspect more deeply

2. Rank files by size and audit the largest production files package by package.

   For each package:

   - list the largest non-generated source files by line count
   - inspect the largest production files first
   - treat tests as supporting evidence, not the primary source of truth

   Prioritize files that usually accumulate migration debt:

   - the orchestrator (`apps/server/src/orchestrator.ts` — the largest production file in the repo)
   - UI-to-event transformation layers (`packages/core/src/to-ui-messages.ts`, `packages/core/src/thread-detail-rows.ts`)
   - event normalization (`packages/core/src/thread-event-normalization.ts`)
   - environment provisioning (`apps/server/src/environment-provisioning-systems.ts`, `apps/server/src/environment-service.ts`)
   - environment daemon session management (`apps/server/src/environment-daemon-session-service.ts`, `apps/server/src/environment-daemon-session-compatibility.ts`)
   - provider session control (`apps/server/src/provider-session-controller.ts`)
   - the provider bridge layers (`packages/claude-code-bridge/src/bridge.ts`, `packages/pi-bridge/src/bridge.ts`)
   - the environment daemon runtime (`packages/environment-daemon/src/runtime.ts`, `packages/environment-daemon/src/service.ts`)
   - repository/data-access layers (`packages/db/src/repositories.ts`, `packages/db/src/environment-daemon-repositories.ts`)
   - the frontend thread detail view (`apps/app/src/views/ThreadDetailView.tsx`)
   - the app API layer (`apps/app/src/lib/api.ts`, `apps/app/src/hooks/useApi.ts`)
   - git workspace management (`packages/environment/src/git-workspace.ts`, `packages/environment/src/local-git-workspace.ts`)

   Purpose:

   - find parallel code paths that simple keyword search misses
   - surface ownership and contract duplication
   - identify "this file still knows about too many historical states" problems

3. Classify each candidate before recommending deletion or consolidation.

   Use these buckets:

   - `delete`: likely dead or obsolete
   - `finish migration`: compatibility branch exists because a cutover was never completed
   - `consolidate`: repeated internal helpers/types/surfaces should be centralized
   - `keep`: justified compatibility or local complexity with clear ongoing value

   For each candidate, explicitly decide whether the value domain is:

   - `closed_internal` — BB-owned types, unions, and protocols (e.g., `ThreadStatus`, `ThreadEventType`, `AppThreadEventType`, `EnvironmentCapability`, `ThreadProviderId`)
   - `open_external` — provider/runtime-owned values (e.g., Codex server notification methods, OpenAI response payloads, Claude Code SDK events)

   Rules:

   - For `closed_internal`, tolerance branches and duplicate representations are usually debt. These should use exhaustive `switch` with `assertNever` (from `@bb/core`), not permissive `default` branches.
   - For `open_external`, tolerant parsing/fallbacks may be correct and should not automatically be deleted. Unknown values should have an explicit comment that they are intentional.

4. Look specifically for the most common debt patterns.

   Pattern A: Parallel internal contracts

   Examples:

   - same resource returned in multiple internal shapes (e.g., dual Thread representations, parallel UI message types)
   - dual internal error formats (e.g., `HttpError` in `apps/app/src/lib/api.ts` vs server-side `errorResponse` in `apps/server/src/routes/error-response.ts`)
   - parallel event families for the same product behavior (e.g., overlapping `AppThreadEventType` entries that cover similar ground)

   Questions:

   - Is there one canonical internal contract?
   - Why do multiple internal shapes still exist?
   - Can we remove one now, or do we need a bounded compatibility window?

   Pattern B: Historical compatibility carried in steady-state code

   Examples:

   - old persisted DB rows still handled everywhere (check `packages/db/src/repositories.ts` for row shape fallbacks)
   - fixtures preserve long-retired formats (check test helpers under `apps/server/src/__tests__/helpers/`)
   - projection logic in `to-ui-messages.ts` treats historical formats as current inputs
   - `legacyKeys` in error extraction (`apps/app/src/lib/api.ts`)

   Questions:

   - Is this still produced today?
   - Is this only for upgraded local data?
   - Can we migrate/prune historical data instead of supporting dual formats indefinitely?

   Pattern C: Ownership migrations that stopped halfway

   Examples:

   - app-local helper duplicating a `@bb/core` export (e.g., thread helpers in `apps/app/src/lib/` vs `packages/core/src/`)
   - `apps/app/src/lib/thread-context-window-usage.ts` alongside `packages/core/src/thread-context-window-usage.ts`
   - provider adapter logic shared between `packages/provider-adapters/src/` and bridge packages (`packages/claude-code-bridge/`, `packages/pi-bridge/`)
   - re-exports or shims that could be replaced by direct imports from the owning package

   Questions:

   - Which package/file should own this long term?
   - Is the shim still serving a real purpose?
   - Can we switch imports and delete the in-between layer?

   Pattern D: Old/new API dual surfaces

   Examples:

   - the legacy `api.ts` fetch wrapper (`apps/app/src/lib/api.ts`) alongside the typed Hono RPC client (`apps/app/src/lib/api-client.ts` via `hc<AppType>`)
   - `useApi` hook patterns using the old client vs direct typed RPC calls
   - older CLI client patterns (`apps/cli/src/client.ts`) vs current server API shape

   Questions:

   - Has one side of the migration already won in practice?
   - Can the interface now be narrowed to the canonical surface?
   - Are there call sites still using the old fetch wrapper that could use the typed RPC client?

   Pattern E: Repeated internal parsers, unions, and normalization helpers

   Examples:

   - `normalizeThreadEventType` and `decodeThreadEventData` in `packages/core/src/thread-event-normalization.ts` — verify all consumers use the shared version
   - `extractErrorMessage` and `toRecord` in `packages/core/src/unknown-helpers.ts` — check for local duplicates
   - `assertNever` exported from both `packages/core/src/assert-never.ts` and `apps/cli/src/assert-never.ts`
   - type unions like `EnvironmentCapability`, `ThreadWorkState`, `ThreadStatus` — check for unguarded string casts or local re-declarations
   - wire decoders in `packages/core/src/wire-decoders.ts` — check for inline decoding logic elsewhere that should use these

   Questions:

   - Is there already a shared owner for this logic?
   - Does the duplication create drift risk?
   - Should this be consolidated immediately or only after a migration lands?

5. Verify candidate findings with direct evidence before writing them up.

   For each finding:

   - identify the primary production file(s)
   - identify any supporting tests/fixtures/docs
   - confirm whether the old path is still produced, still consumed, or only preserved historically

   Avoid:

   - inferring dead code solely from names
   - treating all "fallback" comments as debt
   - confusing external tolerance with internal migration debt

6. Prioritize findings by maintenance payoff and risk.

   Use this prioritization model:

   - `P1`: parallel internal contracts or unfinished migrations that materially increase bug surface and code volume
   - `P2`: clear consolidation wins or bounded historical compatibility that should be removed after a nearby migration
   - `P3`: worthwhile cleanup, but lower leverage or lower confidence

   Sort higher when a finding:

   - spans multiple packages (e.g., core + server + app)
   - forces repeated decoder or parser heuristics
   - keeps old and new internal formats alive simultaneously
   - inflates large central files (especially `orchestrator.ts` or `to-ui-messages.ts`)
   - causes duplicate tests/fixtures/docs

   Sort lower when:

   - it is mainly aesthetic
   - it touches only one small local helper
   - it is likely justified `open_external` tolerance (e.g., Codex notification fallback handling)

7. Produce three outputs from each audit pass.

   Output A: Audit findings doc

   Contents:

   - ranked findings by severity
   - package/file evidence
   - rationale
   - recommended action: delete, finish migration, consolidate, or keep

   Output B: Detailed migration/cleanup plan

   Contents:

   - goal
   - scope
   - implementation steps
   - validation
   - open questions/risks

   Use this when multiple related findings belong to the same broader cleanup effort.

   Output C: Execution backlog

   Contents:

   - PR-sized slices
   - dependencies between slices
   - likely files/packages touched
   - validation expectations per slice

8. Re-run after major changes land.

   This runbook is designed to be rerun:

   - after major migrations merge
   - after branch rebases onto newer `main`
   - before broad cleanup initiatives
   - after large package ownership moves

   On rerun:

   - reuse the same search terms and file-size ranking
   - compare old findings docs against current state
   - delete obsolete plans under `plans/` when superseded
   - produce a fresh audit doc rather than silently editing stale conclusions

9. Follow an operational command checklist during each audit pass.

   Recommended sequence:

   - check worktree state
   - scan for migration/compatibility markers
   - rank large source files by package
   - inspect the largest production files directly
   - validate candidate findings with targeted searches
   - write findings, plan, and backlog docs

   Suggested command checklist:

   1. Workspace state

      - `git status --short`
      - `pnpm exec turbo run typecheck` (full monorepo typecheck)

   2. Coarse signal scan

      - `rg -n -S "TODO|FIXME|deprecated|legacy|migration|migrate|compat|backcompat|fallback|remove after|transitional|temporary|historical|shim" apps packages --glob '!**/generated/**' --glob '!**/dist/**' --glob '!**/node_modules/**'`

   3. Largest files by package

      - `find <pkg> -type f \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/generated/*' -not -path '*/dist/*' -not -path '*/node_modules/*' -print0 | xargs -0 wc -l | sort -nr | head -n 12`

      Run this for each active package:

      - `apps/app` (frontend — largest files: ThreadDetailView.tsx, useApi.ts, api.ts)
      - `apps/cli` (CLI — largest files: commands/thread.ts, commands/manager.ts)
      - `apps/server` (BB server — largest files: orchestrator.ts, environment-service.ts, environment-daemon-session-service.ts, environment-provisioning-systems.ts, provider-session-controller.ts)
      - `packages/core` (shared types/contracts — largest files: to-ui-messages.ts, thread-detail-rows.ts, thread-event-normalization.ts, api-types.ts, types.ts)
      - `packages/db` (SQLite persistence — largest files: repositories.ts, environment-daemon-repositories.ts, schema.ts)
      - `packages/environment` (environment abstractions — largest files: git-workspace.ts, docker-environment.ts, local-git-workspace.ts)
      - `packages/environment-daemon` (env-daemon runtime — largest files: runtime.ts, session-protocol.ts, session-supervisor.ts, session-runtime.ts, service.ts)
      - `packages/provider-adapters` (multi-provider adapters — claude-code-provider-adapter.ts, codex-provider-adapter.ts, pi-provider-adapter.ts, openai-responses-model.ts)
      - `packages/claude-code-bridge` (Claude Code SDK bridge — bridge.ts, event-translator.ts, sdk-session.ts)
      - `packages/pi-bridge` (Pi SDK bridge — bridge.ts, event-translator.ts, sdk-session.ts)
      - `packages/ui-core` (shared UI primitives — detail-card.tsx, disclosure.tsx, prompt-composer.tsx, status-pill.tsx)
      - `packages/templates` (template registry and rendering)

   4. Focused large-file seam scan

      For each large file under review:

      - `rg -n "legacy|deprecated|compat|fallback|migrate|migration|TODO|FIXME|remove after|temporary|transitional|historical|shim|alias" <file>`

   5. Contract duplication checks

      Look for repeated helpers/types/normalizers:

      - `rg -n "normalizeThreadEventType\(" apps packages --glob '!**/generated/**'`
      - `rg -n "extractErrorMessage\(" apps packages --glob '!**/generated/**'`
      - `rg -n "assertNever\(" apps packages --glob '!**/generated/**'`
      - `rg -n "type EnvironmentCapability " apps packages --glob '!**/generated/**'`
      - `rg -n "decodeThreadEventData\(" apps packages --glob '!**/generated/**'`
      - `rg -n "isRecord\(|toRecord\(" apps packages --glob '!**/generated/**'`

   6. Parallel surface checks

      Look for dual internal shapes and API surface forks:

      - `rg -n "hc<AppType>|apiClient|from.*api-client|from.*\/api" apps/app/src --glob '*.{ts,tsx}'` (old vs typed RPC client usage)
      - `rg -n "legacyKeys|fallbackMatch|placeholderData" apps packages --glob '!**/generated/**'`
      - `rg -n "ProviderEventEnvelope|unwrapProviderEventPayload|isProviderEventEnvelope" apps packages --glob '!**/generated/**'`
      - `rg -n "assessEnvironmentDaemonSessionCompatibility|ENVIRONMENT_DAEMON_PROTOCOL_VERSION" apps packages --glob '!**/generated/**'`

   7. Historical compatibility validation

      Look for evidence that old paths are still produced versus only historically preserved:

      - `rg -n "PROVIDER_EVENT_ENVELOPE_VERSION|PROVIDER_EVENT_ENVELOPE_SCHEMA" apps packages --glob '!**/generated/**'`
      - `rg -n "PersistedThreadEventData|PersistedEnvironmentRecord" apps packages --glob '!**/generated/**'`
      - `rg -n "legacyKeys|as Record<string, unknown>" apps packages --glob '!**/generated/**' --glob '!**/node_modules/**'`
      - inspect representative fixtures and tests under `apps/server/src/__tests__/` tied to the finding

   8. Package-scoped validation

      After identifying cleanup targets, validate with targeted typechecks:

      - `pnpm exec turbo run typecheck --filter=@bb/core`
      - `pnpm exec turbo run typecheck --filter=@bb/server`
      - `pnpm exec turbo run typecheck --filter=@bb/app`
      - `pnpm exec turbo run typecheck --filter=@bb/db`
      - `pnpm exec turbo run typecheck --filter=@bb/environment`
      - `pnpm exec turbo run typecheck --filter=@bb/environment-daemon`
      - `pnpm exec turbo run typecheck --filter=@bb/provider-adapters`
      - `pnpm exec turbo run typecheck --filter=@bb/claude-code-bridge`
      - `pnpm exec turbo run typecheck --filter=@bb/pi-bridge`
      - `pnpm exec turbo run typecheck --filter=@bb/ui-core`

   Output discipline:

   - Save findings in a dedicated Markdown doc under `plans/`.
   - Save any broader migration design in a separate plan doc under `plans/`.
   - Save PR sequencing in a backlog doc under `plans/`.
   - Delete or supersede stale plan docs when the audit is rerun and conclusions materially change.

# Validation

- Confirm that each finding cites at least one production file and one supporting piece of evidence where applicable.
- Confirm each finding is classified as `closed_internal` debt, `open_external` tolerance, or an ownership migration.
- Confirm each proposed deletion/consolidation has a plausible validation path:
  - package-scoped typecheck via `pnpm exec turbo run typecheck --filter=@bb/<pkg>`
  - focused tests (unit tests colocated with source, or `apps/server/src/__tests__/`)
  - e2e server scenarios under `apps/server/src/__tests__/e2e/`
  - surface-based QA docs under `qa/` (start at `qa/README.md`; use `qa/legacy/server/standalone-server-qa.md` only for the remaining umbrella standalone checklist)
  - manual UI verification where relevant (the app runs at `http://localhost:5173/`)
- Before closing an audit pass, ensure it produced:
  - a findings doc
  - at least one plan doc if the findings imply coordinated migration work
  - an execution backlog if work is expected to span multiple PRs
- Confirm the command checklist was actually followed for the major packages, especially the largest production files in each package.

# Open Questions/Risks

- Historical local-data compatibility is easy to preserve indefinitely by inertia; each audit pass should ask whether the supported upgrade boundary is still intentional.
- Mixed-version local development can justify temporary compatibility windows; if so, the removal point should be documented up front.
- Large-file audits can overcount "duplication" unless external-vs-internal ownership is classified carefully. In particular, `open_external` tolerance for Codex server notifications, Claude Code SDK events, and Pi SDK events is not debt.
- The provider bridge symmetry between `packages/claude-code-bridge` and `packages/pi-bridge` is by design; structural similarity is not duplication when the bridges adapt different external SDKs.
- The Hono RPC migration (`api-client.ts` typed client vs legacy `api.ts` fetch wrapper) may still be in progress; verify before classifying the old client as dead code.
- Cleanup work can become noisy if plans are not split into contract migration first, consolidation second, and fixture/doc pruning last.
- Environment daemon protocol versioning (`ENVIRONMENT_DAEMON_PROTOCOL_VERSION`) and session compatibility checks are intentional forward-compatibility infrastructure; do not treat as debt unless clearly unused.
