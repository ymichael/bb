# Replay / Fixture Format Unification

## Problem

We have two on-disk formats for "recorded provider runs" that are 80% the same
shape and 100% the same purpose:

- **`@bb/replay-capture`** writes live dev captures to
  `<data>/replays/<captureId>/` as a versioned `manifest.json` plus an NDJSON
  `raw-provider-events.ndjson` stream wrapped in `{ ordinal, relativeMs, entry }`
  records. This is the format the host daemon, server, and replay UI all speak.
- **`packages/agent-provider-audit/fixtures/`** (renamed to
  `packages/agent-fixtures/fixtures/` by the package split) stores corpus
  fixtures as an unversioned `manifest.json`, a sibling `client-requests.json`
  (the user-side prompts), and a JSON-array `raw-provider-events.json`. This is
  what today's audit/replay tests, timeline benchmark, and temporary Ladle
  visual harness consume.

The two formats already share an event payload — both carry
`{ kind: "raw-provider-event", captureId, capturedAt, providerId, rawLine, rawEvent, sourceThreadId? }`
— but the event-stream encoding, the manifest schema, and the user-input
representation diverge. Anyone touching either format has to keep two readers,
two writers, two zod schemas, and two mental models in sync. New requirements
(streaming reads, schema versioning, corpus fixtures derived from live
captures) get implemented twice or not at all.

The audit format also has a legacy "bridge envelope" tolerance in
`providerAuditRawEventSchema` that accepts events without `jsonrpc: "2.0"` and
silently rewrites them — a backwards-compat shim that needs to die before any
schema versioning is meaningful.

## Goal

1. One canonical on-disk format for any recorded provider run.
2. One library that owns its schemas, reader, writer, and playback engine.
3. Corpus fixtures and live captures share that format; corpus-only metadata
   (git state, scenario id, etc.) lives in an extension schema, not a parallel
   format.
4. Schema versioning extends to corpus fixtures so we can evolve safely.
5. Existing fixtures are migrated by a one-shot script; no permanent dual-read.

## Non-goals

- Re-recording fixtures from live providers. Migration is a pure
  transformation of existing files.
- Changing the event payload itself (`rawEvent`, `rawLine`, etc.).
- Touching apps/app's UI or Ladle stories. The old visual-audit harness is only
  a temporary current consumer if this plan is implemented before the package
  split/UI consolidation stack. The final `@bb/agent-fixtures` package is
  data-only; apps/app replay-fixture stories belong to
  `plans/ui-and-stories-consolidation.md`.

## Design

### Canonical format

`@bb/replay-capture` is canonical. Every recorded run lives in a directory:

```
<root>/<captureId>/
├── manifest.json                # versioned, zod-validated
└── raw-provider-events.ndjson   # NDJSON of { ordinal, relativeMs, entry }
```

`captureId` matches `cap_<base36 ts>_<8-char base36>` for live captures and
adopts the same shape for fixtures (we mint stable ids during migration so
fixture directories no longer rely on `<corpus>/<provider>/<task>/` for
identity — the path becomes pure organization, the id is in the manifest).

### Schema layering

The base manifest models user input as a `turns` array regardless of how
many turns the recording covers. Live captures always produce a one-turn
array (the dev capture feature is single-turn by design); fixtures replay
multi-turn scenarios with N entries. One shape, one reader, one writer.

```
@bb/replay-capture
  replayCaptureManifestSchema           // base — shared by live captures and fixtures
    schemaVersion: 3,                   // bumped from 2; v2 readers reject this manifest
    captureId, capturedAt, completedAt, source,
    providerId, projectId, environmentId, threadId, providerThreadId,
    title, kind: "thread-start" | "turn-start",
    turns: [{ turnId, userInput: PromptInput[], createdAt }],
    userInputPreview,                   // derived from turns[0].userInput
    execution, eventCounts, errorMessage

  replayRawProviderEventRecordSchema    // unchanged — { ordinal, relativeMs, entry }

  // base reader/writer/playback API works against any manifest that satisfies
  // the base schema, regardless of extensions.

@bb/agent-fixtures (the renamed audit package; this plan commits the corpus
extension schema here rather than leaving placement open)
  fixtureManifestSchema = replayCaptureManifestSchema.extend({
    source: z.literal("corpus-fixture"),     // narrows base 'source'
    corpusId: z.string(),
    scenarioId: z.string(),
    scenarioDescription: z.string(),
    model: z.string().nullable(),
    gitSha: z.string().nullable(),
    gitResetRef: z.string().nullable(),
    workspacePath: z.string(),
    runtimeWorkspacePath: z.string(),
    envWorkspacePath: z.string(),
    runtimeWorkspaceGitStart: gitSnapshotSchema.nullable(),
    runtimeWorkspaceGitEnd: gitSnapshotSchema.nullable(),
  })
```

Notes:

- **`turns` is in the base, not the extension.** The previous design had
  fixtures carrying a multi-turn `turns` array via the corpus extension and
  live captures carrying a single-turn `userInput: PromptInput[]` plus a
  parallel `turnIds: string[]`. Those are unified: every manifest has
  `turns`, with length 1 for live captures and length N for multi-turn
  fixtures. Removes the special case at every reader and writer.
- `turnId` lives inside each turn entry instead of as a parallel array.
  One source of truth per turn.
- `userInputPreview` is denormalized from `turns[0].userInput` (kept for
  the daemon list view, which doesn't want to walk into the array).
- A live capture is **promotable to a fixture verbatim**: the events file
  copies as-is, and the manifest gets the corpus extension fields appended
  (`source` flips to `"corpus-fixture"`, `corpusId`/`scenarioId`/git state
  added). No turn-shape transformation. A `promoteCaptureToFixture()`
  helper in `@bb/agent-fixtures` is the seam.
- `source` is a discriminated union — `"live-dev-capture" | "corpus-fixture"`
  (extendable). The corpus extension narrows `source`.
- `client-requests.json` goes away. The deletability spike traced every
  consumer: only `text` and `createdAt` per turn are real data; `id`,
  `requestId`, `type`, `target`, `requestMethod`, and `turnIndex` are all
  deterministic derivations from `(turnIndex, isFirstTurn)`. Those fields
  now live inside `turns[*]`; the only consumer
  (`buildClientRequestRows`) is rewritten to take this shape and recompute
  the derived fields inline.
- `manifest.turns: string[]` (legacy audit format) becomes
  `turns[*].userInput[*]` of type `PromptInput[]` — each old string
  becomes `[{ type: "text", text }]`. This widens the format from
  text-only to the full PromptInput union, so future fixtures can carry
  image/file inputs.
- `eventCounts.droppedRecords` is computed by the migration script
  (existing fixtures: 0 dropped). Live captures already track this.
- The bridge-envelope tolerance disappears. Migration normalizes every
  `rawEvent` to a strict JSON-RPC 2.0 envelope.

### Capture paths

Two writer paths exist today, both producing on-disk recordings. After
this plan, both write the canonical v3 format from the first byte:

| Path                  | Trigger                                                      | Destination                                                    | Pre-plan format     | Post-plan format           |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- | ------------------- | -------------------------- |
| Live dev capture      | host daemon during a real run                                | `~/.bb-dev/replays/<captureId>/`                               | v2 base             | v3 base                    |
| Audit fixture capture | package-owned fixture capture command/script after the split | `packages/agent-fixtures/fixtures/<corpus>/<provider>/<task>/` | legacy audit format | v3 base + corpus extension |

Both paths route through `@bb/replay-capture/writer`. The audit capture
path additionally validates against the corpus extension schema before
writing. There is no remaining writer that produces the legacy audit
format — anywhere we write, we write canonical.

### Reader / writer surface

`@bb/replay-capture` already exposes `reader`, `writer`, `playback` subpath
exports. After this plan:

- `reader` accepts a generic manifest schema parameter so corpus consumers
  can pass `fixtureManifestSchema` and get strongly typed corpus metadata
  back. Default remains `replayCaptureManifestSchema` for live-capture
  call sites. Reader is v3-only — v2 manifests are rejected with a clear
  error; there is no transparent transform.
- `writer` gets a `writeFixture()` helper alongside the existing
  `writeCapture()` so corpus producers don't reach into private
  internals.
- `playback` is unchanged — it operates on the event stream, which is
  now uniform.
- `packages/host-daemon-contract` currently consumes replay manifest/list
  schemas through durable `replay.capture_*` command result types. Step 2
  may update those references for the v3 shape, but it should not deepen
  that dependency: `plans/server-daemon-protocol-simplification.md`
  Phase 9 moves replay transport schemas out of the production command
  contract and into a dev-only RPC contract. This plan owns only the
  on-disk format and fixture schema.

### Backwards compatibility — none

The plan keeps zero legacy-format read compatibility. Everything below is
deleted from runtime surfaces, with no shims, no bridge release, no
transparent transforms, and no live-capture v2 migration path:

- Legacy audit `manifest.json` shape — gone. No reader in the repo can
  parse it.
- `raw-provider-events.json` (JSON-array event file) — gone.
- `client-requests.json` — gone.
- Bridge-envelope events (no `jsonrpc: "2.0"`) — rejected. The fixture
  migration script normalizes existing fixtures; the runtime schema is
  strict.
- v2 manifest reader — gone. v3 is the only readable shape.
- v2 manifest writer — gone. v3 is the only output shape.

Live captures already on user disks at `~/.bb-dev/replays/` (currently
v2) become unreadable. The reader's error message names the issue and
suggests `rm -rf ~/.bb-dev/replays/` or re-capturing. There is no
migration script, CLI, binary, subcommand, or reader transform for v2
live captures. Dev replays are short-lived debugging artifacts; this is
a tolerable one-time inconvenience.

This is safe to be ruthless about because the legacy audit format only
exists in fixtures we control inside this repo, and live captures are
ephemeral.

### Migration

A one-shot script in `@bb/agent-fixtures` reads every repo-controlled legacy
fixture directory, rewrites it in-place to the canonical shape, and deletes the
legacy files in the same commit. This is corpus-fixture migration only; it does
not process v2 live captures and does not create compatibility for them. No
fallback reader for the old format: post-migration, only the new format exists.

The script:

1. Reads `manifest.json` (legacy) + `client-requests.json` +
   `raw-provider-events.json`.
2. Mints a deterministic `captureId` from `(scenarioId, providerId, capturedAt)`
   so re-running migration is idempotent.
3. Builds the unified `turns` array by zipping legacy
   `manifest.turns: string[]` with `client-requests.json[*].createdAt` and
   synthesizing one `turnId` per turn:
   ```
   turns = manifest.turns.map((text, i) => ({
     turnId: `turn_${i}_${captureId}`,
     userInput: [{ type: "text", text }],
     createdAt: clientRequests[i].createdAt,
   }))
   ```
4. Synthesizes the rest of the base manifest:
   `schemaVersion: 3`, `userInputPreview` (from `turns[0].userInput`),
   `eventCounts`, `execution` (defaults if absent),
   `kind: "thread-start"`, `source: "corpus-fixture"`.
5. Synthesizes the corpus extension fields:
   `corpusId`, `scenarioId`, `scenarioDescription`, `model`, `gitSha`,
   `gitResetRef`, `workspacePath`, `runtimeWorkspacePath`,
   `envWorkspacePath`, `runtimeWorkspaceGitStart`, `runtimeWorkspaceGitEnd`.
6. For each entry in the legacy JSON-array event file: assign `ordinal`
   (1-based), compute `relativeMs` from `capturedAt - manifest.capturedAt`,
   normalize `rawEvent` to strict JSON-RPC 2.0, write one NDJSON line.
7. Writes `manifest.json` (new) and `raw-provider-events.ndjson`.
8. Removes `client-requests.json` and the legacy `raw-provider-events.json`.

The companion code change (separate commit, lands with Step 5):
`buildClientRequestRows` in `capture.ts` is rewritten to take
`manifest.turns: [{ turnId, userInput, createdAt }]` directly and
recompute `id`, `requestId`, `type`, `target`, `requestMethod` inline from
`(turnIndex, isFirstTurn)`. The legacy `ProviderAuditClientRequest` type
and its file schema are deleted.

The script lives temporarily in the source tree so the corpus migration is
reviewable and repeatable during the migration commit. Delete it after the
migration commit lands and the next release ships.

## Sequencing

This plan assumes the package split/rename is part of the same implementation
stack, or has already landed, so `fixtureManifestSchema` lives in
`@bb/agent-fixtures` from the first format implementation commit. Do not place
it temporarily in `@bb/replay-capture`, and do not keep React/Ladle surfaces in
the final `@bb/agent-fixtures` package.

The UI consolidation plan can land later. If someone intentionally implements
format unification before the split/UI stack, update the current legacy
`packages/agent-provider-audit/src/visual-audit.ts` consumer only as temporary
compatibility work in that old package. Do not port `visual-audit.ts`,
`.ladle/`, or `ladle:*` scripts into `@bb/agent-fixtures`.

Once this plan lands:

- `@bb/replay-capture` exposes a generic reader API.
- `@bb/agent-fixtures` owns `fixtureManifestSchema` and fixture-specific helpers.
- Current durable replay command result schemas in `host-daemon-contract` are
  updated only as needed for the v3 shape, then moved to dev-only RPC by
  `plans/server-daemon-protocol-simplification.md` Phase 9.
- `@bb/agent-fixtures` fixture loader reads via the canonical reader.
- All existing fixtures on disk are in the new format.

## Steps

### Step 1 — `client-requests.json` deletability (resolved)

Spike already complete. Result: deletable; the data folds into the
unified `turns` array on the base manifest.

Findings:

- The only consumer of `client-requests.json` is
  `buildClientRequestRows` in `agent-fixtures/src/capture.ts:573`.
- Of the eight per-turn fields, only `text` and `createdAt` are real data. The
  other six (`id`, `requestId`, `turnIndex`, `type`, `target`, `requestMethod`)
  are deterministic derivations from `turnIndex` and `isFirstTurn`.
- Test references to `clientRequests` in
  `apps/server/test/scheduling/nudge-sweep.test.ts` are unrelated — they read a
  database column of the same name, not the fixture file.

Action: the base manifest carries `turns: [{ turnId, userInput, createdAt }]`
(defined in "Schema layering"). `buildClientRequestRows` is rewritten to
take this shape and recompute the derived fields inline; the migration
script folds legacy `manifest.turns: string[]` plus
`client-requests.json[*].createdAt` into the new array.

No further investigation needed. Proceed to Step 2.

### Step 2 — Bump base schema to v3 and land the unified shape

1. Bump `replayCaptureManifestSchema` to `schemaVersion: 3`. Replace
   `userInput: PromptInput[]` and `turnIds: string[]` with the unified
   `turns: [{ turnId, userInput, createdAt }]` field.
2. Update the live-capture writer (`@bb/replay-capture/writer`) to emit a
   one-element `turns` array. The dev capture feature stays single-turn;
   the array length is always 1 for live captures.
3. Make the reader v3-only. A `schemaVersion: 2` manifest fails parsing
   with a clear error message that names the issue and suggests
   `rm -rf ~/.bb-dev/replays/` or re-capturing. No transparent transform,
   no migration tool.
4. Update live-capture and replay transport call sites for the new field
   shape, explicitly including
   `apps/server/src/routes/internal-replay.ts`,
   `apps/server/src/internal/command-result-owners.ts`, and
   `apps/host-daemon/src/command-handlers/replay.ts`. Anywhere that read
   `manifest.userInput` or `manifest.turnIds` reads through
   `manifest.turns[*]` instead.
5. Add `gitSnapshotSchema` to `@bb/replay-capture` (it's a generic shape;
   the corpus extension schema needs it).
6. Export `fixtureManifestSchema` from `@bb/agent-fixtures`.
   `@bb/replay-capture` should not know about corpus organization; it
   owns only the base manifest schema and generic reader/writer APIs.
7. Add a generic `readManifest<TSchema>()` to `@bb/replay-capture/reader`
   so corpus consumers can pass their own narrowed schema.
8. Add `writeFixture()` to `@bb/replay-capture/writer` mirroring the
   capture writer, taking a manifest that the caller has already validated.
9. Add a `promoteCaptureToFixture(capture, corpusContext)` helper in
   `@bb/agent-fixtures`. It copies the events file verbatim and wraps the
   manifest with corpus fields.

**Validation:**

- `pnpm exec turbo run typecheck --filter=@bb/replay-capture` passes.
- Live-capture call sites (`apps/host-daemon`, `apps/server`) typecheck
  and tests pass against the new field shape.
- New tests cover:
  - v3 manifest round-trip (write → read).
  - v2 manifest read produces a clear, specific error (not a generic zod
    parse failure).
  - Writing a v2-shaped manifest is rejected (writer is v3-only).
  - Strict `rawEvent` schema rejects bridge-envelope events.
  - NDJSON record ordinals are 1-based and contiguous.
  - `promoteCaptureToFixture` produces a fixture that round-trips through
    the corpus reader.

### Step 3 — Define the corpus extension schema

In `@bb/agent-fixtures`, define `fixtureManifestSchema` as the documented
`replayCaptureManifestSchema.extend({ ... corpus fields ... })`. Export it
alongside a typed `readFixtureManifest()` and `readFixtureBundle()` (manifest +
events).

**Validation:**

- Synthetic round-trip test: build a fake fixture in a tmp dir, read it back
  via the new reader, assert structural equality.

### Step 4 — Write the migration script

Live in `packages/agent-fixtures/scripts/migrate-fixtures.ts`. The script
implements the algorithm under "Migration" above for repo-controlled legacy
corpus fixtures only. Make it idempotent: detect already-migrated directories
(presence of `raw-provider-events.ndjson` and a `schemaVersion` field) and skip
them.

Write a unit test that fixes one small fixture in a tmp dir and migrates it,
asserting:

- the new manifest validates against `fixtureManifestSchema`
- the NDJSON has one record per legacy event with monotonically increasing
  ordinals
- legacy files are removed
- second run is a no-op

**Validation:**

- `pnpm exec turbo run test --filter=@bb/agent-fixtures` passes the migration
  tests.
- Manual dry-run on one real fixture (script has a `--dry-run` flag that
  prints diffs without writing).

### Step 5 — Migrate every fixture

1. Run the script over `packages/agent-fixtures/fixtures/`. Commit the diff in
   one commit, separate from the script-and-schema commits, so the data
   migration is reviewable on its own.
2. Update consumers that read fixtures to use the new reader:
   - `packages/agent-fixtures/src/fixtures.ts`
   - `packages/agent-fixtures/src/replay.ts`
   - `apps/server/test/helpers/timeline-benchmark.ts`

   Temporary sequencing exception: if the preferred package split/UI
   sequencing is not followed, also update the current legacy
   `packages/agent-provider-audit/src/visual-audit.ts` consumer in the old
   package. Do not port that file to `@bb/agent-fixtures`.

3. Delete every legacy schema, helper, and file. The full list — anyone
   reviewing this commit can verify each is gone:
   - **Schemas in `agent-fixtures/src/json-file.ts`:**
     - `providerAuditJsonRpcEnvelopeSchema`
     - `providerAuditBridgeEnvelopeSchema`
     - `providerAuditRawEventSchema`
     - `providerAuditManifestSchema`
     - `providerAuditGitSnapshotSchema`
     - `providerAuditClientRequestFileSchema`
     - `providerAuditClientRequestSchema` (and its
       `normalizeProviderAuditClientRequest` transform)
     - `providerAuditRawProviderEventCaptureEntrySchema`
   - **The `agent-fixtures/src/json-file.ts` file itself** (its only purpose
     was hosting the legacy schemas).
   - **Types in `agent-fixtures/src/types.ts`:**
     - `ProviderAuditClientRequest`
   - **Helpers:**
     - `buildProviderAuditClientRequestId` (the derived ids move inline
       into `buildClientRequestRows`).
   - **On-disk file format:** every `client-requests.json` and every
     legacy `raw-provider-events.json` (JSON-array shape).
   - **Capture path code:** any branches in
     `agent-fixtures/src/capture.ts` that wrote `client-requests.json` or built
     `ProviderAuditClientRequest` entries; the capture path now writes through
     `@bb/replay-capture/writer` (canonical NDJSON + v3 manifest + corpus
     extension).
4. Update the data-package fixture tests to the package split's smoke-test shape
   (`packages/agent-fixtures/test/smoke.test.ts`). Do not revive the deleted
   audit snapshot test as a final `@bb/agent-fixtures` surface.

**Validation:**

- `pnpm exec turbo run test --filter=@bb/agent-fixtures --filter=@bb/server`
  passes.
- `pnpm exec turbo run typecheck` passes for the whole repo.
- `git grep -n providerAuditManifestSchema\\|providerAuditClientRequestSchema\\|providerAuditRawEventSchema`
  returns no matches.
- No Ladle validation belongs to `@bb/agent-fixtures`; the package is data-only
  after the split. Replay-fixture story validation is owned by
  `plans/ui-and-stories-consolidation.md` and uses
  `pnpm --filter @bb/app ladle:build` after apps/app's replay-fixture stories
  exist.
- Spot-check: pick three migrated fixtures, run them through `replayFixtures`,
  and compare the resulting timeline rows with pre-migration replay output
  captured before conversion. They should be identical (the format change should
  be data-preserving).

### Step 6 — Remove the migration script

Once Step 5 has shipped and at least one release has gone out, delete:

- `migrate-fixtures.ts`
- any package-script entry used only to invoke it
- any tmp scaffolding

The script's job is done; it should not become permanent surface.

## Exit Criteria

- [ ] `replayCaptureManifestSchema` is at `schemaVersion: 3`. The base
      manifest carries `turns: [{ turnId, userInput, createdAt }]`; the
      separate `userInput` and `turnIds` fields no longer exist.
- [ ] Live captures and fixtures share the base schema. A live capture
      writes a one-element `turns` array; a multi-turn fixture writes N.
- [ ] Every fixture under `packages/agent-fixtures/fixtures/` has
      the shape `{manifest.json, raw-provider-events.ndjson}` and no
      other files. `manifest.schemaVersion === 3`.
- [ ] `@bb/replay-capture/reader` accepts only v3 manifests. v2
      manifests fail with a clear, specific error.
- [ ] `@bb/replay-capture/writer` only emits v3.
- [ ] `@bb/replay-capture` exposes a generic `readManifest<TSchema>()`
      reader and a `writeFixture()` writer.
- [ ] `@bb/agent-fixtures` exports `fixtureManifestSchema` and fixture-specific
      read/promote helpers.
- [ ] No v2 live-capture migration script, CLI, binary, subcommand, or reader
      transform exists.
- [ ] `promoteCaptureToFixture()` exists and produces a fixture that
      round-trips through the corpus reader.
- [ ] No code in the repo references `providerAuditManifestSchema`,
      `providerAuditClientRequestSchema`,
      `providerAuditClientRequestFileSchema`,
      `providerAuditBridgeEnvelopeSchema`,
      `providerAuditRawEventSchema`,
      `providerAuditRawProviderEventCaptureEntrySchema`,
      `normalizeProviderAuditClientRequest`,
      `ProviderAuditClientRequest`, or `buildProviderAuditClientRequestId`.
- [ ] `agent-fixtures/src/json-file.ts` is deleted (it only existed
      to host the legacy schemas).
- [ ] `client-requests.json` does not exist anywhere in the repo.
- [ ] The strict `replayRawProviderCaptureEntrySchema` is the only event
      schema; bridge-envelope tolerance is gone.
- [ ] The `@bb/agent-fixtures` smoke test passes with the migrated fixtures.
- [ ] `apps/server/test/helpers/timeline-benchmark.ts` reads fixtures via
      the canonical reader.
- [ ] Live capture flows (`apps/host-daemon` writer, `apps/server` replay
      route) write v3 and round-trip cleanly.

## Risks / Decisions

**Bridge-envelope events in old fixtures.** Some fixtures may contain events
that today only validate via the permissive `providerAuditBridgeEnvelopeSchema`
(no `jsonrpc: "2.0"`). The migration script must normalize those to strict
JSON-RPC during conversion. If a fixture has an event that _can't_ be
normalized (no `method` field, malformed params), fail loudly during
migration; do not silently drop. We'd rather re-record one fixture than ship
permissive parsing forever.

**Captured `~/.bb-dev/replays/` data on user disks.** This plan bumps the base
manifest from v2 to v3 with no compatibility shim and no live-capture migration
tooling. Existing user captures (v2) stop loading after upgrade; the reader's
error message tells users to delete `~/.bb-dev/replays/` or re-capture. Dev
replays are ephemeral, so this is acceptable.

**`captureId` in fixtures.** Fixtures historically didn't have one — identity
came from the directory path. Adding a stable `captureId` opens the door to
later moving fixtures into a flat `fixtures/<captureId>/` layout, but that's
a follow-up. For now the directory tree stays
`<corpus>/<provider>/<task>/`; the manifest just gains an id.

**Migration script lifespan.** Migration scripts that linger become load-
bearing. Step 6 explicitly schedules its deletion. If we forget, the next
person reading the package will read it as a permanent feature and reason
about corpus fixtures as still supporting the legacy format.

**Schema-extension placement.** `fixtureManifestSchema` lives in
`@bb/agent-fixtures`. `@bb/replay-capture` owns only the base recorded-run
schema and generic reader/writer APIs; it must not know about corpus
organization (`corpusId`, git snapshots, scenario metadata).

**`client-requests.json` is deleted, not preserved.** The spike confirmed
its data is reducible to `{ userInput, createdAt }` per turn. The only
consumer (`buildClientRequestRows`) gets refactored to take the new
`corpus.turns[*]` shape and recompute the derived fields inline. If any
new consumer surfaces during migration that needs the old shape, fix the
consumer rather than re-adding the file — there's no information loss in
the new representation, only a derivation move.
