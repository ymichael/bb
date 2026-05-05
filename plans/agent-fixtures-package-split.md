# `@bb/agent-provider-audit` → `@bb/agent-fixtures`

## Problem

`@bb/agent-provider-audit` was built as an audit harness: capture provider
runs, replay them offline, and produce coverage summaries that flag
untranslated events, unhandled tool calls, missing token-usage metadata,
and visual rendering regressions. That role made sense when provider
adapters were under heavy churn and we couldn't trust translation across
Claude / Codex / Pi.

Translation has stabilized. Coverage analysis is no longer a primary
concern. What's still load-bearing in the package is much narrower:

1. The on-disk corpus of recorded provider runs.
2. A replay engine that loads a fixture and runs it through
   `@bb/agent-runtime` to produce thread events / timeline rows.
3. The capture path that records new fixtures.

Everything else — coverage summarizers, audit artifact JSON, Ladle visual
review, the 9300-line replay-fixtures snapshot, fixture-import bridges —
is audit infrastructure that has outlived its job. Keeping it around
means a fixture package that's mostly audit code, depends on `@bb/ui-core`
and Ladle, and has a CLI surface that bears no resemblance to its
remaining purpose.

This plan strips the package down to its narrow remaining role and
renames it accordingly.

## Goal

1. Rename the package to `@bb/agent-fixtures`.
2. Keep only what powers the corpus, the loader, the replay engine, and
   the capture path. Delete the audit harness, the Ladle integration, and
   the import bridges.
3. Reduce the CLI to three subcommands: `capture`, `replay`, `promote`.
4. Replace the audit-flavored snapshot tests with a small smoke test.
5. Update the two real consumers (`apps/server`'s timeline benchmark and
   the package's own tests) to the new shape.

## Non-goals

- Implementing apps/app Ladle stories that consume the fixtures. That's
  the UI plan's job. This plan ends at the data boundary.
- Changing the on-disk format. That's the format-unification plan's job. This
  split should land immediately before, or in the same implementation stack as,
  format unification so the corpus schema has its final package home from the
  first format implementation commit.
- Moving fixture files out of the package. They stay at
  `packages/agent-fixtures/fixtures/`. The repo-relative path matters for
  `apps/server/test/helpers/timeline-benchmark.ts`.
- Building new translation/coverage regression tests. If `@bb/thread-view`
  or `@bb/agent-runtime` need regression coverage, they should own those
  tests; they're not this package's responsibility.

## Sequencing

Preferred order: land this plan immediately before, or in the same
implementation stack as, `plans/replay-fixture-format-unification.md`:

- The unification plan commits `fixtureManifestSchema` to
  `@bb/agent-fixtures`. Giving that schema its final package home from the first
  format implementation commit avoids adding it under the legacy audit package
  and renaming it later.
- The final package is data-only. Keeping this split close to format
  unification prevents the unified fixture reader from growing temporary
  React/Ladle consumers.
- The unification plan's temporary corpus migration script lives at
  `packages/agent-fixtures/scripts/migrate-fixtures.ts` in the preferred stack
  and is deleted after the migration ships.

If format unification is already underway before this plan lands, it may update
legacy paths temporarily, including the old visual-audit consumer, but the final
`@bb/agent-fixtures` state in this plan must not retain `visual-audit.ts`,
`.ladle/`, or `ladle:*` scripts.

This plan also pairs with `plans/ui-and-stories-consolidation.md`, which
absorbs Ladle into apps/app. Coordinate so apps/app's Ladle decorator
copies what it needs from `agent-provider-audit/.ladle/components.tsx`
before this plan deletes it.

## Design

### Final package shape

```
packages/agent-fixtures/
├── package.json                    // name: "@bb/agent-fixtures"
├── README.md
├── tsconfig.json
├── tsconfig.typecheck.json
├── vitest.config.ts
├── fixtures/                       // corpus (unchanged tree)
│   ├── excalidraw/...
│   └── dev-replays/...
├── src/
│   ├── index.ts                    // package exports
│   ├── cli.ts                      // bb-fixtures binary entry
│   ├── capture.ts                  // live-capture orchestrator (writes via @bb/replay-capture)
│   ├── load.ts                     // listFixtureBundles + read helpers
│   ├── replay.ts                   // replayFixtures engine (no audit summarizers)
│   ├── promote.ts                  // promoteCaptureToFixture helper
│   ├── corpus-schema.ts            // fixtureManifestSchema (extends replayCaptureManifestSchema)
│   └── types.ts                    // FixtureBundle, FixtureManifest, etc.
└── test/
    └── smoke.test.ts               // ~50 lines: corpus loads and replays without throwing
```

### What goes away

**Audit code:**

- `src/build-artifacts.ts` — entire file. Produces
  `replay-artifact.json` and the audit summary. Deleted.
- `src/visual-audit.ts` — entire file. Generates
  `.ladle/fixture-story-data.ts`. Deleted.
- From `src/replay.ts`: `summarizeFixtureCoverage`,
  `collectCoverageIssues`, `summarizeReplayResults`. The replay engine
  itself (`replayFixtures`, `listFixtureBundles`,
  `replayFixtureBundle`) stays.
- From `src/types.ts`: every `*Coverage*` type,
  `ProviderAuditUntranslatedRawEvent`, `ProviderAuditDebugRawEvent`,
  `ProviderAuditToolCallSummary`, `ProviderAuditRawEventKindSummary`,
  `ProviderAuditReport`, `ProviderAuditReplayBuild*` types, every Ladle
  type.

**Format-unification cleanup (done by the same stack or the format plan):**

- `src/json-file.ts` — entire file. The legacy schemas are gone.
- All `providerAudit*Schema` zod schemas.
- `ProviderAuditClientRequest` type and `buildProviderAuditClientRequestId`.

**Bridge code:**

- `src/fixtures.ts` shrinks dramatically. Today it owns
  `importFixtureCorpus`, `importDevReplayFixtures`,
  `listFixtureBundles`, `readFixtureBundle`, plus path-sanitization
  helpers used by the import flows. After this plan: only the read
  helpers and `listFixtureBundles` remain (moved into `load.ts`).
  `importFixtureCorpus` and `importDevReplayFixtures` are deleted.

**Ladle integration:**

- `.ladle/config.mjs`, `.ladle/components.tsx`, `.ladle/ladle.css`,
  `.ladle/fixture-story-data.ts` (generated) — deleted.
- `vite.config.ts` — deleted.
- Dependencies: `@bb/ui-core`, `@ladle/react`, `@tailwindcss/vite`,
  `tailwindcss`, `vite`, `react`, `react-dom`, `@types/react`,
  `@types/react-dom`.
- Scripts: `ladle`, `ladle:build`, `ladle:prepare`.

**Tests:**

- `test/replay-fixtures.test.ts` (full audit-flavored) → replaced with
  `test/smoke.test.ts` (~50 lines).
- `test/__snapshots__/replay-fixtures.test.ts.snap` (9332 lines) —
  deleted.
- `test/fixtures.test.ts` — deleted (only tests `importFixtureCorpus`,
  which is gone).

**CLI subcommands:**

- `build-replay-artifact` — deleted.
- `import-fixtures` — deleted.
- `import-dev-replays` — replaced by `promote`.
- `replay-fixtures` — replaced by `replay` (renamed; the engine
  survives, the CLI wrapper is simpler).
- `export-ladle-data` — deleted.

### What stays

- The corpus directory (`fixtures/excalidraw/...`,
  `fixtures/dev-replays/...`).
- `replayFixtures` and the replay-engine internals it depends on.
- `listFixtureBundles` and the fixture loader.
- `runFixtureCapture` (renamed from `runProviderAuditCapture`) — now
  writes through `@bb/replay-capture/writer` to canonical v3.
- `promoteCaptureToFixture` — reads `~/.bb-dev/replays/<captureId>/`,
  copies the events file verbatim, wraps the manifest with corpus
  metadata, writes to `fixtures/<corpusId>/<providerId>/<taskId>/`.
- `corpus-schema.ts` — owns `fixtureManifestSchema` (placement decision
  from the format-unification plan; corpus knowledge belongs here, not
  in `@bb/replay-capture`).

### CLI surface

```
bb-fixtures capture <args>          # live capture into fixtures/<corpus>/<provider>/<task>/
bb-fixtures replay <args>           # offline replay across the corpus (used by smoke test + timeline benchmark)
bb-fixtures promote <captureId>     # ~/.bb-dev/replays/<captureId> → fixtures/<corpus>/<provider>/<task>/
```

Three subcommands. Anything narrower than `capture/replay/promote`
shouldn't be a subcommand.

### Identifier rename map

`ProviderAudit*` blanket-renames to `Fixture*` for everything that
survives the audit cull. Exhaustive list of things that cross the
package boundary or appear in `apps/server`:

| Old                                 | New                    |
| ----------------------------------- | ---------------------- |
| `@bb/agent-provider-audit`          | `@bb/agent-fixtures`   |
| `bb-provider-audit` (binary)        | `bb-fixtures`          |
| `ProviderAuditBundle`               | `FixtureBundle`        |
| `ProviderAuditFixtureBundle`        | `FixtureCorpusEntry`   |
| `ProviderAuditManifest`             | `FixtureManifest`      |
| `ProviderAuditScenario`             | `FixtureScenario`      |
| `ProviderAuditReplayFixtureResult`  | `FixtureReplayResult`  |
| `ProviderAuditReplayFixturesArgs`   | `FixtureReplayArgs`    |
| `ProviderAuditReplayFixturesResult` | `FixtureReplayResults` |
| `ProviderAuditCliArgs`              | `FixtureCliArgs`       |
| `replayFixtures`                    | unchanged              |
| `listFixtureBundles`                | unchanged              |
| `runProviderAuditCapture`           | `runFixtureCapture`    |
| `parseCliArgs` (in `capture.ts`)    | unchanged              |

Internal helper names (private to a file) don't matter.

### Build script post-plan

```json
"scripts": {
  "build": "rimraf dist tsconfig.tsbuildinfo && tsc",
  "clean": "rimraf dist tsconfig.tsbuildinfo",
  "typecheck": "tsc -p tsconfig.typecheck.json",
  "test": "vitest run --config vitest.config.ts"
}
```

No `node ./dist/cli.js build-replay-artifact` step — the artifact is
deleted. No Ladle scripts.

## Steps

### Step 1 — Rename the package

1. `git mv packages/agent-provider-audit packages/agent-fixtures`.
2. Update `package.json`:
   - `name: "@bb/agent-fixtures"`
   - `bin: { "bb-fixtures": "./dist/cli.js" }`
   - Strip the React/Ladle dependency block (see "What goes away").
   - Replace the `build` script per "Build script post-plan".
3. Find-replace `@bb/agent-provider-audit` → `@bb/agent-fixtures`
   across:
   - `apps/server/package.json` and `apps/server/test/helpers/timeline-benchmark.ts`
   - `apps/app/package.json` (if it references — verify; today it doesn't)
   - any docs / README references
4. `pnpm install` to refresh the lockfile.

**Validation:**

- `git grep -n "agent-provider-audit"` returns only historical mentions
  in plan files.
- `pnpm exec turbo run typecheck --filter=@bb/agent-fixtures --filter=@bb/server`
  passes.

### Step 2 — Strip audit, Ladle, and import code

1. Delete files:
   - `src/build-artifacts.ts`
   - `src/visual-audit.ts`
   - `.ladle/` (whole directory)
   - `vite.config.ts`
   - `test/replay-fixtures.test.ts`
   - `test/__snapshots__/replay-fixtures.test.ts.snap`
   - `test/fixtures.test.ts`
2. Trim `src/replay.ts`:
   - Keep `replayFixtures`, `replayFixtureBundle` (private),
     `listFixtureBundles`, `parseReplayFixturesArgs` (renamed
     `parseFixtureReplayArgs`).
   - Delete `summarizeFixtureCoverage`, `collectCoverageIssues`,
     `summarizeReplayResults`, `gatherReplayBundleArtifacts`, and every
     coverage accumulator helper.
3. Split `src/fixtures.ts`:
   - Move `listFixtureBundles`, `readFixtureBundle`, and the path
     resolver helpers into a new `src/load.ts`.
   - Delete `importFixtureCorpus`, `importDevReplayFixtures`,
     `parseImportFixturesArgs`, `parseImportDevReplaysArgs`, and their
     supporting helpers (path sanitization, fixture-bundle copy logic).
   - Delete `src/fixtures.ts`.
4. Trim `src/types.ts` — remove every type listed under "What goes away".
5. Add `src/promote.ts` exporting `promoteCaptureToFixture()`. The
   signature: `(args: { captureId: string; replayRoot: string;
corpusContext: CorpusContext }) => Promise<{ destDir: string }>`.
   Reads the v3 capture from `<replayRoot>/<captureId>/`, copies the
   events NDJSON verbatim, builds the corpus extension manifest, writes
   to `fixtures/<corpusId>/<providerId>/<taskId>/`.
6. Add or move `fixtureManifestSchema` (per the format-unification plan) into
   `src/corpus-schema.ts`. Re-export through `index.ts`.
7. Add a browser-safe parser at `src/load-browser.ts`:
   ```ts
   export function parseFixtureBundleFromJson(args: {
     manifestJson: unknown;
     eventsNdjson: string;
   }): FixtureBundle;
   ```
   No `node:fs`, no `node:path`. Pure zod parse plus NDJSON line split.
   The Node loader in `load.ts` reads files with `fs` and then delegates
   to this helper to get one parsing path. Required by the UI plan's
   B7, which does Vite glob imports of the corpus and renders fixtures
   inside Ladle's browser bundle.
8. Rewrite `src/cli.ts` to expose only `capture`, `replay`, `promote`.
9. Rewrite `src/index.ts` to export only the post-cull surface:
   ```ts
   export { runFixtureCapture, parseCliArgs } from "./capture.js";
   export { listFixtureBundles, readFixtureBundle } from "./load.js";
   export { parseFixtureBundleFromJson } from "./load-browser.js";
   export { replayFixtures, parseFixtureReplayArgs } from "./replay.js";
   export { promoteCaptureToFixture } from "./promote.js";
   export {
     fixtureManifestSchema,
     type FixtureManifest,
   } from "./corpus-schema.js";
   export type {
     FixtureBundle,
     FixtureCorpusEntry,
     FixtureReplayResult,
     FixtureReplayResults,
     // ...
   } from "./types.js";
   ```

**Validation:**

- `git grep -n "ladle\|@bb/ui-core\|react" packages/agent-fixtures/src` returns nothing.
- `git grep -n "Coverage\|coverageSummary\|coverageIssue\|build-replay-artifact\|visual-audit\|fixture-story-data\|importFixture\|importDevReplay\|export-ladle-data" packages/agent-fixtures` returns nothing.
- `pnpm exec turbo run build --filter=@bb/agent-fixtures` passes.

### Step 3 — Write the smoke test

Replace the deleted `replay-fixtures.test.ts` with `test/smoke.test.ts`:

```ts
describe("@bb/agent-fixtures corpus smoke test", () => {
  it("loads every checked-in fixture without error", () => {
    const bundles = listFixtureBundles({ fixtureRoot: defaultFixtureRoot() });
    expect(bundles.length).toBeGreaterThan(0);
    for (const bundle of bundles) {
      expect(bundle.manifest.schemaVersion).toBe(3);
    }
  });

  it("replays a representative fixture without throwing", () => {
    const result = replayFixtures({
      fixtureRoot: defaultFixtureRoot(),
      corpusId: "excalidraw",
      providerId: "claude-code",
      taskId: "search-feature",
    });
    expect(result.fixtures).toHaveLength(1);
    expect(result.fixtures[0]?.bundle.timelineRows.length).toBeGreaterThan(0);
  });

  it("promotes a synthetic capture to a fixture", async () => {
    // Build a minimal v3 capture in tmp, promote it, assert the fixture
    // round-trips through readFixtureBundle.
  });
});
```

No snapshots. Smoke-test scope only — does the corpus load, does the
replay engine run, does promotion produce a valid fixture. Anything
deeper belongs in `@bb/thread-view` or `@bb/agent-runtime`.

**Validation:**

- `pnpm exec turbo run test --filter=@bb/agent-fixtures` passes.

### Step 4 — Rename identifiers across consumers

Apply the rename map. Two real consumers to update:

- `apps/server/test/helpers/timeline-benchmark.ts` — uses
  `replayFixtures` (no rename) and references `ProviderAuditBundle` →
  `FixtureBundle`. May reference other types; grep `ProviderAudit` in
  this file to enumerate.
- `packages/agent-fixtures/test/smoke.test.ts` (just written) — already
  uses post-rename names.

**Validation:**

- `git grep -n "ProviderAudit\\|providerAudit"` returns nothing outside
  plan files.
- `pnpm exec turbo run test --filter=@bb/agent-fixtures --filter=@bb/server`
  passes.

### Step 5 — Rewrite README

`packages/agent-fixtures/README.md` describes the new role:

- Corpus organization (`fixtures/<corpus>/<provider>/<task>/`).
- The canonical format (link to `@bb/replay-capture`'s docs and
  `corpus-schema.ts`).
- The three CLI subcommands and what each does.
- How to add a new fixture: typical flow is `bb-fixtures capture` for
  the live path, or `bb-fixtures promote` to graduate a `~/.bb-dev/`
  capture.
- A note that this package is data + replay primitives, not an audit
  harness — for translation regressions, look at `@bb/thread-view` and
  `@bb/agent-runtime`.

Drop `TODO.md`. Open items either move to plan files or get deleted.

**Validation:** README skim. A fresh-clone "where do I add a fixture?"
walkthrough.

## Exit Criteria

- [ ] `packages/agent-fixtures/` exists with the layout in "Final
      package shape". `packages/agent-provider-audit/` does not exist.
- [ ] No file under `packages/agent-fixtures/` imports React, Ladle,
      Vite, Tailwind, or `@bb/ui-core`.
- [ ] `bb-fixtures` CLI exposes exactly three subcommands: `capture`,
      `replay`, `promote`. No others.
- [ ] `parseFixtureBundleFromJson` is exported from
      `@bb/agent-fixtures/load-browser` and can be imported from a
      browser-target Vite build with no `node:fs` / `node:path`
      transitive dependencies.
- [ ] `git grep -n "@bb/agent-provider-audit\\|bb-provider-audit\\|ProviderAudit"`
      returns no matches outside plan files.
- [ ] `git grep -n "Coverage\\|coverageSummary\\|build-replay-artifact\\|visual-audit\\|fixture-story-data\\|importFixture\\|importDevReplay"`
      returns no matches in `packages/agent-fixtures` or any consumer.
- [ ] `apps/server/test/helpers/timeline-benchmark.ts` imports from
      `@bb/agent-fixtures` and tests pass.
- [ ] `pnpm exec turbo run build typecheck test --filter=@bb/agent-fixtures --filter=@bb/server`
      passes.
- [ ] `packages/agent-fixtures/README.md` describes the data-only role
      and the three CLI subcommands; contains no audit / Ladle / coverage
      references.
- [ ] `packages/agent-fixtures/test/` contains exactly `smoke.test.ts`
      and no snapshot directory.

## Risks / Decisions

**Audit is removed, not "deferred."** Anyone reading this plan in three
months should not interpret the cut as "we'll add audit back later."
Coverage analysis was useful when provider adapters were under churn;
they aren't now. If a future translation regression appears,
`@bb/thread-view` / `@bb/agent-runtime` get tests for the specific
regression. Audit-as-a-package is gone for good.

**Smoke test scope. The 9300-line snapshot file is deleted.** That
snapshot was the de-facto regression coverage for the timeline
translation pipeline. If we want that coverage, it belongs in
`@bb/thread-view`. This plan deliberately doesn't recreate it here — if
the deletion proves to have been load-bearing, the response is "add a
test in the right package," not "restore the audit harness."

**`promoteCaptureToFixture` corner cases.** A `~/.bb-dev/replays/`
capture is single-turn by design; promoting it produces a single-turn
fixture. Multi-turn fixtures still need a separate authoring path
(probably manual editing or a dedicated capture workflow). This isn't a
regression — today's `import-dev-replays` had the same limit.

**Build artifact path goes away.**
`packages/agent-provider-audit/build/replay-artifact.json` was gitignored
and rebuilt; nothing in `apps/server` reads it. After this plan, the
file and its directory don't exist. Anything pinned to that path in CI
or scripts needs to be removed — search before assuming nothing
depends on it.

**CLI binary rename is user-visible.** `bb-provider-audit` may be in
someone's shell history. No bin alias — let the old name break loudly
so people learn `bb-fixtures`.

**Snapshot tests in `apps/server`.** `timeline-benchmark.ts` may have
its own snapshots. Verify those don't reference `ProviderAudit*` types
in their string content; if they do, regenerate.

**Dev-replay corpus directory.** `fixtures/dev-replays/` is checked in
and contains personal captures. After format unification + this plan,
they load via the canonical reader. The `promote` subcommand can
populate this directory directly.

**Module split: `load.ts` vs former `fixtures.ts`.** The post-cut load
helpers are small (~150 lines). Consider whether they should fold into
`replay.ts` instead of getting their own file. Lean toward separate
file for clarity, but flag it for the reviewer.
