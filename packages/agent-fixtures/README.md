# @bb/agent-fixtures

`@bb/agent-fixtures` owns the checked-in corpus of recorded provider runs and
the small set of tools needed to load, replay, capture, and promote those
fixtures.

## Corpus Layout

Fixtures live under:

```text
fixtures/<corpus>/<provider>/<task>/
├── manifest.json
└── raw-provider-events.ndjson
```

`manifest.json` uses the v3 replay-capture manifest from
`@bb/replay-capture/schema`, extended by `src/corpus-schema.ts` with corpus
metadata such as `corpusId`, `scenarioId`, workspace paths, model, and git
snapshots. `raw-provider-events.ndjson` is the canonical v3 raw provider event
stream and is copied verbatim when promoting a live capture.

## Package API

- `listFixtureBundles()` and `readFixtureBundle()` load checked-in fixtures.
- `parseFixtureBundleFromJson()` is browser-safe and parses Vite-globbed
  `manifest.json` plus raw NDJSON without `node:fs` or `node:path`.
- `replayFixtures()` translates raw provider events through
  `@bb/agent-runtime` and builds timeline rows with `@bb/thread-view`.
- `runFixtureCapture()` records a built-in scenario.
- `promoteCaptureToFixture()` moves a live replay capture into the corpus.

## CLI

Build first:

```sh
pnpm exec turbo run build --filter=@bb/agent-fixtures
```

Capture a built-in scenario:

```sh
node ./packages/agent-fixtures/dist/cli.js capture \
  --provider codex \
  --scenario excalidraw-search-feature \
  --workspace /path/to/excalidraw
```

Replay fixtures:

```sh
node ./packages/agent-fixtures/dist/cli.js replay
node ./packages/agent-fixtures/dist/cli.js replay \
  --corpus-id excalidraw \
  --provider claude-code \
  --task search-feature
```

Promote a live capture from `~/.bb-dev/replays/<captureId>/`:

```sh
node ./packages/agent-fixtures/dist/cli.js promote cap_abc12345_deadbeef \
  --corpus-id dev-replays
```

## Adding Fixtures

The usual path is to record a live replay capture in the dev app, then promote
it:

```sh
node ./packages/agent-fixtures/dist/cli.js promote <captureId> \
  --corpus-id dev-replays
```

For repeatable built-in scenarios, use `capture` with an explicit `--output`
directory, inspect the generated files, and copy or promote the final v3
manifest plus NDJSON into `fixtures/<corpus>/<provider>/<task>/`.

This package is only the corpus and replay primitive boundary. Behavioral
regressions in event translation or timeline projection should be covered in
the owning packages, primarily `@bb/agent-runtime` and `@bb/thread-view`.
