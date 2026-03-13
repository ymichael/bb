# Goal

Provide a reusable runbook for auditing Beanbag for cleanup, legacy code, and mid-migration debt so the same process can be rerun later against a newer `main` branch.

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

- Generated code
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

   Also scan plan docs and architecture docs for cleanup work that was identified but not finished.

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

   - orchestrators
   - route handlers
   - large client API/cache hooks
   - event normalization/projection modules
   - repository/data-access layers
   - environment/runtime abstractions
   - large UI components with multiple rendering modes

   Purpose:

   - find parallel code paths that simple keyword search misses
   - surface ownership and contract duplication
   - identify “this file still knows about too many historical states” problems

3. Classify each candidate before recommending deletion or consolidation.

   Use these buckets:

   - `delete`: likely dead or obsolete
   - `finish migration`: compatibility branch exists because a cutover was never completed
   - `consolidate`: repeated internal helpers/types/surfaces should be centralized
   - `keep`: justified compatibility or local complexity with clear ongoing value

   For each candidate, explicitly decide whether the value domain is:

   - `closed_internal`
   - `open_external`

   Rules:

   - For `closed_internal`, tolerance branches and duplicate representations are usually debt.
   - For `open_external`, tolerant parsing/fallbacks may be correct and should not automatically be deleted.

4. Look specifically for the most common debt patterns.

   Pattern A: Parallel internal contracts

   Examples:

   - same resource returned in multiple internal shapes
   - dual internal error formats
   - parallel event families for the same product behavior

   Questions:

   - Is there one canonical internal contract?
   - Why do multiple internal shapes still exist?
   - Can we remove one now, or do we need a bounded compatibility window?

   Pattern B: Historical compatibility carried in steady-state code

   Examples:

   - old persisted DB rows still handled everywhere
   - fixtures preserve long-retired formats
   - projection logic treats historical formats as current inputs

   Questions:

   - Is this still produced today?
   - Is this only for upgraded local data?
   - Can we migrate/prune historical data instead of supporting dual formats indefinitely?

   Pattern C: Ownership migrations that stopped halfway

   Examples:

   - app-local shim re-exporting a package-owned helper
   - duplicate helper logic surviving on both sides of a refactor
   - package exports added, but imports never switched over

   Questions:

   - Which package/file should own this long term?
   - Is the shim still serving a real purpose?
   - Can we switch imports and delete the in-between layer?

   Pattern D: Sync/async or old/new API dual surfaces

   Examples:

   - interfaces require both old and new variants
   - implementations throw “unsupported; use async”
   - call sites preserve fallback branches for both worlds

   Questions:

   - Has one side of the migration already won in practice?
   - Can the interface now be narrowed to the canonical surface?

   Pattern E: Repeated internal parsers, unions, and normalization helpers

   Examples:

   - same event normalization implemented in multiple packages
   - duplicated type unions across packages
   - repeated internal error decoding helpers

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
   - treating all “fallback” comments as debt
   - confusing external tolerance with internal migration debt

6. Prioritize findings by maintenance payoff and risk.

   Use this prioritization model:

   - `P1`: parallel internal contracts or unfinished migrations that materially increase bug surface and code volume
   - `P2`: clear consolidation wins or bounded historical compatibility that should be removed after a nearby migration
   - `P3`: worthwhile cleanup, but lower leverage or lower confidence

   Sort higher when a finding:

   - spans multiple packages
   - forces repeated cache or parser heuristics
   - keeps old and new internal formats alive simultaneously
   - inflates large central files
   - causes duplicate tests/fixtures/docs

   Sort lower when:

   - it is mainly aesthetic
   - it touches only one small local helper
   - it is likely justified `open_external` tolerance

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
      - `rg --files .`

   2. Coarse signal scan

      - `rg -n --hidden -S "TODO|FIXME|deprecated|legacy|migration|migrate|compat|backcompat|fallback|remove after|transitional|temporary|historical" .`

   3. Largest files by package

      - `find <pkg> -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) -not -path '*/generated/*' -not -path '*/dist/*' -print0 | xargs -0 wc -l | sort -nr | head -n 12`

      Run this for:

      - `apps/app`
      - `apps/cli`
      - `apps/daemon`
      - `packages/agent-core`
      - `packages/agent-server`
      - `packages/db`
      - `packages/environment`
      - `packages/environment-agent`
      - `packages/ui-core`
      - any additional active package introduced later

   4. Focused large-file seam scan

      For each large file under review:

      - `rg -n "legacy|deprecated|compat|fallback|migrate|migration|TODO|remove after|temporary|transitional|historical|shim|alias" <file>`
      - `nl -ba <file> | sed -n '<start>,<end>p'`

   5. Contract duplication checks

      Look for repeated helpers/types/normalizers:

      - `rg -n "normalizeThreadEventType\\(" apps packages`
      - `rg -n "extractErrorMessage\\(value: unknown\\)|LEGACY_ERROR_KEYS|ERROR_KEYS" apps packages`
      - `rg -n "type EnvironmentCapability =|type EnvironmentCapabilities = Record<EnvironmentCapability" apps packages`

   6. Parallel surface checks

      Look for dual internal shapes and option forks:

      - `rg -n "includeWorkStatus|placeholderData|fallbackMatch|canonical|parallel|historical|pruneHistorical" apps packages`
      - `rg -n "Synchronous .* unsupported; use .*Async|unsupported; use .*Async" apps packages`

   7. Historical compatibility validation

      Look for evidence that old paths are still produced versus only historically preserved:

      - `rg -n "shouldPersistEvent|startsWith\\(\"codex/event/\"\\)|pruneHistoricalNoiseByThread|legacy raw provider payload" apps packages`
      - inspect representative fixtures and tests tied to the finding

   Output discipline:

   - Save findings in a dedicated Markdown doc under `plans/`.
   - Save any broader migration design in a separate plan doc under `plans/`.
   - Save PR sequencing in a backlog doc under `plans/`.
   - Delete or supersede stale plan docs when the audit is rerun and conclusions materially change.

# Validation

- Confirm that each finding cites at least one production file and one supporting piece of evidence where applicable.
- Confirm each finding is classified as `closed_internal` debt, `open_external` tolerance, or an ownership migration.
- Confirm each proposed deletion/consolidation has a plausible validation path:
  - package-scoped typecheck
  - focused tests
  - daemon QA where relevant
  - manual UI verification where relevant
- Before closing an audit pass, ensure it produced:
  - a findings doc
  - at least one plan doc if the findings imply coordinated migration work
  - an execution backlog if work is expected to span multiple PRs
- Confirm the command checklist was actually followed for the major packages, especially the largest production files in each package.

# Open Questions/Risks

- Historical local-data compatibility is easy to preserve indefinitely by inertia; each audit pass should ask whether the supported upgrade boundary is still intentional.
- Mixed-version local development can justify temporary compatibility windows; if so, the removal point should be documented up front.
- Large-file audits can overcount “duplication” unless external-vs-internal ownership is classified carefully.
- Cleanup work can become noisy if plans are not split into contract migration first, consolidation second, and fixture/doc pruning last.
