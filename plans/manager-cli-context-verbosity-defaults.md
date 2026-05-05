# Manager CLI Context Verbosity Defaults

## Objective

Reduce low-signal manager provider context from common BB CLI inspection and
delegation commands while keeping full detail explicitly available.

This proposal targets three recurring sources of context growth:

- `bb thread output <id>` returning an entire final answer.
- `bb thread show <id> --git-diff` returning a large patch body.
- `bb thread tell` and `bb thread spawn --prompt` invocations whose literal
  shell command contains a long inline prompt or heredoc.

The desired product shape is:

- Human defaults are high-signal previews.
- Full output is available through explicit flags or explicit files.
- Provider history is capped even when an immediate command result used a
  full-detail opt-in.
- Raw durable events stay available for debugging unless a separate retention
  policy changes that contract.

## Current Behavior And Evidence

The DB duplication issue from
`bb/audit-manager-cli-context-verbosity-thr_twn9inm73q` addressed one source of
stored context growth by pruning resolved item deltas. This plan depends on that
fix being present. The remaining problem is product-level verbosity: even with
duplicate deltas removed, managers can still put large command output and long
command text into provider context.

Current code paths:

- `apps/cli/src/commands/thread/show.ts`
  - `bb thread output <id>` calls `GET /threads/:id/output` and prints
    `result.output` with no CLI cap.
  - `bb thread output <id> --json` prints the raw `{ output }` payload.
  - `bb thread show <id> --git-diff` calls `GET /environments/:id/diff` and
    prints files, shortstat, and the returned `gitDiff.diff` body.
  - `bb thread show <id> --git-diff --json` includes the returned `gitDiff`
    object directly in JSON.
- `apps/server/src/routes/environments.ts`
  - The public diff endpoint already caps host diff data at
    `WORKSPACE_DIFF_MAX_DIFF_BYTES = 2 * 1024 * 1024` and
    `WORKSPACE_DIFF_MAX_FILE_LIST_BYTES = 256 * 1024`.
  - Those caps protect the host/server boundary, but 2 MiB is still far too
    large for a manager's normal provider turn.
- `apps/server/src/routes/threads/data.ts` and
  `apps/server/src/services/threads/thread-data.ts`
  - `GET /threads/:id/output` returns the latest visible manager message or
    assistant output with no response cap.
- `apps/cli/src/commands/thread/actions.ts`
  - `bb thread tell <id> <message>` accepts the message as a positional
    argument and sends it as one text input item.
- `apps/cli/src/commands/thread/spawn.ts`
  - `bb thread spawn --prompt <prompt>` requires the prompt as an option value
    and sends it as one text input item.

Existing reports and audit notes point at the same product pressure:

- `plans/provider-turn-watchdog.md` records a May 3, 2026 manager incident where
  the stalled provider turn had issued `bb thread output thr_jb5xwguekp` and
  `bb thread show thr_jb5xwguekp --json`. That plan remains about stalled
  provider execution and is out of scope here, but it shows these inspection
  commands are in the manager's hot path.
- `qa/manual-pass-log.md` notes that manager completion handling moved away from
  polling loops, but live logs still showed occasional `bb thread show --json`
  inspections while reviewing completed child results.
- `qa/manual-manager-runbook.md` explicitly validates that managers do not poll
  repeatedly, then instructs reviewers to inspect `bb thread log ... --json`
  and search for `bb thread show`, `bb thread list`, and `bb thread log`.
- `packages/agent-provider-audit/README.md` documents the same readability
  principle for provider timelines: full nested agent reports and command noise
  can overwhelm the useful steps, so compact rendered output is valuable even
  when raw data remains available.

## Scope Decisions

In scope:

- `bb thread output` text output.
- `bb thread output --json`, with staged migration described below.
- `bb thread show --git-diff` text output.
- `bb thread show --git-diff --json`, with staged migration described below.
- New `tell` and `spawn` file/stdin input modes.
- Provider-context redaction of long manager command text and command output.
- Server preview query mode for diff summaries.

Explicit non-goals for the first implementation pass:

- `bb thread show --json` without `--git-diff`. Plain thread status and
  environment metadata are not the current context blowup source.
- `bb thread list`. It returns metadata lists, not large generated text. If
  manager list output becomes noisy later, handle it as a separate pagination or
  summarization plan.
- `bb thread log --format minimal`. It is already the concise default.
- `bb thread log --format verbose`. It is already an explicit detail mode.
- `bb thread log --json`. It is an explicit raw event mode with an existing
  limit mechanism. Provider-context output caps in this plan still protect
  future manager turns if a manager prints large raw logs.

## Budget Constants And Shared Utility Ownership

Use `@bb/thread-view` as the owning package for the shared truncation utility.
That package already owns text projection and CLI/audit timeline formatting, is
consumed directly by the CLI and server, and is a better fit than putting
display-only helpers in domain contracts.

Implementation guidance:

- Add a generic truncation utility and exported types in `@bb/thread-view`.
- Keep call-site policy in the caller:
  - CLI commands decide when user-facing command output uses preview/full mode.
  - Server provider-context assembly decides when provider history is capped.
  - Host daemon and provider adapters keep emitting raw durable command data.
- Do not re-export the utility through unrelated packages. CLI and server should
  import it directly from `@bb/thread-view`.

Named truncation budget constants owned by `@bb/thread-view`:

| Constant | Budget | Rationale |
| --- | --- | --- |
| `THREAD_OUTPUT_PREVIEW_BUDGET` | 12,000 chars / 200 lines total; 8,000 chars / 140 lines head; 4,000 chars / 60 lines tail | Enough for a useful final-answer summary while preventing essay-sized outputs from dominating manager context. |
| `GIT_DIFF_PATCH_PREVIEW_BUDGET` | 24,000 chars / 400 lines total; 160 patch lines per file | Allows a manager to inspect representative code changes without importing a full multi-file patch. |
| `GIT_DIFF_FILE_LIST_PREVIEW_BUDGET` | 8,000 chars / 200 lines | Keeps changed-file metadata visible but bounded for broad refactors. |
| `PROVIDER_COMMAND_OUTPUT_CONTEXT_BUDGET` | 32,000 chars / 600 lines total; 24,000 chars / 450 lines head; 8,000 chars / 150 lines tail | A last-resort provider-context cap for arbitrary shell output, larger than CLI previews because it may be the only evidence for a command. |
| `PROVIDER_COMMAND_TEXT_CONTEXT_BUDGET` | 8,000 chars / 120 lines | Prevents heredocs and long quoted arguments from becoming repeated future context. |

The utility should count user-visible grapheme clusters and lines for text
budgets in Phase 1. Truncation must not split a grapheme cluster. If a budget
lands inside a cluster, cut before that cluster; the rendered preview may
underfill the nominal budget slightly to preserve valid display text. Tests
must include multibyte text and grapheme-at-boundary cases with exact expected
output.

Input byte-limit constant owned by `@bb/cli`:

| Constant | Budget | Rationale |
| --- | --- | --- |
| `CLI_TEXT_INPUT_MAX_BYTES` | 1 MiB | Prevents accidental huge prompt/message files or stdin streams from OOMing the CLI while still allowing substantial task specs. |

## Product Defaults

### `bb thread output`

Recommended default:

- Print a bounded preview, not the full output.
- Use `THREAD_OUTPUT_PREVIEW_BUDGET`.
- Preserve both beginning and end when truncating.
- If either the character or line budget is exceeded, replace the omitted middle
  with a single notice.
- Print preview content to stdout only. Human truncation notices go to stderr so
  command output cannot be confused with BB metadata.
- Print a clear stderr truncation notice with original size and opt-in command:
  - Example:
    `... [truncated 48,312 chars / 812 lines; rerun with --full for complete output]`
- Keep `(no output)` unchanged for null or empty output.
- If a future output API returns partial output for an active thread, use the
  same preview budget and say `partial output truncated` in the stderr notice.
  Today's implementation only returns completed visible output or no output.

Opt-in detail:

- `bb thread output <id> --full`
  - Restores today's text behavior.
- `bb thread output <id> --detail preview`
  - Explicitly selects the bounded preview shape; useful during the JSON
    migration release.
- `bb thread output <id> --detail full`
  - Alias for `--full`.
- `bb thread output <id> --max-chars <n> --max-lines <n>`
  - Allows a larger or smaller bounded preview.
  - Cannot be combined with `--full`.
- `bb thread output <id> --output-file <path>`
  - Writes the full output to a file and prints a short summary.
  - Uses the file path policy below.

JSON behavior:

- Final target: bounded JSON by default for large text, with truncation
  metadata.
- Migration: keep current raw JSON shape for one release, then flip the default.
  The concrete migration is in "Compatibility And Migration."

Final bounded JSON shape:

```json
{
  "output": "bounded preview",
  "truncated": true,
  "previewTruncated": true,
  "sourceChars": 60312,
  "sourceLines": 1012,
  "detail": "preview"
}
```

- `sourceChars` and `sourceLines` mean the size of the source string available
  to the CLI before CLI previewing.
- `--json --full` returns the exact current `{ "output": "..." }` shape.
- `--json --output-file <path>` writes the full text and returns metadata plus
  the file path.

### `bb thread show --git-diff`

Recommended default:

- Treat `--git-diff` as a review summary with a bounded patch preview.
- Always include:
  - thread status and environment info
  - changed file list preview
  - shortstat
  - diff target and merge base when applicable
  - whether source diff content was already capped before previewing
- Use `GIT_DIFF_PATCH_PREVIEW_BUDGET` and
  `GIT_DIFF_FILE_LIST_PREVIEW_BUDGET`.
- Preserve file boundaries. Do not blindly slice through the middle of a hunk
  when a structured per-file split is available.
- If the patch is omitted or shortened, print explicit metadata:
  - omitted files count
  - omitted hunks or lines count when known
  - source diff size when known
  - source/server cap status
  - opt-in command for full detail

Opt-in detail:

- `bb thread show <id> --git-diff --diff-detail summary`
  - Files and shortstat only; no patch body.
- `bb thread show <id> --git-diff --diff-detail preview`
  - The default.
- `bb thread show <id> --git-diff --diff-detail full`
  - Full server-returned patch body, still bounded by the server's existing
    hard source cap unless a later full-export path is added.
- `bb thread show <id> --git-diff --max-diff-chars <n> --max-diff-lines <n>`
  - Custom preview budget.
- `bb thread show <id> --git-diff --diff-output-file <path>`
  - Writes the full server-returned patch body to a file and prints summary
    metadata.
  - Uses the file path policy below.

JSON behavior:

- Final target: `--json --git-diff` returns the same semantic detail as text
  preview, not a silent raw 2 MiB patch.
- Migration: keep current raw JSON shape for one release, then flip the default.
  The concrete migration is in "Compatibility And Migration."

Final bounded JSON shape:

```json
{
  "thread": {},
  "environment": {},
  "gitDiff": {
    "files": "bounded file list preview",
    "shortstat": "12 files changed, 340 insertions(+), 82 deletions(-)",
    "diff": "bounded patch preview",
    "truncated": true,
    "previewTruncated": true,
    "sourceTruncated": false,
    "sourceDiffChars": 148221,
    "sourceDiffLines": 2384,
    "sourceFileListChars": 1900,
    "sourceFileListLines": 12,
    "detail": "preview"
  }
}
```

Field meanings:

- `previewTruncated` means BB shortened the available diff/file-list content to
  satisfy preview budgets.
- `sourceTruncated` means the source diff was already capped before the preview
  was built.
- `truncated` is `previewTruncated || sourceTruncated`.
- `sourceDiffChars` and `sourceDiffLines` are required but nullable in the
  contract. `null` means the source size is unknown because a hard cap was hit
  before full size could be measured. `null` is distinct from zero and is not a
  default.

- `--json --git-diff --diff-detail full` preserves the current raw `gitDiff`
  shape apart from existing server-side hard caps.
- `--json` without `--git-diff` stays unchanged.

Contract ownership:

- Route query and response contract types for `detail`, preview budgets,
  `truncated`, `previewTruncated`, `sourceTruncated`, source-size fields, and
  nullable unknown source sizes live in `@bb/server-contract`.
- CLI-only presentation shapes can live in `@bb/cli`, but any payload returned
  by a public route belongs in the route contract package.
- Text rendering helpers and budget constants remain owned by `@bb/thread-view`.

## Server Diff Preview Query Mode

Phase 4 adds an explicit preview mode to the diff API surface. This resolves the
current contradiction between "keep raw API behavior" and "avoid fetching 2 MiB
just to trim locally."

Decision:

- Keep existing raw behavior and raw response shape when callers use today's
  route semantics.
- Add an explicit preview query mode for callers that want bounded diff
  metadata.
- The CLI must fill preview defaults before making the request.
- The server route must validate all preview budgets and pass explicit values
  into host commands.
- Do not add optional budget fields whose omission hides defaults.
- Do not accept budget/detail fields until they are implemented end to end.

Contract shape:

- Existing raw/full mode:
  - Omitting preview mode means legacy raw/full behavior. This is a real
    semantic meaning for backward compatibility, not a hidden default.
  - `detail=full` is an explicit alias for legacy raw/full behavior.
- Preview mode:
  - `detail=preview` requires `maxDiffChars`, `maxDiffLines`,
    `maxFilePatchLines`, `maxFileListChars`, and `maxFileListLines`.
  - `detail=summary` requires `maxFileListChars` and `maxFileListLines` and
    must not return a patch body.
  - All required budget params are filled by the caller. The route does not
    invent defaults for missing preview budgets.

Host boundary:

- Host daemon remains responsible for host-local git primitives.
- Server owns product policy and passes explicit preview budgets to the host.
- If the host command contract changes to return source-size metadata, update
  `@bb/host-daemon-contract` and host-daemon tests in the same implementation
  phase.

## File Output Path Policy

Applies to `--output-file` and `--diff-output-file`.

Rules:

- The path is explicit and required. BB does not choose thread storage by
  default.
- Relative paths resolve against the CLI process current working directory.
- Parent directory must already exist.
- The final path must not already exist. Create with exclusive write semantics
  and reject existing files, directories, and final-path symlinks.
- Never overwrite existing files.
- Never create parent directories.
- Future managed artifact support or overwrite behavior requires a separate
  proposal and explicit command/flag; it is not implied by this plan.
- The CLI does not impose additional allowed roots beyond the process sandbox,
  OS permissions, and daemon/provider sandbox. The explicit path is the user's
  file-write intent.
- Success output prints the resolved path and the number of bytes written, but
  does not echo the written content.

## Long `tell` And `spawn` Prompts

### New Input Flags

Add explicit file and stdin input modes:

- `bb thread tell <id> [message]`
  - `--message-file <path>`
  - `--stdin`
- `bb thread spawn`
  - `--prompt <text>`
  - `--prompt-file <path>`
  - `--stdin`

Source rules:

- Exactly one message source is required for `tell`.
- Exactly one prompt source is required for `spawn`.
- Positional `message`, `--message-file`, and `--stdin` are mutually exclusive.
- `--prompt`, `--prompt-file`, and `--stdin` are mutually exclusive.
- File and stdin input are limited by `CLI_TEXT_INPUT_MAX_BYTES`.
- Read file/stdin bytes fully into memory before decoding and before POSTing.
  Do not stat, then later re-read different content.
- Decode as UTF-8 with fatal invalid-byte handling. Reject invalid UTF-8; do not
  lossy-decode.
- Preserve exact decoded text. Do not trim, append, or strip a trailing newline.
- Reject zero-byte file/stdin input and decoded empty strings. Whitespace-only
  non-empty text remains valid because exact text is the user's input.
- `--stdin` errors when stdin is a TTY. Do not open an interactive prompt in
  this pass.
- CLI success output shows source metadata without echoing long text:
  - `Thread thr_x updated (message: 18,421 chars from /tmp/review.md)`
  - `Thread spawned: thr_x (prompt: 22,008 chars from plans/task.md)`

Manager guidance:

- For long prompts, managers should prefer `--message-file` and
  `--prompt-file`.
- `--stdin` is useful for pipelines like `pbpaste | bb thread tell <id> --stdin`.
- Managers should avoid inline heredocs with `--stdin` because the heredoc body
  still appears in the shell command text the provider generated.

## Provider Context Redaction

CLI stdout truncation does not solve long heredoc command text. The provider
context can include the manager's own previous tool-call command string, so a
command like this is already verbose before the command runs:

```bash
bb thread spawn --prompt "$(cat <<'EOF'
... many pages ...
EOF
)"
```

Ownership decision:

- Provider-context redaction is server-owned product policy.
- The daemon/provider runtime emits raw command text and command output in
  durable events.
- The server applies command text redaction and command output previewing when
  assembling provider input for manager turns.
- The first implementation applies to manager threads only. Extending generic
  provider-context caps to all agent threads is a non-blocking follow-up.

Command text behavior:

- Detect `bb thread tell` and `bb thread spawn` commands.
- Replace long literal `--prompt`, positional message, or heredoc content with
  a placeholder that includes character count, line count, and input mode.
- Preserve thread id, flags, provider/model/reasoning overrides,
  environment/parent-thread flags, and file paths.
- Normalize file paths in provider context:
  - workspace-relative paths remain relative
  - thread-storage-relative paths remain relative to thread storage
  - paths under the user's home directory use `~/...`
  - other absolute paths preserve basename and redact the parent directory
- Redaction uses the literal command/file argument with lexical normalization
  only. Do not call `realpath`, resolve symlink targets, or otherwise follow the
  filesystem when producing provider-context paths.
- Generic fallback: for any shell command text longer than
  `PROVIDER_COMMAND_TEXT_CONTEXT_BUDGET` in a manager turn, show the first
  command line plus a placeholder for omitted literal content.

Example provider-context rendering:

```text
$ bb thread spawn --title "review auth flow" --prompt <redacted inline prompt: 22,008 chars / 410 lines> --provider codex --model gpt-5.3-codex
```

Command output behavior:

- When rendering completed command stdout/stderr back into manager provider
  context, cap each command output item with
  `PROVIDER_COMMAND_OUTPUT_CONTEXT_BUDGET`.
- Preserve head and tail with provider-context truncation metadata outside the
  retained command output body.
- Keep full durable event/log data unchanged.
- `--full` affects the immediate CLI result only. Future manager provider
  context remains capped unless a future explicit "preserve in context" product
  mode is designed.

## Compatibility And Migration

Text output:

- `bb thread output` and `bb thread show --git-diff` text defaults switch to
  preview mode in the first implementation release.
- Full text remains available through `--full`, custom budgets, redirection, or
  `--output-file` / `--diff-output-file`.

Raw public API:

- Existing raw/full diff API behavior remains available for existing callers.
- New preview/summary query modes are additive API surface, not a silent change
  to current raw response shape.

JSON:

- Use a one-release migration to avoid silently breaking scripts that do
  `bb thread output --json | jq .output` or parse raw `gitDiff`.
- Release N:
  - Add `--full`, `--detail preview`, `--detail full`, and diff detail flags.
  - Text defaults switch to preview.
  - `--json` without a detail flag preserves today's raw JSON shape.
  - Manager guides and templates switch to preview/detail flags instead of raw
    `--json` for large text surfaces.
  - Provider-context caps protect future manager turns even when raw JSON is
    printed.
- Release N+1:
  - `--json` defaults to preview shape for large text fields.
  - `--json --full` and `--json --detail full` preserve raw shapes.
  - JSON schema snapshots must make the default-shape flip explicit.

Docs:

- Update `packages/templates/src/templates/bb-guide-threads.md` and generated
  templates so managers learn the new file flags and full-detail flags.
- Update manager instructions where they currently say to review with
  `bb thread show <id> --git-diff` and `bb thread output <id>` so they describe
  preview defaults and when to opt into full detail.
- Update `qa/manual-manager-runbook.md` with the new validation commands and
  note that repeated polling remains out of scope for this plan.

## Implementation Plan

### Phase 1: Shared Truncation Contract And Constants

Add the shared utility and named budget constants in `@bb/thread-view`.

Requirements:

- Strongly typed input and result objects.
- Head/tail truncation by character and line budgets.
- Original/source character count and line count.
- Truncation reason metadata.
- Stable notice rendering.
- No ad hoc string slicing at call sites.

Exit criteria:

- Unit tests cover no truncation, exact-budget boundary, character truncation,
  line truncation, combined limits, empty output, head/tail preservation,
  multibyte text, and a grapheme-at-cut-boundary case.
- Grapheme-at-boundary tests assert exact behavior: truncation cuts before the
  cluster that would cross the budget and never emits a partial cluster.
- Truncation constants listed in
  "Budget Constants And Shared Utility Ownership" exist in one exported
  `@bb/thread-view` module and are used by tests.

### Phase 2: Server-Owned Provider Context Safeguards

Add manager provider-context command text redaction and command output caps
before or in the same release as file/stdin prompt flags.

Exit criteria:

- Long inline `bb thread tell` and `bb thread spawn` prompts are summarized in
  manager provider context with counts and preserved flags.
- Long arbitrary command text is summarized by the generic fallback.
- Long command output is head/tail truncated in manager provider context.
- Durable events/logs still retain full data.
- `--full` command results are still capped in future provider context.
- Tests assert provider input context content, not implementation call order.

### Phase 3: `bb thread output` Defaults And JSON Migration Stage 1

Implement bounded text defaults, full-detail flags, output-file support, and
Release N JSON compatibility behavior.

Exit criteria:

- Default text output is capped by `THREAD_OUTPUT_PREVIEW_BUDGET`.
- A 60,000 character / 1,000 line output previews exactly within the 12,000
  character / 200 line budget on stdout.
- Exact-budget output is not marked truncated.
- Truncation notice is written to stderr and includes source size and `--full`
  guidance.
- `--full` reproduces current text behavior.
- `--json` without detail flags preserves current raw payload shape for Release
  N.
- `--json --detail preview` returns preview shape and metadata.
- `--json --full` preserves the current raw payload shape.
- `--output-file` follows the file path policy and writes full output while
  printing/returning only metadata.

### Phase 4: `bb thread show --git-diff` Preview Modes And Server Query

Implement server preview/summary query modes, CLI diff preview modes, and
Release N JSON compatibility behavior.

Exit criteria:

- `--git-diff` text defaults to `--diff-detail preview`.
- CLI fills explicit preview budgets before calling the server.
- Server validates required preview budget query params and passes explicit
  values into host commands.
- Existing raw/full route behavior and response shape remain available.
- Text preview includes file list, shortstat, bounded patch, source/server cap
  metadata, and truncation metadata.
- Diff report metadata stays outside the patch body so copied patch text does
  not include BB truncation notices.
- `summary` omits patch body.
- `full` reproduces current patch printing up to the server source cap.
- `--json --git-diff` without detail flags preserves current raw payload shape
  for Release N.
- `--json --git-diff --diff-detail preview` returns preview shape and metadata.
- JSON full preserves current raw `gitDiff` shape.
- Double-truncation is covered: when source diff content is already capped and
  the preview trims again, `sourceTruncated`, `previewTruncated`, and
  `truncated` are all asserted separately.
- `sourceDiffChars` reflects the source content available before previewing, or
  is `null` when that size is genuinely unknown because a hard cap was hit.
- `--diff-output-file` follows the file path policy and writes full
  server-returned diff content while printing/returning only metadata.

### Phase 5: Long Prompt Input Sources

Add file and stdin input modes for `tell` and `spawn`.

Phase 5 is release-gated on Phase 2. These file/stdin prompt flags must not ship
standalone; provider-context redaction must already be available in the same
release or an earlier release.

Exit criteria:

- `tell` supports positional message, `--message-file`, and `--stdin`.
- `spawn` supports `--prompt`, `--prompt-file`, and `--stdin`.
- Phase 2 server-owned provider-context redaction has shipped in the same or an
  earlier release.
- Mutually exclusive source validation is covered by tests.
- `CLI_TEXT_INPUT_MAX_BYTES` is enforced for file and stdin input.
- Invalid UTF-8 is rejected.
- Empty file/stdin input is rejected.
- `--stdin` from a TTY errors without opening an interactive prompt.
- File/stdin text is sent exactly as decoded.
- CLI success output shows source metadata without echoing long text.
- Provider-context tests prove long file paths are normalized/redacted as
  specified.

### Phase 6: Documentation, Guides, And Manager Runbook

Update command help, guides, generated templates, manager instructions, and
manual QA docs.

Exit criteria:

- `bb guide threads` documents preview/full/detail flags.
- Manager instructions steer managers toward concise defaults and file flags.
- Manager instructions explicitly prefer `--message-file` and `--prompt-file`
  for long prompts.
- Existing runbooks that ask reviewers to inspect manager logs mention the new
  verbosity controls.
- Cross-plan notes state that provider stall detection remains owned by
  `plans/provider-turn-watchdog.md`.

### Phase 7: JSON Default Flip

After one release with compatibility flags and documentation, switch large-text
JSON defaults to preview shape.

Exit criteria:

- `bb thread output --json` defaults to preview shape for large output.
- `bb thread show --git-diff --json` defaults to preview shape for large diff.
- `--json --full` and `--json --detail full` keep raw shapes.
- JSON schema/snapshot tests make the default-shape change explicit.
- Release notes name the migration and full-detail escape hatch.

## Validation Plan

Automated validation should use Turbo per AGENTS.md:

- `pnpm exec turbo run test --filter=@bb/thread-view`
- `pnpm exec turbo run test --filter=@bb/cli`
- `pnpm exec turbo run test --filter=@bb/server`
- `pnpm exec turbo run test --filter=@bb/agent-runtime`
- `pnpm exec turbo run test --filter=@bb/host-daemon-contract`
- `pnpm exec turbo run test --filter=@bb/host-daemon`
- `pnpm exec turbo run test --filter=@bb/templates`
- `pnpm exec turbo run test --filter=@bb/integration-tests --force > /tmp/manager-cli-verbosity-integration-tests.txt 2>&1`
- `pnpm exec turbo run typecheck --filter=@bb/cli`
- `pnpm exec turbo run typecheck --filter=@bb/server`
- `pnpm exec turbo run typecheck --filter=@bb/agent-runtime`
- `pnpm exec turbo run typecheck --filter=@bb/host-daemon`

Read slow integration output after the run:

```bash
cat /tmp/manager-cli-verbosity-integration-tests.txt
```

Focused cases:

- A 60,000 character final output:
  - default `bb thread output` stays within
    `THREAD_OUTPUT_PREVIEW_BUDGET`
  - stdout contains preview content only
  - stderr notice reports source size and omitted size
  - `--full` shows exact full output
  - Release N `--json` returns current raw payload shape
  - Release N `--json --detail preview` returns preview plus metadata
  - Release N+1 `--json` returns preview plus metadata
- Exact-budget output:
  - no stderr truncation notice
  - `truncated` metadata is false in preview JSON
- Multibyte/grapheme boundary:
  - truncation does not split grapheme clusters
  - tests assert exact output when the budget lands inside a cluster
- A multi-file 150,000 character diff:
  - default `--git-diff` shows summary plus bounded patch preview
  - `--diff-detail summary` has no patch body
  - `--diff-detail full` shows the server-returned patch body
  - Release N JSON modes preserve raw by default and preview with explicit
    detail flag
  - Release N+1 JSON default is preview
- Server already-truncated diff:
  - source/server cap and preview cap are represented separately
  - `truncated` equals `sourceTruncated || previewTruncated`
- `tell` and `spawn` source handling:
  - file input preserves exact text
  - stdin preserves exact text
  - invalid UTF-8 fails
  - empty stdin/file fails
  - TTY stdin fails
  - over-1-MiB input fails before POST
  - mixed source flags fail with clear errors
  - success output never echoes long message/prompt bodies
- File output:
  - relative paths resolve against cwd
  - existing final paths are rejected
  - final-path symlinks are rejected
  - parent directories are never created
  - overwrite is never allowed
  - successful writes report bytes and resolved path
- Provider context:
  - inline heredoc prompt is redacted in manager context
  - `--prompt-file` command context preserves a normalized path
  - long command stdout is truncated in provider context with counts
  - `--full` command output is still capped in future provider context
  - persisted events remain sufficient for debugging full command results

Manual validation:

- Create a local standalone or dev environment.
- Hire a deterministic manager:

```bash
bb manager hire "$BB_PROJECT_ID" \
  --provider codex \
  --model gpt-5.3-codex \
  --reasoning-level medium \
  --name "verbosity QA"
```

- Prepare a 20,000 character worker prompt in `/tmp/bb-verbosity-worker-prompt.md`.
- Ask the manager to delegate using `bb thread spawn --prompt-file`.
- Make a child thread produce a long final answer, then have the manager inspect
  it with default `bb thread output`.
- Make a child thread produce a large diff, then have the manager inspect it
  with default `bb thread show --git-diff`.
- Inspect the manager provider capture or log and confirm:
  - no single default `bb thread output` result exceeds
    `THREAD_OUTPUT_PREVIEW_BUDGET`
  - no default `--git-diff` result exceeds
    `GIT_DIFF_PATCH_PREVIEW_BUDGET`
  - long prompt command text is summarized
  - file paths in provider context are normalized/redacted
  - full-detail opt-ins are still visible and usable when requested

## Remaining Non-Blocking Product Questions

None of these block Phase 1.

1. Should generic provider-context caps eventually apply to all threads?
   - Option A: keep Phase 2 manager-only permanently.
   - Option B: apply generic command text/output caps to all threads after the
     manager rollout.
   - Recommendation: Option B as a follow-up, after manager-specific behavior is
     validated.
2. Should a later release add a full-output artifact helper that writes into
   thread storage automatically?
   - Option A: keep explicit user paths only.
   - Option B: add `--output-artifact <name>` that writes under thread storage.
   - Recommendation: Option A for this plan; consider Option B only after file
     surfaces have a clearer artifact contract.
