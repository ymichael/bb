# Timeline Row Behavior

One block per `(kind, lifecycle)`. Edit in place to align.

## Title data model

A title is structured data, not a pre-rendered string. Each row produces one
`TimelineTitle`:

```
TimelineTitle {
  segments:    TimelineTitleSegment[]      // ordered, joined with " "
  decorations: TimelineTitleDecoration[]   // ordered, rendered after segments
  tone:        "default" | "summary" | "destructive"
  action:      TimelineTitleAction | null  // open-file-diff click target
  plain:       string                      // CLI-form joined text
}

TimelineTitleSegment {
  text:      string
  plainText: string?      // optional CLI override; defaults to text
  em:        boolean      // App applies emphasis when true
  shimmer:   boolean      // App applies the shimmer animation when true
  truncate:  boolean      // segment is eligible to ellipsize under width pressure
}

TimelineTitleDecoration =
  | { kind: "duration",        durationMs }
  | { kind: "status",          status,  durationMs? }   // error | interrupted
  | { kind: "summary-status",  errors,  interrupteds }  // bundle/step counts
  | { kind: "diff-stats",      added,   removed }
```

The CLI plain renderer formats decorations with parens (`(2s)`, `(2s, error)`,
`(1 error)`, `+8 -2`). The App renderer styles each segment per its `em` /
`shimmer` flags and renders `duration` decorations as muted text without the
CLI parens. Neither renderer hard-codes "prefix vs content" positions —
segment order is the only positional cue.

## Tags (notation only)

`[shimmer]…[/shimmer]` ongoing shimmer · `[em]…[/em]` emphasis · `[muted]…[/muted]` muted · `[optional]…[/optional]` shown only when present. These mark intent in this doc; the actual model carries the same information as structured fields above.

## Canonical title shape

```
<verb-prefix> <content|truncated> [optional duration] [optional status suffix]
```

- Content placeholders are always truncated. Notation: `<command|truncated>`, `<path|truncated>`, `<query|truncated>`, `<url|truncated>`, `<label|truncated>`, `<subject|truncated>`, `<action|truncated>`, `<description|truncated>`, etc.
- Prefix is what shimmers when the row is active/non-terminal. Completed rows wrap the whole title in `[muted]`; `[em]` on the content stays visible inside. Fully muted (no `[em]`) applies to summary rows (step/bundle) and read/list/search.
- Duration goes inside `(...)` parens in CLI. In formatted, duration is muted.
- Non-success terminal status (`error`, `denied`, `interrupted`, `expired`) goes in parens. If duration is also shown, both share one parens group, comma-separated: `(<duration>, error)`.

## Grouping (bundles vs step-summaries)

Work rows accumulate in the **open step** as the agent works. A step closes at
the next assistant-message boundary; pending steers (user messages with
`userRequest.status === "pending"`) are tail rows and do NOT close the step.

- **Open step** — emits **bundles** and **leaves**:
  - `≥2 consecutive same-concept` work rows form a `bundle-summary`.
  - Single rows stay as `work` leaves.
  - Concepts: `exploration` (read/list/search via `activityIntents`), `commands`, `tools`, `fileChanges`, `webResearch`, `delegations`.
- **Closed step** (after a boundary) — emits ONE `step-summary` aggregating all work, OR a single leaf if the step had only one item. The single leaf is tagged with `inClosedStep: true` so the renderer can apply the closed-step muted treatment without wrapping it in a redundant summary.
- **Lazy turn detail** (children of a completed `turn` row) — treated as a closed scope, so the trailing step collapses into a step-summary even without an explicit closing assistant.

## Active-latest determination

A bundle's "active-latest vs displaced" treatment is **positional, not stored on the row**. List-level renderers compute it once via `findActiveLatestBundleId(rows)`:

> The active-latest bundle is the most recent work row in the open step, **if and only if** that row is itself a `bundle-summary`. A trailing leaf displaces any earlier bundle (the bundle becomes completed-not-latest). With no work in the open step, no bundle is active-latest.

Renderers pass `isActiveLatestBundle: true` to `buildTimelineRowTitle` for the matching row only. The bundle data model has no flag.

| Frame | Open-step rows | Active-latest |
| --- | --- | --- |
| 2 reads | `[bundle(2 reads)]` | the bundle |
| 2 reads + edit | `[bundle(2 reads), edit-leaf]` | none — leaf displaces |
| 2 reads + 2 edits | `[bundle(2 reads), bundle(2 edits)]` | the edits bundle |
| 2 reads, then assistant boundary | `[step-summary]` | n/a (closed step) |

---

# user

LIFECYCLE: completed
TITLE (cli): User: <message>
TITLE (formatted): <message>
EXAMPLES: Fix the timeline spacing.
EXPANDED: n/a (content-first row, no separate detail)
DETAIL: message body inline; copy affordance + steer-action affordance on hover
CHANGES: steer-action and copy show up regardless of hover or not

LIFECYCLE: pending-steer
TITLE (cli): User: <message> [steer pending]
TITLE (formatted): <message>\n[shimmer]Steer requested[/shimmer]
EXAMPLES: After that, commit the artifact.\nSteer requested
EXPANDED: n/a
DETAIL: message body inline; pending label on toolbar line, shimmer on the label

---

# assistant

LIFECYCLE: active (streaming)
TITLE (cli): Assistant: <message-so-far>
TITLE (formatted): <message-so-far>
EXAMPLES: I am drafting the artifact.
EXPANDED: n/a
DETAIL: message body inline; growing text counts as live activity, no separate shimmer

LIFECYCLE: completed
TITLE (cli): Assistant: <message>
TITLE (formatted): <message>
EXAMPLES: The fix is ready.
EXPANDED: n/a
DETAIL: message body inline

LIFECYCLE: interrupted
TITLE (cli): Assistant: <message-so-far> (interrupted)
TITLE (formatted): <message-so-far> [muted](interrupted)[/muted]
EXAMPLES: I was about to run the tests… (interrupted)
EXPANDED: n/a
DETAIL: partial message remains visible

---

# command

LIFECYCLE: pending (awaiting approval)
TITLE (cli): Waiting for approval to run: `<command>`
TITLE (formatted): [shimmer]Waiting for approval[/shimmer] to run [em]<command|truncated>[/em]
EXAMPLES: Waiting for approval to run git push origin main
EXPANDED: auto-expanded while actionable
DETAIL: $ <command>

LIFECYCLE: resolving (approval delivered, daemon catching up)
TITLE (cli): Waiting for approval to run: `<command>`
TITLE (formatted): [shimmer]Waiting for approval[/shimmer] to run [em]<command|truncated>[/em]
EXAMPLES: Waiting for approval to run git push origin main
EXPANDED: auto-expanded while actionable
DETAIL: $ <command>

LIFECYCLE: active (running)
TITLE (cli): Running `<command>` [optional](duration)[/optional]
TITLE (formatted): [shimmer]Running[/shimmer] [em]<command|truncated>[/em] [optional][muted]<duration>[/muted][/optional]
EXAMPLES: Running pnpm test 3s
EXPANDED: auto-expanded while active
DETAIL: $ <command>\n<output stream…>

LIFECYCLE: completed-success
TITLE (cli): Ran `<command>` [optional](duration)[/optional]
TITLE (formatted): [muted]Ran [em]<command|truncated>[/em] [optional]<duration>[/optional][/muted]
EXAMPLES: Ran pnpm lint 2s
EXPANDED: collapsed by default; expandable
DETAIL: $ <command>\n<output>\nexit 0

LIFECYCLE: completed-error
TITLE (cli): Ran `<command>` ([optional]<duration>[/optional], error)
TITLE (formatted): [muted]Ran [em]<command|truncated>[/em] [optional]<duration>[/optional][/muted] [muted](error)[/muted]
EXAMPLES: Ran pnpm test 2s (error)
EXPANDED: collapsed by default; expandable
DETAIL: $ <command>\n<failure output>\nexit <code>

LIFECYCLE: denied
TITLE (cli): Permission denied: `<command>`
TITLE (formatted): [muted]Permission denied: [em]<command|truncated>[/em]
EXAMPLES: Permission denied: git push origin main
EXPANDED: collapsed; expandable for denial reason
DETAIL: $ <command>\nDenial reason if available

LIFECYCLE: interrupted
TITLE (cli): Ran `<command> ([optional]<duration>[/optional], interrupted)
TITLE (formatted): [muted]Ran [em]<command|truncated>[/em] [optional]<duration>[/optional][/muted] [muted](interrupted)[/muted]
EXAMPLES: Ran pnpm test 1s (interrupted)
EXPANDED: collapsed; expandable
DETAIL: $ <command>\n<partial output>

---

Exploration leaves (read, list, search) are `command` or `tool` rows whose `activityIntents` classify the work. The row kind in code stays `command`/`tool`; the title is rebuilt per intent. Title and detail shapes below come directly from `packages/thread-view/src/timeline-activity-intents.ts`.

# read

Source: `command`/`tool` row with `activityIntents` containing `{ type: "read", path?, name }`. Target = `path ?? name`.

LIFECYCLE: active
TITLE (cli): Reading `<path>`
TITLE (formatted): [shimmer]Reading[/shimmer] <path>
EXAMPLES: Reading AGENTS.md
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed-success
TITLE (cli): Read `<path>`
TITLE (formatted): [muted]Read <path>[/muted]
EXAMPLES: Read AGENTS.md
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed-error
TITLE (cli): Read `<path>` (error)
TITLE (formatted): [muted]Read <path>[/muted] [muted](error)[/muted]
EXAMPLES: Read AGENTS.md (error)
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: interrupted
TITLE (cli): Read `<path>` (interrupted)
TITLE (formatted): [muted]Read <path>[/muted] [muted](interrupted)[/muted]
EXAMPLES: Read AGENTS.md (interrupted)
EXPANDED: not expandable
DETAIL: none

---

# list

Source: `command`/`tool` row with `activityIntents` containing `{ type: "list_files", path? }` (the `path` field carries a glob pattern). Title shows `<pattern>` or falls back to literal `files` when no pattern.

LIFECYCLE: active
TITLE (cli): Listing `<pattern>` | Listing files
TITLE (formatted): [shimmer]Listing[/shimmer] <pattern | "files">
EXAMPLES: Listing plans/*.md; Listing files
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed-success
TITLE (cli): Listed `<pattern>` | Listed files
TITLE (formatted): [muted]Listed <pattern | "files">[/muted]
EXAMPLES: Listed plans/*.md; Listed files
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed-error
TITLE (cli): Listed `<pattern>` (error) | Listed files (error)
TITLE (formatted): [muted]Listed <pattern | "files">[/muted] [muted](error)[/muted]
EXAMPLES: Listed plans/*.md (error)
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: interrupted
TITLE (cli): Listed `<pattern>` (interrupted) | Listed files (interrupted)
TITLE (formatted): [muted]Listed <pattern | "files">[/muted] [muted](interrupted)[/muted]
EXAMPLES: Listed plans/*.md (interrupted)
EXPANDED: not expandable
DETAIL: none

---

# search

Source: `command`/`tool` row with `activityIntents` containing `{ type: "search", query, path? }`.

LIFECYCLE: active
TITLE (cli): Searching for `<query>` [optional]in `<path>`[/optional]
TITLE (formatted): [shimmer]Searching[/shimmer] for <query> [optional]in <path>[/optional]
EXAMPLES: Searching for shimmer; Searching for shimmer in packages/thread-view
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed-success
TITLE (cli): Searched for `<query>` [optional]in `<path>`[/optional]
TITLE (formatted): [muted]Searched for <query> [optional]in <path>[/optional][/muted]
EXAMPLES: Searched for shimmer; Searched for shimmer in packages/thread-view
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed-error
TITLE (cli): Searched for `<query>` [optional]in `<path>`[/optional] (error)
TITLE (formatted): [muted]Searched for <query> [optional]in <path>[/optional][/muted] [muted](error)[/muted]
EXAMPLES: Searched for shimmer (error)
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: interrupted
TITLE (cli): Searched for `<query>` [optional]in `<path>`[/optional] (interrupted)
TITLE (formatted): [muted]Searched for <query> [optional]in <path>[/optional][/muted] [muted](interrupted)[/muted]
EXAMPLES: Searched for shimmer (interrupted)
EXPANDED: not expandable
DETAIL: none

Bundled form (read + list + search together): when ≥2 exploration leaves of any intent are in the open step, they fold into a `bundle-summary` titled `Exploring N files, M lists, K searches` (active-latest) or `Explored …` (completed-not-latest).

---

# tool (generic)

LIFECYCLE: active
TITLE (cli): Running tool: `<label|truncated>` [optional](duration)[/optional]
TITLE (formatted): [shimmer]Running tool:[/shimmer] [em]<label|truncated>[/em] [optional][muted]<duration>[/muted][/optional]
EXAMPLES: Running tool: ToolSearch 1s
EXPANDED: auto-expanded while active
DETAIL: argument summary if available

LIFECYCLE: completed-success
TITLE (cli): Ran tool: `<label|truncated>` [optional](duration)[/optional]
TITLE (formatted): [muted]Ran tool: [em]<label|truncated>[/em] [optional]<duration>[/optional][/muted]
EXAMPLES: Ran tool: Glob 1s
EXPANDED: collapsed
DETAIL: argument summary; result summary; never raw JSON in title

LIFECYCLE: completed-error
TITLE (cli): Ran tool: `<label|truncated>` ([optional]<duration>[/optional], error)
TITLE (formatted): [muted]Ran tool: [em]<label|truncated>[/em] [optional]<duration>[/optional][/muted] [muted](error)[/muted]
EXAMPLES: Ran tool: ToolSearch (error)
EXPANDED: collapsed; expandable
DETAIL: argument summary; error message

LIFECYCLE: interrupted
TITLE (cli): Ran tool: `<label|truncated>` ([optional]<duration>[/optional], interrupted)
TITLE (formatted): [muted]Ran tool: [em]<label|truncated>[/em] [optional]<duration>[/optional][/muted] [muted](interrupted)[/muted]
EXAMPLES: Ran tool: ToolSearch (interrupted)
EXPANDED: collapsed
DETAIL: argument summary if any

---

# file-change

LIFECYCLE: active
TITLE (cli): <Editing|Creating|Deleting> `<path>`
TITLE (formatted): [shimmer]<Editing|Creating|Deleting>[/shimmer] [em]<path>[/em]
EXAMPLES: Editing packages/thread-view/src/timeline-view.ts
EXPANDED: auto-expanded while active
DETAIL: streaming diff if available

LIFECYCLE: completed-success
TITLE (cli): <Edited|Created|Deleted> `<path>` +<A> -<R>
TITLE (formatted): [muted]<Edited|Created|Deleted> [em]<path>[/em][/muted] [diff-added]+<A>[/diff-added] [diff-removed]-<R>[/diff-removed]
EXAMPLES: Edited packages/thread-view/src/timeline-view.ts +8 -2
EXPANDED: collapsed; expandable to diff
DETAIL: unified diff
NOTE: +/- diff stats stay color-coded at the top level; only inside step/bundle summaries do they render muted alongside the rest of the wrapper.

LIFECYCLE: completed-error
TITLE (cli): Failed to <edit|create|delete> `<path>` (error)
TITLE (formatted): [muted]Failed to <edit|create|delete> [em]<path>[/em][/muted] [muted](error)[/muted]
EXAMPLES: Failed to edit packages/thread-view/src/timeline-view.ts (error)
EXPANDED: auto-expanded
DETAIL: error message; partial diff if any

LIFECYCLE: interrupted
TITLE (cli): Interrupted while <editing|creating|deleting> `<path>`
TITLE (formatted): [muted]Interrupted while <editing|creating|deleting> [em]<path>[/em][/muted]
EXAMPLES: Interrupted while editing packages/thread-view/src/timeline-view.ts
EXPANDED: collapsed
DETAIL: partial diff if any

---

# web-search

LIFECYCLE: active
TITLE (cli): Running web search: `<query>` [optional](duration)[/optional]
TITLE (formatted): [shimmer]Running web search:[/shimmer] <query> [optional][muted]<duration>[/muted][/optional]
EXAMPLES: Running web search: React Suspense docs
EXPANDED: not expandable
DETAIL: none (web result text suppressed)

LIFECYCLE: completed-success
TITLE (cli): Ran web search: `<query>` [optional](duration)[/optional]
TITLE (formatted): [muted]Ran web search: <query> [optional]<duration>[/optional][/muted]
EXAMPLES: Ran web search: React Suspense docs
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed-error
TITLE (cli): Ran web search: `<query>` ([optional]<duration>[/optional], error)
TITLE (formatted): [muted]Ran web search: <query> [optional]<duration>[/optional][/muted] [muted](error)[/muted]
EXAMPLES: Ran web search: React Suspense docs (error)
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: interrupted
TITLE (cli): Interrupted web search: `<query>`
TITLE (formatted): [muted]Interrupted web search: <query>[/muted]
EXAMPLES: Interrupted web search: React Suspense docs
EXPANDED: not expandable
DETAIL: none

---

# web-fetch

LIFECYCLE: active
TITLE (cli): Fetching: `<url>` [optional](duration)[/optional]
TITLE (formatted): [shimmer]Fetching:[/shimmer] <url> [optional][muted]<duration>[/muted][/optional]
EXAMPLES: Fetching: https://react.dev/reference/react/Suspense
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed-success
TITLE (cli): Fetched: `<url>` [optional](duration)[/optional]
TITLE (formatted): [muted]Fetched: <url> [optional]<duration>[/optional][/muted]
EXAMPLES: Fetched: https://react.dev/reference/react/Suspense
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed-error
TITLE (cli): Fetched: `<url>` ([optional]<duration>[/optional], error)
TITLE (formatted): [muted]Fetched: <url> [optional]<duration>[/optional][/muted] [muted](error)[/muted]
EXAMPLES: Fetched: https://react.dev/reference/react/Suspense (error)
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: interrupted
TITLE (cli): Interrupted fetch: `<url>`
TITLE (formatted): [muted]Interrupted fetch: <url>[/muted]
EXAMPLES: Interrupted fetch: https://react.dev/reference/react/Suspense
EXPANDED: not expandable
DETAIL: none

---

# approval

LIFECYCLE: pending
TITLE (cli): Waiting for approval: <subject>
TITLE (formatted): [shimmer]Waiting for approval[/shimmer]: [em]<subject>[/em]
EXAMPLES: Waiting for approval: write to /etc/hosts
EXPANDED: auto-expanded while actionable
DETAIL: subject detail; approve/deny actions

LIFECYCLE: resolving
TITLE (cli): Delivering approval: <subject>
TITLE (formatted): [shimmer]Delivering approval[/shimmer]: [em]<subject>[/em]
EXAMPLES: Delivering approval: write to /etc/hosts
EXPANDED: auto-expanded
DETAIL: subject detail

LIFECYCLE: completed (granted)
TITLE (cli): Approved: <subject>
TITLE (formatted): [muted]Approved: [em]<subject>[/em][/muted]
EXAMPLES: Approved: write to /etc/hosts
EXPANDED: collapsed
DETAIL: subject detail

LIFECYCLE: denied
TITLE (cli): Approved: <subject> (denied)
TITLE (formatted): [muted]Approved: [em]<subject>[/em][/muted] [muted](denied)[/muted]
EXAMPLES: Approved: write to /etc/hosts (denied)
EXPANDED: collapsed
DETAIL: subject detail; denial reason

LIFECYCLE: expired
TITLE (cli): Approved: <subject> (expired)
TITLE (formatted): [muted]Approved: [em]<subject>[/em][/muted] [muted](expired)[/muted]
EXAMPLES: Approved: write to /etc/hosts (expired)
EXPANDED: collapsed
DETAIL: subject detail

---

# delegation (subagent)

LIFECYCLE: active
TITLE (cli): Running subagent: `<description|truncated>` (`<type>`) [optional](duration)[/optional]
TITLE (formatted): [shimmer]Running subagent:[/shimmer] [em]<description|truncated>[/em] [muted](<type>)[/muted] [optional][muted]<duration>[/muted][/optional]
EXAMPLES: Running subagent: Audit timeline (worker)
EXPANDED: auto-expanded while active; child timeline visible
DETAIL: nested timeline rail with child rows

LIFECYCLE: completed-success
TITLE (cli): Ran subagent: `<description|truncated>` (`<type>`) [optional](duration)[/optional]
TITLE (formatted): [muted]Ran subagent: [em]<description|truncated>[/em] (<type>) [optional]<duration>[/optional][/muted]
EXAMPLES: Ran subagent: Audit timeline (worker) 4m 12s
EXPANDED: collapsed for historical; expandable to nested timeline
DETAIL: nested timeline rail

LIFECYCLE: completed-error
TITLE (cli): Failed subagent: `<description|truncated>` (`<type>`) [optional](duration)[/optional]
TITLE (formatted): [muted]Failed subagent: [em]<description|truncated>[/em] (<type>) [optional]<duration>[/optional][/muted]
EXAMPLES: Failed subagent: Audit timeline (worker) (4m 12s)
EXPANDED: collapsed; expandable
DETAIL: nested timeline rail; error surfaced inside child

LIFECYCLE: interrupted
TITLE (cli): Interrupted subagent: `<description|truncated>` (`<type>`) [optional](duration)[/optional]
TITLE (formatted): [muted]Interrupted subagent: [em]<description|truncated>[/em] (<type>) [optional]<duration>[/optional][/muted]
EXAMPLES: Interrupted subagent: Audit timeline (worker) (4m 12s)
EXPANDED: collapsed
DETAIL: nested timeline rail

---

# system (compaction)

LIFECYCLE: active
TITLE (cli): Compacting context
TITLE (formatted): [shimmer]Compacting context[/shimmer]
EXAMPLES: Compacting context
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: completed
TITLE (cli): Context compacted
TITLE (formatted): [muted]Context compacted[/muted]
EXAMPLES: Context compacted
EXPANDED: not expandable
DETAIL: none

LIFECYCLE: error
TITLE (cli): Context compaction failed
TITLE (formatted): [muted]Context compaction failed[/muted]
EXAMPLES: Context compaction failed
EXPANDED: auto-expanded
DETAIL: error reason if provider supplied

LIFECYCLE: interrupted
TITLE (cli): Context compaction interrupted
TITLE (formatted): [muted]Context compaction interrupted[/muted]
EXAMPLES: Context compaction interrupted
EXPANDED: not expandable
DETAIL: none

---

# system (manager-assignment)

LIFECYCLE: completed
TITLE (cli): Thread <assigned|released|transferred> <details>
TITLE (formatted): [muted]Thread <assigned|released|transferred>[/muted] [optional][em]<details>[/em][/optional]
EXAMPLES: Thread assigned to manager
EXPANDED: not expandable unless detail differs from title (TBD: names/links per Q on manager metadata)
DETAIL: none today; may include manager/thread names later

---

# system (permission-grant lifecycle)

LIFECYCLE: pending
TITLE (cli): Waiting for permission: <action>
TITLE (formatted): [shimmer]Waiting for permission[/shimmer]: [em]<action>[/em]
EXAMPLES: Waiting for permission: write to /etc/hosts
EXPANDED: auto-expanded while actionable
DETAIL: action description

LIFECYCLE: resolving
TITLE (cli): Delivering permission: <action>
TITLE (formatted): [shimmer]Delivering permission[/shimmer]: [em]<action>[/em]
EXAMPLES: Delivering permission: write to /etc/hosts
EXPANDED: auto-expanded
DETAIL: action description

LIFECYCLE: completed (granted)
TITLE (cli): Permission granted: <action>
TITLE (formatted): [muted]Permission granted: [em]<action>[/em][/muted]
EXAMPLES: Permission granted: write to /etc/hosts
EXPANDED: collapsed
DETAIL: action description

LIFECYCLE: denied
TITLE (cli): Permission granted: <action> (denied)
TITLE (formatted): [muted]Permission granted: [em]<action>[/em][/muted] [muted](denied)[/muted]
EXAMPLES: Permission granted: write to /etc/hosts (denied)
EXPANDED: collapsed
DETAIL: action description

LIFECYCLE: interrupted
TITLE (cli): Permission granted: <action> (interrupted)
TITLE (formatted): [muted]Permission granted: [em]<action>[/em][/muted] [muted](interrupted)[/muted]
EXAMPLES: Permission granted: write to /etc/hosts (interrupted)
EXPANDED: collapsed
DETAIL: action description

LIFECYCLE: expired
TITLE (cli): Permission granted: <action> (expired)
TITLE (formatted): [muted]Permission granted: [em]<action>[/em][/muted] [muted](expired)[/muted]
EXAMPLES: Permission granted: write to /etc/hosts (expired)
EXPANDED: collapsed
DETAIL: action description

---

# system (provider/system error)

LIFECYCLE: error
TITLE (cli): <provider/system error message>
TITLE (formatted): [error]<message>[/error]
EXAMPLES: Provider rate limit exceeded
EXPANDED: collapsed; expandable to retry/backoff detail
DETAIL: provider/system supplied detail

---

# turn (lazy summary)

LIFECYCLE: completed (only state)
TITLE (cli): Worked for <duration>
TITLE (formatted): [muted]Worked for[/muted] [em]<duration>[/em]
EXAMPLES: Worked for 8m 14s
EXPANDED: collapsed by default; expand triggers lazy detail load
DETAIL: nested rows — assistant messages, step summaries, leaves — except the final assistant message of the turn, which renders as a sibling outside the turn summary

---

# step-summary

Error/interrupted child states do not surface in the summary title. The summary phrase is always neutral past-tense; failures and interruptions are visible only in expanded child rows.

LIFECYCLE: completed (only state)
TITLE (cli): <phrase>  — comma-joined past-tense clauses, one per work-kind that occurred
TITLE (formatted): [muted]<phrase>[/muted]
CLAUSES (past):
  exploration:  Explored N files[, M lists][, K searches]
  commands:     Ran N commands
  file-changes: <Edited|Created|Deleted> N files
  web:          Ran N web searches[, fetched M web pages]
  delegation:   Ran N subagents
EXAMPLES: Explored 2 files, 1 list, edited 1 file ; Ran 2 commands, edited 3 files
EXPANDED: collapsed; expandable
DETAIL: child leaf rows (commands, file changes, exploration)

---

# bundle-summary

A bundle exists when ≥2 same-concept leaves are in the open step. One clause from the step-summary grammar — present tense when active-latest, past tense when completed-not-latest. Error/interrupted child states do not surface in the bundle title; failures are visible only in expanded child rows.

LIFECYCLE: active-latest (this bundle's concept is the latest activity in the open step)
TITLE (cli): <clause-active>
TITLE (formatted): [shimmer]<verb>[/shimmer] [em]<rest>[/em]
CLAUSES (active):
  exploration:  Exploring N files[, M lists][, K searches]
  commands:     Running N commands
  file-changes: <Editing|Creating|Deleting> N files
  web:          Running N web searches[, fetching M web pages]
  delegation:   Running N subagents
EXAMPLES: Exploring 2 files, 1 list ; Running 2 commands
EXPANDED: visible/expanded; children visible
DETAIL: child leaf rows

LIFECYCLE: completed-not-latest (a different-concept leaf or bundle has taken over as the latest activity in the open step)
TITLE (cli): <clause-past>  — same clauses as step-summary
TITLE (formatted): [muted]<clause-past>[/muted]
EXAMPLES: Explored 2 files, 1 list ; Ran 2 commands
EXPANDED: collapsed
DETAIL: child leaf rows

At the assistant-message boundary, all bundles + single leaves in the step merge into one step-summary.

---

# Cross-cutting rules

- Status suffix on terminal rows: `(error)`, `(denied)`, `(interrupted)`, `(expired)`. Tone applies to the suffix, not the whole title.
- No special cases. If a `(kind, lifecycle)` block above contradicts another, that's a bug — fix the encoding, don't fork the renderer.
- App vs CLI: CLI uses TITLE (cli) literally. App uses TITLE (formatted) and may render `[shimmer]` as a shimmer animation, `[em]` as emphasis, `[muted]` as low-contrast, `[error]` as destructive tone, etc.
- Active rows expand by default until a sibling assistant message closes the step. Completed rows collapse by default unless they expose a problem.
- A row is never wrapped in a summary that contains only itself (Q1).
- The final assistant message of a finished turn renders outside the `Worked for <duration>` summary (Q2).
- Pending/resolving rows always show shimmer on the whole title or label.
- Loading is a client-local concept and uses skeleton/spinner, not work shimmer.
