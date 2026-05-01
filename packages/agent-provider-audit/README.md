# Provider Audit

`@bb/agent-provider-audit` is the offline fidelity harness for provider
timeline work.

It exists to answer a narrow question: given real provider traces, what do we
store, what semantic timeline rows do we project, and what text would a user see
in the CLI-style timeline?

## What Is Tracked

The repo only tracks the irreducible fixture inputs:

- `fixtures/<corpus>/<provider>/<task>/manifest.json`
- `fixtures/<corpus>/<provider>/<task>/client-requests.json`
- `fixtures/<corpus>/<provider>/<task>/raw-provider-events.json`

Everything else is generated from those files.

`raw-provider-events.json` is the provider-side event stream captured at the
`agent-runtime` boundary. Together with `client-requests.json`, it is enough for
the package to replay the run into provider-agnostic rows and rendered output.

That gives us enough data to regenerate:

- `ThreadEvent[]`
- `ThreadEventRow[]`
- semantic timeline rows
- CLI-friendly text via `formatTimelineAsText()`
- generated fixture data for future visual review
- audit summaries

The package build materializes the expensive replay-derived data once:

- `build/replay-artifact.json`
- `.ladle/fixture-story-data.ts`

Both files are generated and ignored by git.

## Why This Package Exists

The rendering stack has a few boundaries:

1. `@bb/agent-runtime` captures provider-specific events and translates some of them into provider-agnostic `ThreadEvent`s.
2. Events are stored and later decoded into `ThreadEventRow`s.
3. `@bb/thread-view` projects those rows into semantic timeline rows.
4. `@bb/thread-view` builds shared grouping summaries and CLI text from those
   rows.

This package gives us a stable offline corpus so we can improve that pipeline without repeatedly spending live provider turns.

The replay output currently feeds the CLI/audit review loop via
`formatTimelineAsText()`. React visual review is intentionally deferred until
the `ui-core` design-system work gives that renderer a stable foundation.

## Corpora

The current checked-in corpora are:

- `fixtures/excalidraw`
  - 21 fixture bundles against the Excalidraw repo
  - six shared tasks across all three providers:
    - the original TTD/search trio
    - collaboration-startup
    - eyedropper-preview
    - Magic Frame
  - three provider-targeted tasks:
    - Claude Code: eyedropper browser compatibility
    - Pi: command palette mapping with helper-tool coverage
    - Codex: share dialog compatibility/discoverability with dynamic helper-tool coverage

The Excalidraw corpus is the north-star baseline and the only checked-in corpus.

## Current Learnings

The current fixture-backed findings are:

- obvious shell exploration is common across providers, especially Codex
  - `rg`, `grep`, `find`, `ls`, `sed -n`, `cat`, and similar commands often carry the real exploration story
  - treating those as generic `exec_command` rows makes Codex and Pi feel much noisier than they should
- Pi has a real built-in-tool split that is easy to misread
  - Pi CLI and Pi SDK default to the four-tool coding set: `read`, `bash`, `edit`, `write`
  - `grep`, `find`, and `ls` are real first-class Pi tools, but they are opt-in rather than part of the default coding set
  - if they are not explicitly enabled, the model will usually treat them as shell commands routed through `bash`
- targeted provider-shaped fixtures are valuable when breadth matters
  - Claude's targeted fixture reliably surfaces `TodoWrite`, `ToolSearch`, `WebSearch`, and `WebFetch`
  - Codex's targeted fixture reliably surfaces a `dynamicToolCall` via the helper-tool path
  - Pi now covers a custom helper tool, but still strongly prefers `bash` over raw `ls` / `find` / `grep` even when prompted directly
- Pi bridge parity needs to be watched explicitly
  - bb currently always starts Pi with base instructions, which means the bridge takes a custom `DefaultResourceLoader` path instead of Pi's plain default-loader path
  - that path is closer to `pi --system-prompt ... --no-extensions --no-skills --no-prompt-templates --no-themes` than to an untouched interactive Pi session
  - when Pi behavior looks surprising, compare the bridge behavior against a direct `pi --mode json` run before changing rendering code
- Claude subagent work benefits from compaction even before we model nesting
  - showing the full `Agent` report inline in the main timeline duplicates later assistant output and overwhelms the useful steps
- the final rendered timeline matters more than streaming polish
  - once the final projection is readable, the remaining streaming gaps are smaller and easier to reason about

The current rendering pass on top of this corpus now does two things:

- shell-style repo exploration keeps command/tool identity and carries parsed activity intents, so shared view formatting can summarize exploration without hiding the underlying shell command
- Claude `Agent` outputs are summarized as compact subagent reports instead of dumping the full report body

The current semantic timeline keeps tasks/todos/plans out of the timeline. They
will move to a separate surface later.

Delegation is a first-class work row: subagent invocations render as parent rows
with child timeline progress, rather than looking like generic tool calls.

When parent-child linkage is present, delegated child activity can now nest
under that parent row recursively. The checked-in Excalidraw Claude corpus does
carry non-null `parent_tool_use_id`, and the replay path now preserves that
linkage so realistic delegated child activity nests under the parent `Agent`
row in the CLI text output. Codex protocol support for child collaboration
threads is also understood, but the current Excalidraw Codex fixtures do not yet
exercise `collabAgentToolCall`.

## Cross-Package Data Flows

Some user-facing timeline concepts intentionally span multiple packages:

- delegation
  - adapters preserve parent tool-call linkage and structured subagent metadata
  - `@bb/thread-view` projects parent rows plus nested child activity
  - CLI/audit text renders the same nested semantic tree
- tool progress
  - providers emit command output deltas, shared `item/toolCall/progress`, or
    provider-specific progress signals
  - `@bb/thread-view` merges those partial updates into coherent command/tool
    rows with lifecycle state and duration

When any of these flows change, validation has to cover adapter translation,
semantic timeline projection, and final CLI/audit text.

## Shell Parsing Rationale

The codebase still parses some shell commands on purpose.

That is not accidental parser creep: the checked-in provider corpus shows that
Codex and Pi frequently express repo exploration through shell commands even
when a more semantic tool exists. Without those heuristics, the timeline loses
most of the real exploration story and collapses back into generic command
noise.

The current rule is:

- keep only the small shell heuristics that materially improve the user-facing
  exploration summary
- prefer structured tool arguments over shell parsing whenever the provider
  gives them to us
- use provider-audit fixtures to justify new shell parsing before adding it

## Reference Research

Two external repos were especially useful in shaping the work:

- `terragon-labs/terragon-oss`
  - preserves nested tool structure using `parent_tool_use_id`
  - replaces repeated `TodoWrite` parts instead of appending every update
  - suppresses low-value todo reads in the rendered surface
- `pingdotgg/t3code`
  - keeps a clearer separation between raw provider/runtime events and a more semantic projected event layer
  - includes explicit concepts like plan updates, task progress, and tool progress/summaries

Those references reinforce the same direction for `bb`:

- rendering can improve a lot before the domain model expands
- real subagent boundaries and todo/plan parity probably require first-class concepts, not just better formatting

## Capture Hygiene

When capturing new fixtures:

- use a fresh thread/provider-thread pair for every provider + prompt capture
- reset the target repo to a known ref before and after each run
- keep the prompt repo-aware but under-specified enough that the provider still has to explore
- when provider behavior is surprising, reproduce the task directly in the native provider CLI first
  - for Pi, `pi --mode json` is especially useful because it shows the exact tool calls the model made
  - ask the provider what tools it believes it has before assuming a missing tool is a rendering bug
- treat capture prompts as disposable instrumentation
  - iterate on them until the target surface actually shows up
  - then check in only the final successful bundle

## Generate New Fixtures

1. Capture live runs to a temp output root:

```bash
pnpm exec turbo run build --filter=@bb/agent-provider-audit
node ./packages/agent-provider-audit/dist/cli.js \
  --provider codex \
  --scenario excalidraw-ttd-explanation \
  --workspace /tmp/agent-provider-audit-repos/excalidraw \
  --git-reset-ref "$BASE_SHA" \
  --output /tmp/bb-provider-audit-excalidraw
```

2. Import only the raw fixture inputs into the checked-in corpus:

```bash
pnpm exec turbo run build --filter=@bb/agent-provider-audit
node ./packages/agent-provider-audit/dist/cli.js import-fixtures \
  --source-root /tmp/bb-provider-audit-excalidraw \
  --corpus-id excalidraw
```

That import sanitizes local paths into placeholders like `$EXCALIDRAW_REPO`, `$CAPTURE_OUTPUT`, and `$HOME`.
It replaces the target corpus, so when appending new bundles you should stage the existing fixture directories and the new capture directories together under the same `--source-root`.

## Replay Fixtures

Replay every tracked fixture and print a compact summary:

```bash
pnpm exec turbo run build --filter=@bb/agent-provider-audit
node ./packages/agent-provider-audit/dist/cli.js replay-fixtures
```

Write derived outputs for inspection without committing them:

```bash
pnpm exec turbo run build --filter=@bb/agent-provider-audit
node ./packages/agent-provider-audit/dist/cli.js replay-fixtures \
  --corpus-id excalidraw \
  --provider claude-code \
  --task search-feature \
  --output-root /tmp/agent-provider-audit-replay
```

That output root will contain generated files like:

- `thread-events.json`
- `thread-event-rows.json`
- `timeline-rows.json`
- `timeline.txt`
- `timeline.verbose.txt`
- `audit-report.json`

`timeline.txt` is the CLI-aligned minimal text view. `timeline.verbose.txt` keeps
the full expanded text for deeper debugging.

## Generated Fixture Data

Build the package to generate replayed fixture data for the checked-in fixtures:

```bash
pnpm exec turbo run build --filter=@bb/agent-provider-audit
```

That writes the replay artifact and a generated fixture-data module under
`packages/agent-provider-audit/.ladle/fixture-story-data.ts`. The generated
module is retained for the future React visual audit, but there is no current
React renderer review loop in this package.

## Testing

`pnpm exec turbo run test --filter=@bb/agent-provider-audit`

The package test suite does three things:

- validates the build-generated replay artifact and snapshots a compact summary
- verifies replay output can be written on demand for inspection
- verifies generated fixture data exists for future visual review

The snapshot is intentionally compact. We do not commit full generated outputs back into the corpus.

Automated replay is the baseline, not the whole review:

- replay tests should pass
- coverage issues should be zero for the checked-in corpus
- CLI verbose timeline snapshots should be spot-checked for new or changed fixtures
- package build should regenerate fixture data cleanly for the full corpus
- when the React renderer work resumes, add a real browser pass on top of these
  fixtures rather than relying only on generated data

The practical split is:

- automated validation catches classification regressions and snapshot drift
- manual CLI review catches weak wording and noisy rows
- future manual React review catches layout and visual hierarchy problems after
  the `ui-core` design-system work lands

## Current Direction

The point of this package is not only coverage of missing event translations.

The larger goals are:

- users should feel at home on every provider
- provider-specific behavior should not disappear silently
- where we do not support something yet, the limitation should be explicit

The biggest remaining product/modeling gaps should be tracked in a branch-local TODO or plan while active work is in progress.
