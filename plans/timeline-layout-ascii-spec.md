# Timeline Layout ASCII Spec

## Status

Plan/artifact only. No product code changes.

This file is a concrete layout review surface for timeline spacing, row titles,
grouping, expansion, nested timelines, active states, app-vs-CLI parity, and
representative examples. It intentionally uses ASCII diagrams and tables instead
of prose-only requirements.

## Source Notes

This file is the design reference. The companion engineering plan is
`plans/timeline-visual-state-consistency.md`. When a behavior in this file
disagrees with current code, update the code or update this file — not both at
once and not silently.

## How To Review This Doc

Use this as a review artifact, not a requirements dump.

- `Agreed intent` rows reflect Michael's stated direction or already-agreed
  terminology.
- `Observed/current` rows describe behavior or data seen in the repo, DB, or
  branch reports. They are not automatically desired.
- `Known follow-up` rows are implementation/story/audit tasks to schedule.
- `Open question` rows need Michael input before product behavior is locked in.
- ASCII examples are examples for review. Speaker labels like `User:` and
  `Assistant:` are notation, not App-visible titles.

## Decision / Follow-Up Checklist

| Topic | Current doc stance | Status | Michael input needed |
| --- | --- | --- | --- |
| Four timeline concepts | Use `turn summary`, `step summary`, `bundle summary`, and `leaf rows` consistently. | Agreed intent | Confirm names are right. |
| App conversation rows | Content-first; no literal `User` / `Assistant` title in normal App timeline. | Agreed intent | None unless debug mode should differ. |
| User/steer Ladle coverage | Add stories showing regular user, accepted steer, pending steer, copy affordance, toolbar label placement, and pending shimmer. | Known follow-up | Confirm story sweep is complete. |
| `Worked on N items` | Parallel audit is being started to enumerate dev-DB cases and remove avoidable fallback paths. | Known follow-up | Confirm audit owner/scope. |
| Command failure display | Do not make failed command rows visually error-toned by default; show command/output/exit detail. | Agreed intent | Confirm exact failure affordance if any. |
| Read/list/search treatment | Keep rows muted for now; exact emphasis needs design audit. | Needs audit | Confirm whether any object emphasis is desired later. |
| Step boundary behavior | Each assistant-message boundary inside an unfinished turn closes the current step. Completed work between two assistant messages becomes one muted step summary; the next assistant message is its sibling. The final assistant message of a finished turn renders outside the `Worked for <duration>` block. | Agreed intent | None remaining. |

## Michael's Review Notes: Answers

| # | Question / note | Answer | Status | Source / follow-up |
| --- | --- | --- | --- | --- |
| 1 | Need Ladle fixtures/stories for regular user, steer, and steer pending; pending steer should shimmer; copy icon always visible; steer label on toolbar line; labels should be `Steer message` and `Steer requested`. | This is a follow-up implementation/story task: add Ladle stories that showcase the exact sweep of user-message states and affordances. Do not treat this doc as proof that all states already exist. | Known follow-up | See `Conversation And Steer Rows` and checklist. The isolated Ladle row stories landed on main; verify which states are still missing. |
| 2 | Does the Label And Title Matrix apply to CLI, App, or both? | Visible-copy matrices now compare App and CLI/debug in columns. Semantic model is a separate column; status stays as current/agreed/open context instead of driving the table shape. | Doc corrected | See `Conversation And Steer Rows`, `Work Row Titles`, `Grouping Titles By Concept`, and `System And Interaction Rows`. |
| C1 | Correction: should app conversation rows render literal `User` or `Assistant` titles? | No. `user` and `assistant` are semantic row kinds. App-visible conversation rows are content-first with affordances, not literal `User` / `Assistant` headings. CLI/debug surfaces can use speaker labels depending on mode. | Agreed intent | See `Conversation And Steer Rows` and `Canonical Layout Skeletons`. |
| 3 | Should expanded command detail show exit code always, or only if useful? | Always. Expanded terminal command detail order is `$ <command>`, output, then exit code, including `exit 0`. | Agreed intent | See `Command Details` and `Command Output Detail`. Implementation should be audited for parity. |
| 4 | Exact read/list/search labels and App parity. | Shared text format is `Searched for <query> [in <path>]` and `Searching for <query> [in <path>]`; App treatment is muted for now. Current implementation has known title gaps. | Agreed intent / needs audit | See `Work Row Titles`, `Grouping Titles By Concept`, and `Exploration And Generic Tool Fallback`. |
| 5 | File edit labels: created/deleted should include diff stats too. | File titles should include stats for all file operations: `Edited <path> +A -R`, `Created <path> +A -R`, and `Deleted <path> +A -R`. | Agreed intent | See `File Operation Titles` and `File Diff Detail`. |
| 6 | Prefer `Failed to edit/create/delete...` and `Interrupted while editing/creating/deleting...`; audit Creating/Deleting equivalents today. | Agreed wording is documented, but current creating/deleting per-file active/failed/interrupted support needs audit before treating every variant as current. | Needs audit | See `File Operation Titles`; create/delete failed/interrupted variants remain audit items. |
| 7 | Approval labels: remove the OR between `Command (waiting)` and `Waiting for approval on 1 command`. | Deterministic leaf title is `Command (waiting for approval)`. The approval summary can say `Waiting for approval on 1 command`, but the command row title is not nondeterministic. | Doc corrected | See `System And Interaction Rows`, `Command Details`, and `Pending Approval Interaction`. |
| 8 | `Worked on N items` is jarring; when/why does it appear? | The doc should not settle this by assertion. A parallel audit is being started to cover known dev-DB prefix/case patterns and identify/remediate avoidable fallback paths. | Known follow-up | Track audit results back into `Grouping Titles By Concept` and `Open Questions`. |
| 9 | Clarify `Loading ... Skeleton or spinner, not shimmer-as-work`. | Loading means client-local fetch/lazy-load state. It can use a skeleton or spinner, but not ongoing agent-work shimmer; it is not durable timeline work. | Doc corrected | See `Lifecycle Treatment Matrix` and `Loading, Retry, Empty`. |
| 10 | Clarify `Shimmer on whole title`. | Shimmer applies to the whole title text/label concept, not only to a title prefix segment. This covers content-only titles and pending steer labels. | Agreed intent | See `Lifecycle Treatment Matrix`, pending steer rows, and context compaction rules. |
| 11 | Clarify why historical completed turns "may" collapse. | Completed historical turns are eligible for lazy turn summaries; active turns stay expanded and leaf-first. | Doc corrected | See `Historical Turn, Collapsed`. |
| 12 | Remove or clarify confusing consecutive `Worked for...` / `Worked on...` rows. | The confusing consecutive worked rows were removed from examples. `Worked on N items` remains only as an explicit current/open fallback note, not agreed UX. | Doc corrected | See `Timeline Grouping Model`, `Historical Turn, Collapsed`, and `Grouping Titles By Concept`. |
| 13 | Is `Read 6 files, listed 2 directories` real, or should it be `Explored 6 files, 2 lists`? | The observed/agreed summary style is `Explored 6 files, 2 lists`; the old read/list wording is documented only as a corrected stale example. | Doc corrected | See `Grouping Titles By Concept`, `Historical Turn, Expanded`, and `Exploration And Generic Tool Fallback`. |
| 14 | Clarify examples where User and final Assistant appear inside a `Worked for` block. | The initial user request that starts a turn is outside the turn summary. The final assistant message of the turn renders outside `Worked for <duration>` as its sibling. Earlier in-turn assistant messages and steer/user leaves remain inside the block. | Agreed intent | See `Historical Turn, Expanded` and `Active Streaming Progression`. |
| 15 | Active tail should not have `Working on`; use Michael's snapshot progression. | Active tail uses visible leaf rows or bundle summaries such as `Exploring 2 files, 1 list` and `Running 2 commands`. `Working on N items` is not agreed active-tail copy. | Agreed intent | See `Timeline Grouping Model`, `Active Streaming Progression`, and `Grouping Rules By Concept`. |

## Timeline Grouping Model

Use these four terms consistently. This section defines the review vocabulary;
it is not claiming every edge case is already implemented.

Concept definitions:

| Concept | When it exists | Contains | Not this |
| --- | --- | --- | --- |
| Turn summary | Only after the turn is finished. | Expanded content can include messages, step summaries, bundle summaries, and leaf rows from that turn. | Active-tail grouping. |
| Step summary | At a completed assistant-step boundary. | Completed work from that assistant step, aggregated into one muted row. | The final `Worked for <duration>` turn summary. |
| Bundle summary | While related work belongs to the current unfinished assistant step. | Similar-type leaves. Active form keeps live/current leaves visible; completed-before-boundary form can collapse same-type completed leaves. | `Working on N items`, the all-type step summary, or the final turn summary. |
| Leaf rows | Whenever the underlying event/message/system row exists. | User, assistant, steer, command, file, read/list/search, web, manager assignment, compaction, loading/retry, etc. | A grouped summary row. |

Visible treatment:

| Concept | App visible treatment | CLI text | Status |
| --- | --- | --- | --- |
| Turn summary | `[muted]Worked for <duration>[/muted]`; static, not shimmered. | `Worked for <duration>` with nested detail in verbose/expanded mode. | Observed/current and agreed terminology. |
| Step summary | `[muted]Explored 2 files, 1 list, edited 1 file[/muted]`; lower emphasis than active work. | `Explored 2 files, 1 list, edited 1 file`. | Agreed intent. |
| Bundle summary | Active: `[shimmer]Exploring[/shimmer] 2 files, 1 list` or `[shimmer]Running[/shimmer] 2 commands`; live child remains visible/expanded. Completed before boundary: `[muted]Explored 2 files, 1 list[/muted]`. | `Exploring 2 files, 1 list`; `Running 2 commands`; `Explored 2 files, 1 list`. | Observed/current for completed-before-boundary form. |
| Leaf rows | Treatment depends on leaf type. Conversation leaves are content-first; command/file/read leaves use the row rules below. | Direct row text, optionally verbose detail. | Mixed current/agreed; see row tables. |

Rules:

- A turn summary is never an active bundle summary and never a replacement for a
  step summary. It can contain step summaries when expanded.
- A step summary is muted completed work at an assistant boundary. It
  is not titled `Worked for <duration>`.
- A bundle summary groups similar leaves in an unfinished assistant step. Active
  bundle summaries show live leaves; completed-before-boundary bundle summaries
  can collapse same-type completed leaves until the step boundary.
- A bundle summary is not `Working on N items`, the all-type step summary, or
  the final turn summary.
- A leaf row is never "inside" a step summary or bundle summary as user-facing
  copy, but leaf rows can appear inside expanded turn-summary detail.
- Single completed successful work can remain a muted direct leaf rather than
  becoming a one-child step summary.

## DB Scenario Corpus

Thread ids and titles are shortened. Counts are event-shape counts, not final UI
row counts.

| Sample | Thread | Shape | Why It Is Representative |
| --- | --- | --- | --- |
| S1 | `thr_bj...` Manager | manager, idle, 3607 events, 120 turns, 32 child threads, 122 manager messages, 2055 command events, 4 compactions | Manager conversation mode, manager-to-user updates, subagent orchestration, steers, and child-thread grouping. |
| S2 | `thr_c2...` Timeline UI follow-ups | active child of manager, 712 events, 2 turns, 320 command events, 24 file events, 2 compactions | Active shippability work with tail activity, diffs, test runs, context pressure, and active-vs-historical transitions. |
| S3 | `thr_3v...` File list inconsistency | idle child of manager, 2377 events, 33 turns, 620 command events, 282 file events, 846 tool events, 2 web events, 1 manager assignment op | Mixed exploration, tool calls, file edits, assignment row, and repeated turns. Good spacing stress case. |
| S4 | `thr_yr...` Fix thread links | idle standard, 8792 events, 13 turns, 7008 command events, 330 file events, 6 web events, 10 compactions | Long command-output and context-compaction case. Useful for detail truncation and historical turn collapse. |
| S5 | `thr_jf...` Audit manager | idle child of manager, 8871 events, 30 turns, 6361 command events, 249 file events, 12 compactions, 1 manager assignment op | Very heavy review/audit thread with many historical turns. Tests collapsed-summary density. |
| S6 | `thr_p93...` Server restart diagnosis | idle child of manager, 1423 events, 11 turns, 618 command events, 108 file events, 3 web events, 2 compactions, 1 manager assignment op | Server/API/log investigation with web, file, command, operation, and interruption risk. |
| S7 | `thr_98...` Timeline ASCII artifact | active child of manager, 207 events, 1 turn, 112 command events | Current active single-turn worker. Useful for active streaming leaf rows and "Working..." tail placement. |

Observed global event distribution highlights:

| Event shape | Count | Layout implication |
| --- | ---: | --- |
| `item/commandExecution/outputDelta` | 22701 | Command output must be compact by default and readable when expanded. |
| `item/started/completed commandExecution` | 24233 | Commands are common enough to need a stable row title rule. |
| `item/started/completed toolCall` | 7936 | Generic tool fallback and exploration grouping must be first-class. |
| `item/started/completed reasoning` | 8833 | Thinking/reasoning should not create noisy timeline rows unless summarized intentionally. |
| `item/started/completed fileChange` plus deltas | 2639 | Diffs need predictable nested detail spacing. |
| `system/manager/user_message` | 122 | Manager user-facing updates need app and CLI parity. |
| `contextCompaction` item rows plus `thread/compacted` | 80 | Compaction needs explicit wording and shimmer policy. |
| `webSearch` and `webFetch` item rows | 13 | Web rows are rare but distinct from read/list exploration. |
| `system/operation` | 5 | Manager assignment and ownership rows are rare but high-signal. |
| `system/thread/interrupted` | 14 | Interrupted terminal rows need visible but non-error treatment. |

Observed terminal status distribution:

| Work kind | Completed | Failed | Notes |
| --- | ---: | ---: | --- |
| Command execution | 11776 | 419 | Failure rows must remain visible in collapsed summaries. |
| File change | 976 | 5 | Failed file edits are rare but should not collapse into success labels. |
| Tool call | 3903 | 121 | Generic tool fallback must support failure detail. |

## ASCII Legend

Use this notation in review diagrams:

Important: `[ ] User` and `[ ] Assistant` are ASCII/speaker notation only.
They are not App-visible row titles. The App timeline remains content-first for
conversation rows.

```text
[+] collapsed expandable row
[-] expanded expandable row
[ ] non-expandable row
[~] shimmer
[!] error row
[x] interrupted or denied row
    child indentation level
|   nested timeline rail
... elided detail
```

This is only a review notation. Product UI can use icons instead of these
markers, but the row relationships and spacing should be the same.

## Status Markers

Keep status visible, but do not let it drive the table shape.

| Status | Meaning |
| --- | --- |
| Observed/current | Behavior or data observed in current code, DB, or branch reports. Not automatically agreed intent. |
| Agreed intent | Michael's stated direction or agreed terminology. |
| Known follow-up | Implementation, story, or audit work to schedule. |
| Doc corrected | This artifact was changed to remove stale or confusing wording. |
| Open question | Needs a product decision before product code should lock it in. |
| Needs audit | Copy or treatment is plausible, but current support or exact design is not verified. |

## Visible Copy And Treatment Matrices

These matrices compare product-facing surfaces directly. `Semantic model` names
the internal concept only so it does not leak into App copy. App cells include
visual treatment when it affects shippability: emphasis, muted state, shimmer,
affordance placement, expansion defaults, and warning/error treatment.

### Conversation And Steer Rows

| Concept | Semantic model | App visible treatment | CLI/debug text | Status | Notes / follow-up |
| --- | --- | --- | --- | --- | --- |
| Regular user message | row kind `user` | Content-first message row. No literal `User` title. | Can print `User` in transcript/debug modes. | Agreed intent | The initial user request stays outside its turn summary. Steer/user leaves inside a finished turn can appear in expanded turn-summary detail. User leaves are excluded from step and bundle summaries. |
| Assistant message | row kind `assistant` | Content-first response. No literal `Assistant` title. | Can print `Assistant` in transcript/debug modes. | Agreed intent | Interrupted assistant text remains visible. |
| Accepted steer | row kind `user` plus steer metadata | Content-first message row. Toolbar label: `Steer message`. | Observed CLI/debug can print `steer`. | Agreed intent / needs audit | CLI copy should be audited if shared labels change. |
| Pending steer | row kind `user` plus pending steer metadata | Content-first tail row. `[shimmer]Steer requested[/shimmer]` on toolbar line; body remains readable. | Observed CLI/debug can print `steer pending`. | Observed/current | Shared semantic row, not an App-only side channel. |
| User row toolbar | user row affordances | Copy icon always visible; steer label shares toolbar line. | n/a | Known follow-up | Add Ladle stories for regular, accepted steer, pending steer, copy affordance, label placement, and pending shimmer. |
| Manager user update | manager-visible assistant update semantic row | Body visible in manager conversation mode; do not force an `Assistant` title in the App. | CLI/debug can print speaker labels depending on view mode. | Observed/current | Hidden from standard worker timeline unless standard manager view is requested. |

### Work Row Titles

| Concept | Semantic model | App visible treatment | CLI text | Status | Notes / follow-up |
| --- | --- | --- | --- | --- | --- |
| Completed single work, any terminal status | single terminal work item | `[muted]Ran [em]<command>[/em] <duration if over 1s>[/muted]`. Append a status suffix when the row is non-success: `(error)`, `(denied)`, `(interrupted)`. Tone shifts on the suffix only; the row stays muted/leaf. | `Ran <command> <duration>`; with suffix when applicable. | Agreed intent | Single terminal rows are always muted leaves regardless of status. No summary wrapper around one child. |
| Command row | command execution | Running: `[shimmer]Running[/shimmer] [em]<command>[/em] <duration if over 1s>`. Completed and failed terminal titles use the same neutral/muted structure, for example `[muted]Ran [em]<command>[/em] 2s[/muted]`; failure is shown by detail/output/exit. | `Running <command> <duration>`; `Ran <command> <duration>` plus detail exit. | Agreed intent / needs audit | Exact App emphasis and terminal failed-title copy need implementation audit. |
| Command approval row | command awaiting approval | `[shimmer]Waiting for approval[/shimmer] for [em]<command>[/em]`. | `Command (waiting for approval)` or approval summary text. | Agreed intent | Observed CLI can still show `Command (waiting)`. |
| File change row | file change item | `[muted]Edited [em]<path>[/em] +A -R[/muted]`; active title can shimmer on verb. Stats remain visible. | `Edited <path> +A -R`; `Created <path> +A -R`; `Deleted <path> +A -R`. | Agreed intent / needs audit | Create/delete active and failure equivalents need implementation audit. |
| Read/list/search row | local exploration item | Muted throughout for now: `[muted]Searched for <query> [in <path>][/muted]`. No App emphasis until design audit. | `Searched for <query> [in <path>]`; `Listed <pattern> [in <path>]`. | Agreed intent / needs audit | Search title parity has current gaps. |
| Web search/fetch row | web item | Muted row showing query or URL only; suppress result payload. Active rows can shimmer on verb. | `Running web search: <query>`; `Fetched: <url>`. | Observed/current | Future detail view needs separate security/product decision. |
| Generic tool fallback | typed or unknown tool call | Muted tool label; arguments/results appear only in expanded detail. | `Ran tool: <label>` or `Running tool: <label>`. | Agreed intent | Do not expose raw JSON in title. |
| Delegation/subagent | subagent work item | `[shimmer]Running subagent[/shimmer]: <description> (<type>)`; expanded detail opens with nested timeline. | `Running subagent: <description> (<type>)`. | Observed/current / needs audit | Child timeline owns its own rail and indentation. |

### Grouping Titles By Concept

| Concept | App visible treatment | CLI text | Status | Notes / follow-up |
| --- | --- | --- | --- | --- |
| Turn summary | `[muted]Worked for <duration>[/muted]`; finished turn only. | `Worked for <duration>`. | Observed/current | Expanded detail can contain messages, step summaries, bundle summaries, and leaf rows. |
| Step summary, exploration | `[muted]Explored 2 files, 1 list[/muted]`. | `Explored 2 files, 1 list`. | Agreed intent | `Read 6 files, listed 2 directories` is stale wording. |
| Step summary, commands | `[muted]Ran 2 commands[/muted]`; failed child must still be discoverable in detail. | `Ran 2 commands`. | Agreed intent | Closed at each assistant-message boundary. |
| Step summary, mixed | `[muted]Explored 2 files, 1 list, edited 1 file[/muted]`. | `Explored 2 files, 1 list, edited 1 file`. | Agreed intent | Used at completed assistant-step boundaries. |
| Bundle summary, exploration | `[shimmer]Exploring[/shimmer] 2 files, 1 list`; live leaf rows remain visible enough to understand progress. | `Exploring 2 files, 1 list`. | Observed/current | Not a turn summary. |
| Bundle summary, commands | `[shimmer]Running[/shimmer] 2 commands`; latest running command expands to output. | `Running 2 commands`. | Observed/current | Active tail targets latest expandable bundle summary or leaf row. |
| Bundle summary, completed before boundary | `[muted]Explored 2 files, 1 list[/muted]`; same-type completed bundle inside an unfinished assistant step. | `Explored 2 files, 1 list`. | Agreed intent | Merges into the step summary at the next assistant-message boundary. |
| Unknown fallback | Low-confidence current fallback. Avoid for active tails. | `Worked on N items`. | Known follow-up | Parallel audit is being started to enumerate and eliminate avoidable fallback paths. |

### File Operation Titles

| Operation | App visible treatment | CLI text | Status | Notes / follow-up |
| --- | --- | --- | --- | --- |
| Edit | `[muted]Edited [em]<path>[/em] +A -R[/muted]`; active title can shimmer on verb. | `Edited <path> +A -R`; `Editing <path>`. | Agreed intent | Failed: `Failed to edit <path>`. Interrupted: `Interrupted while editing <path>`. |
| Create | `[muted]Created [em]<path>[/em] +A -R[/muted]`. | `Created <path> +A -R`; `Creating <path>`. | Agreed intent / needs audit | Verify creating failed/interrupted equivalents in implementation. |
| Delete | `[muted]Deleted [em]<path>[/em] +A -R[/muted]`. | `Deleted <path> +A -R`; `Deleting <path>`. | Agreed intent / needs audit | Verify deleting failed/interrupted equivalents in implementation. |
| Rename/move | Emphasize old/new paths; stats secondary. | `Renamed <old> -> <new> +A -R`. | Open question | Only document as agreed if the model supports it. |

### Command Details

| Case | App visible treatment | CLI text | Status | Notes / follow-up |
| --- | --- | --- | --- | --- |
| Running command detail | `$ <command>` first, then streaming output. Row title: `[shimmer]Running[/shimmer] [em]<command>[/em] <duration if over 1s>`. | `$ <command>`, output stream. | Agreed intent | Exit appears once terminal. |
| Completed command detail | Command first, output next, exit last. Row title stays neutral/muted. | `$ <command>`, output, `exit 0`. | Agreed intent | Exit code is always shown. |
| Failed command detail | Title is muted with status suffix: `[muted]Ran [em]<command>[/em] 2s (error)[/muted]`. Suffix carries the status tone; the rest of the title stays neutral/muted. Detail still shows output and `exit <code>`. | `$ <command>`, failure output, `exit 1`. | Agreed intent | Status suffix is the same one rule across success, error, denied, interrupted. |
| Approval command detail | Row title: `[shimmer]Waiting for approval[/shimmer] for [em]<command>[/em]`; no fake output. | `$ git push origin main`. | Agreed intent / needs audit | CLI leaf title needs audit. |

### System And Interaction Rows

| Concept | Semantic model | App visible treatment | CLI text | Status | Notes / follow-up |
| --- | --- | --- | --- | --- | --- |
| Approval summary | pending/resolving approval lifecycle | Waiting treatment and expanded actionable row. Resolving uses shimmer until terminal. | `Waiting for approval on 1 command`; `Delivering approval for Bash`. | Agreed intent | Denied/expired are terminal and not animated. |
| Context compaction | context compaction item/system event | Pending title uses shimmer on the full title. Completed is static and usually non-expandable. | `Compacting context`; `Context compacted`. | Agreed intent / needs audit | Prefer this over `Context compacting...` if implementation audit confirms path. |
| Manager assignment | system operation | Single non-expandable system row unless detail adds value. | `Thread assigned to manager`. | Observed/current | Names/links require typed metadata. |
| Loading/retry | client-local load state | Skeleton/spinner, not work shimmer. Retry row uses warning treatment and action affordance. | Usually omitted unless interactive; otherwise `Loading turn...` / retry text. | Agreed intent | Not durable timeline work. |
| Global activity | thread/global activity state | Tail indicator adjacent to timeline content: `Working...`, `Waiting for approval`, `Reconnecting...`. | Usually omitted if active rows already show state. | Needs audit | Distinct from row-level durable work. |

## Lifecycle Treatment Matrix

| Lifecycle | App visible treatment | CLI text/rendering | Default expansion | Status |
| --- | --- | --- | --- | --- |
| Loading | Client-local skeleton or spinner. Muted. Never shimmer like agent work. | Usually omitted unless interactive; otherwise `Loading ...`. | Inline placeholder, no children. | Agreed intent |
| Pending | Shimmer on the whole title or label, not only a prefix. | `waiting` status or explicit waiting title. | Auto-expand if actionable. | Agreed intent |
| Resolving | Shimmer until terminal. | `resolving` or `delivering`, not `running`. | Auto-expand until terminal. | Agreed intent |
| Active | Shimmer on the title/label. Active leaf output is visible when useful. | `running` status and live title. | Auto-expand active leaf and bundle summary. | Agreed intent |
| Retryable error | Retry affordance; no shimmer. | `Retry: <thing>` line if shown. | Expanded retry affordance visible. | Agreed intent |
| Error | Problem detail visible without hunting through output. | `error` or `exit N`; detail visible in verbose. | Auto-expand problem detail. | Agreed intent |
| Interrupted | Muted/interrupted treatment, not fatal error styling. | `interrupted`. | Expanded only if detail explains interruption. | Agreed intent |
| Completed | Static. Step summaries and single successful leaves render muted. | `completed` suffix only where status matters. | Collapsed unless user expanded or policy keeps detail. | Observed/current. |

## Spacing, Indent, And Nesting Rules

These are proposed review defaults. They should be tuned in product UI, but every
renderer should follow the same relationships.

| Rule | App target | CLI/ASCII target |
| --- | --- | --- |
| Top-level sibling gap | 8 px vertical gap between rows/groups | One blank line between top-level rows. |
| Parent to first child | 4 px after expanded parent title | Next line, no blank line. |
| Child sibling gap | 4 px inside an expanded group | No blank line between compact child rows unless child has multiline detail. |
| Nested timeline indent | 24 px per nested timeline level | 2 spaces per nested level. |
| Detail indent | Align detail under title text after icon/rail | 2 spaces under the row header. |
| Nested rail | One subtle left rail per expanded nested timeline | `|` rail in examples. No box drawing. |
| Title-detail gap | 4 px | Immediate next line. |
| Detail block typography | Monospace for command, output, SQL, diffs; UI body token for prose | Code-like lines under two spaces. |
| Long command output | Collapsed command or completed step row hides output; expanded detail can truncate with explicit notice | Show `$ command`, then output, then `... [truncated N lines]`. |
| Diffs | Diff block is the primary detail for file rows | Diff lines directly under file row. |
| Empty active detail | Row title still shows ongoing state; detail can say `No output yet` only if expansion would otherwise be blank | Avoid empty expanded body unless row is still streaming. |
| Error detail | Problem line must be visible without hunting through output | `exit N` or error line directly below command/tool title. |
| Loading | Placeholder uses loading style, not work shimmer | `Loading turn...` single line. |
| Retry | Retry affordance replaces loading placeholder | `Could not load turn details. Retry.` |
| Manager assignment | No expandable detail if detail duplicates title | Single non-expandable system row. |
| Compaction | Pending compaction title can move; completed compaction is static | Single system row unless provider detail exists. |

Example surface: ASCII/semantic notation. `[ ] User` and `[ ] Assistant` below
are speaker markers for review diagrams, not App-visible titles.

Spacing diagrams below use `.` only to make blank lines visible in review. The
actual UI/CLI output should render those as vertical whitespace.

Top-level sibling rows:

```text
[ ] User
    Fix the timeline spacing.
.
[+] Ran 2 commands
.
[ ] Assistant
    I tightened the row layout and added examples.
```

No blank line between a title and its own detail:

```text
[-] Ran command 4s
    $ pnpm exec turbo run test --filter=@bb/thread-view
    PASS packages/thread-view/test/timeline-view.test.ts
.
[ ] Assistant
    Tests pass.
```

Collapsed versus expanded step summary:

```text
[+] Ran 3 commands, edited 1 file
.
[ ] Assistant
    The implementation is ready.
```

```text
[-] Ran 3 commands, edited 1 file
  |
  [+] Ran command 1s
  |
  [+] Ran command 3s
  |
  [ ] Ran command 2s
  |   $ pnpm test
  |   exit 1
  |
  [-] Edited packages/thread-view/src/timeline-view.ts +8 -2
      @@
      + build grouped spacing policy
.
[ ] Assistant
    The implementation is ready.
```

Expanded turn summary containing step summaries:

```text
[ ] User
    Review the active-tail grouping rules.
.
[-] Worked for 6m 12s
  |
  [+] Explored 4 files, 1 search
  |
  [+] Ran 2 commands
  |
  [ ] Assistant
      Found the inconsistency and wrote a focused fix.
.
[ ] User
    Also check CLI parity.
```

Nested delegation/subagent timeline:

```text
[-] Running subagent: Timeline UI behavior consistency (worker) [~]
  |
  [ ] User
  |   Audit timeline visual-state discrepancies.
  |
  [-] Exploring 5 files [~]
  | |
  | [+] Read packages/thread-view/src/timeline-view.ts
  | |
  | [-] Running command [~]
  |     $ rg -n "shimmerPrefix" packages
  |
  [ ] Assistant
      I found the content-only shimmer bug.
.
[ ] Assistant
    Started the worker and linked it to the manager plan.
```

Pending tail with accepted steer and global activity:

```text
[ ] User
    Create a concrete ASCII layout artifact.
.
[ ] User
    Also include app-vs-CLI notes.
    Steer message
.
[-] Exploring 1 file [~]
  |
  [+] Read AGENTS.md
.
[-] Running sqlite3 query [~]
    $ sqlite3 -readonly ~/.bb-dev/bb.db "SELECT type, count(*) ..."
.
[-] Editing plans/timeline-layout-ascii-spec.md [~]
.
[~] Working...
```

Pending optimistic steer stays visible at the tail:

```text
[ ] User
    Add before/after Working placement.
    Steer requested
.
[~] Working...
```

`Working...` placement regression, before:

```text
[ ] User
    Small active task.
.
[-] Running command [~]
    $ rg -n "ConversationWorkingIndicator" apps packages
.
.
.
.
.
[~] Working...
```

`Working...` placement target, after:

```text
[ ] User
    Small active task.
.
[-] Running command [~]
    $ rg -n "ConversationWorkingIndicator" apps packages
.
[~] Working...
```

Do not use nested cards for nested timelines. Use a rail and indentation. Cards are
reserved for repeated list items, modal-like surfaces, or framed tools; timeline
rows should remain in one continuous vertical flow.

## Canonical Layout Skeletons

Example surface: ASCII/semantic notation unless a section explicitly says
CLI/debug. Speaker markers are not App-visible conversation titles.

### Historical Turn, Collapsed

Use for S4/S5 heavy historical turns.

```text
[ ] User
    Fix the turn summary detail loading bug.

[+] Worked for 8m 14s

[ ] Assistant
    Updated the implementation and ran focused tests.
```

Rules:

- Completed historical turns are eligible for lazy turn summaries. Active turns
  stay expanded.
- Summary title is past tense.
- Prefer `Worked for <duration>` when duration exists. Current fallback
  `Worked on N items` appears only when duration and semantic categories are
  unavailable; agreed product copy should avoid it.
- No active shimmer or global `Working...` appears inside historical turn rows.
- Expanding a turn loads children in place.

### Historical Turn, Expanded

```text
[ ] User
    Fix the turn summary detail loading bug.

[-] Worked for 8m 14s
  |
  [ ] Assistant
  |   I am checking the projection and renderer contracts.
  |
  [+] Explored 6 files, 2 lists
  |
  [+] Ran 3 commands
  |
  [+] Edited 2 files
  |
  [ ] Assistant
      I found the bug and patched the renderer.

[ ] Assistant
    The fix is ready.
```

Rules:

- The user request that starts the turn is outside the completed turn summary.
- Assistant messages and work produced within that turn are inside the expanded
  `Worked for <duration>` block.
- The final assistant message of the turn renders outside the turn summary, as
  a sibling after `Worked for <duration>`. Earlier in-turn assistant messages
  remain inside the block.
- Parent-to-child spacing is tight; child rows share one nested rail.

### Active Streaming Progression

These snapshots show one turn moving forward over time. `User:` and
`Assistant:` are speaker notation for the diagram, not App-visible titles.

The transition is:

1. Leaf rows show first.
2. Similar live leaves become a bundle summary.
3. Completed same-type work from the current unfinished step can remain visible
   as a completed bundle summary until the step boundary.
4. At the next assistant-message boundary, completed work becomes a muted
   step summary.
5. When the whole turn finishes, the historical turn can become `Worked for
   <duration>`.

User only:

```text
User: Create the timeline ASCII layout artifact.
```

Assistant starts and one leaf appears:

```text
User: Create the timeline ASCII layout artifact.
Assistant: I am reading the relevant docs.
Read AGENTS.md
```

Similar live leaves form a bundle summary:

```text
User: Create the timeline ASCII layout artifact.
Assistant: I am reading the relevant docs.
Exploring 2 files [bundle summary]
  Read AGENTS.md
  Read docs/CODE_REVIEW.md
```

The bundle summary updates as more similar work starts:

```text
User: Create the timeline ASCII layout artifact.
Assistant: I am reading the relevant docs.
Exploring 2 files, 1 list [bundle summary]
  Read AGENTS.md
  Read docs/CODE_REVIEW.md
  Listed plans/*.md in plans
```

Exploration is done, but the assistant step is still active:

```text
User: Create the timeline ASCII layout artifact.
Assistant: I am drafting the artifact.
Explored 2 files, 1 list [completed bundle summary; current step still open]
Edited plans/timeline-layout-ascii-spec.md +42 -8
```

The next assistant message creates the step summary boundary:

```text
User: Create the timeline ASCII layout artifact.
Assistant: I am drafting the artifact.
Explored 2 files, 1 list, edited 1 file [step summary, collapsed]
Assistant: I am checking the generated examples.
```

A new active command leaf starts after that step summary:

```text
User: Create the timeline ASCII layout artifact.
Assistant: I am drafting the artifact.
Explored 2 files, 1 list, edited 1 file [step summary, collapsed]
Assistant: I am checking the generated examples.
Running pnpm test 3s
  $ pnpm test --filter=@bb/thread-view
  test output stream...
```

Similar command work becomes a command bundle summary:

```text
User: Create the timeline ASCII layout artifact.
Assistant: I am drafting the artifact.
Explored 2 files, 1 list, edited 1 file [step summary, collapsed]
Assistant: I am checking the generated examples.
Running 2 commands [bundle summary]
  Ran pnpm lint 2s [completed leaf row]
  Running pnpm test 3s
    $ pnpm test --filter=@bb/thread-view
    test output stream...
```

The next assistant message turns command work into a step summary:

```text
User: Create the timeline ASCII layout artifact.
Assistant: I am drafting the artifact.
Explored 2 files, 1 list, edited 1 file [step summary, collapsed]
Assistant: I am checking the generated examples.
Ran 2 commands [step summary, collapsed]
Assistant: The artifact is ready for review.
```

Finally, after the turn is done, the historical turn can collapse:

```text
User: Create the timeline ASCII layout artifact.
Worked for 9m 40s [turn summary]
  Assistant: I am drafting the artifact.
  Explored 2 files, 1 list, edited 1 file [step summary, collapsed]
  Assistant: I am checking the generated examples.
  Ran 2 commands [step summary, collapsed]
  Assistant: The artifact is ready for review.
Assistant: The final response can remain outside if it is outside the lazy range.
```

Rules:

- Bundle summaries prioritize visibility of live/current leaves. The running
  child should be expanded enough to understand what is happening.
- Step summaries are muted and collapsed by default, but problems must
  surface.
- Turn summaries are only for finished turns and are titled `Worked for
  <duration>`.
- `Working on N items` is not agreed active-tail copy.
- Active-tail expansion targets the latest expandable bundle summary or
  active leaf, not the literal final row.
- The global activity row sits adjacent to the latest timeline content. It should
  not be pushed to the bottom of an otherwise empty flex area.

### Step Summary

Use when a completed assistant step has completed work before the next assistant
message. This is not the `Worked for <duration>` turn summary.

```text
[+] Ran 2 commands, edited 1 file

[ ] Assistant
    The duplicate manager detail is now suppressed and tests pass.
```

Expanded:

```text
[-] Ran 2 commands, edited 1 file
  |
  [+] Ran command 4s
  |
  [+] Ran command 1s
  |
  [-] Edited packages/thread-view/src/parse-operation-message.ts +3 -1
      @@
      - decoded.message
      + messageDetail !== title ? messageDetail : undefined

[ ] Assistant
    The duplicate manager detail is now suppressed and tests pass.
```

Rules:

- The assistant message after the step is a sibling after the completed step
  summary.
- Step summaries are muted and collapsed unless user expanded, problem policy
  expands, or CLI verbose mode is selected.
- One-child step summaries do not exist; single terminal work rows render as
  muted leaves regardless of status (Q1).
- Each assistant-message boundary inside an unfinished turn closes the current
  step. Completed work between two assistant messages becomes one muted step
  summary; the next assistant message is a sibling after it.

### Nested Subagent Timeline

Use for S1 manager orchestration and nested provider threads.

```text
[-] Running subagent: Timeline UI behavior consistency follow-ups (worker) [~]
  |
  [ ] User
      Audit discrepancies and implement high-confidence fixes.
  |
  [-] Exploring 2 files [~]
  | |
  | [+] Read packages/thread-view/src/timeline-view.ts
  | |
  | [+] Read packages/ui-core/src/thread-timeline/ThreadTimelineRows.tsx
  |
  [-] Running rg 1s [~]
  |   $ rg -n "Context compacting" packages/thread-view
  | |
  | [-] Editing packages/ui-core/src/thread-timeline/TimelineTitleView.tsx [~]
  |
  [ ] Assistant
      I found the content-only shimmer bug and am patching it.

[ ] Assistant
    Started parallel artifact worker thr_98...
```

Rules:

- Delegation expands into child timeline rows, not a freeform transcript first.
- Child timeline has its own rail inside the parent rail.
- Child row ids must be scoped to avoid colliding with parent turn ids.
- Manager update rows remain separate conversation/system rows in the manager
  thread, not nested inside every child thread row.

### Command Output Detail

```text
[-] Ran command 5s
    $ pnpm exec turbo run test --filter=@bb/thread-view
    turbo 2.8.3
    Packages in scope: @bb/thread-view
    Running test in 1 package
    ...
    exit code 0
```

Failure:

```text
[ ] Ran command 2s
    $ pnpm exec turbo run test --filter=@bb/thread-view
    FAIL packages/thread-view/test/timeline-view.test.ts
    Expected "Context compacted"
    exit 1
```

Rules:

- Keep the title style stable for failed commands; failure is not a new row kind.
- Exit code is always displayed for terminal command rows, including `exit 0`.
- In audit mode, truncate with an explicit notice.

### File Diff Detail

```text
[-] Edited packages/thread-view/src/operation-projection.ts +2 -2
    @@ -698,7 +698,7 @@
    - existing.title = "Context compacting..."
    + existing.title = "Compacting context"

[+] Edited packages/ui-core/src/thread-timeline/TimelineTitleView.tsx +6 -1

[ ] Created packages/ui-core/fixtures/thread-timeline-rows.ts +96 -0

[ ] Deleted packages/ui-core/stories/thread-timeline/old-fixtures.ts +0 -42
```

Rules:

- The file title is clickable in app when a diff surface is available.
- CLI shows full path by default.
- Created/deleted titles include diff stats too, not just edited titles.
- Diff is the detail. Do not append unrelated command stdout below it.

### Exploration And Generic Tool Fallback

Use S3/S4 read/list/search-heavy turns.

```text
[+] Explored 4 files, 2 lists, 1 search

[-] Ran tool: Glob
    pattern: **/schema*.ts
    result: 50 paths

[+] Ran tool: ToolSearch
```

Expanded completed exploration row:

```text
[-] Explored 4 files, 2 lists, 1 search
  |
  [ ] Read packages/db/src/schema.ts
  |
  [ ] Read apps/server/src/routes/threads/data.ts
  |
  [ ] Listed *.ts in packages/thread-view/src
  |
  [ ] Searched for timeline in packages/thread-view
```

Rules:

- Read duplicates of the same file can de-dupe in expanded detail.
- List operations stay countable, even with overlapping paths.
- Search labels use `Searched for <query> [in <path>]` and active labels use
  `Searching for <query> [in <path>]` in both App and CLI.
- Unknown tools still render via generic fallback, not raw JSON in the title.

### Web Search And Fetch

```text
[+] Ran 1 web search, fetched 2 web pages

[-] Running 1 web search, fetching 1 web page [~]
  |
  [~] Running web search: React Suspense docs
  |
  [~] Fetching: https://react.dev/reference/react/Suspense
```

Rules:

- Web is distinct from local read/list/search exploration.
- Search/fetch result payload text is not exposed in App or CLI. Rows show query
  or URL only unless a future explicit product decision adds a safe detail view.

### Pending Approval Interaction

No live pending interaction rows were present in the dev DB. This shape is from
the approval lifecycle contract and tests.

```text
[ ] User
    Run the deployment command.

[-] Waiting for approval on 1 command [~]
  |
  [~] Command (waiting for approval)
      $ git push origin main

[~] Waiting for approval
```

Resolving:

```text
[-] Delivering approval for Bash [~]
  |
  [~] Command (resolving)
      $ git push origin main
```

Denied:

```text
[x] Denied 1 command
  |
  [x] Command (denied)
      $ git push origin main
```

Rules:

- `pending` means waiting for a user or provider.
- `resolving` means the answer exists and is being delivered/reconciled.
- Banner/global copy and row title copy must use the same lifecycle vocabulary.
- Denied is terminal and should not use shimmer.

### Manager Assignment

Use S3/S5/S6 `system/operation` ownership rows.

```text
[ ] Thread assigned to manager
```

If richer metadata exists later:

```text
[-] Thread assigned to Manager
    Manager: Manager
    Previous: none
    Next: thr_bj...
```

Rules:

- Current DB rows contain `message="Thread assigned to manager"` and manager ids.
- Do not make the row expandable when detail repeats the title.
- If names/links are required, server metadata or a typed lookup must provide
  them at the right boundary.

### Manager Conversation Mode

Use S1 manager thread default view.

```text
[ ] User
    Make timeline shippability the primary objective.

[ ] Assistant
    Started long-lived worker thr_c2... for timeline UI behavior consistency.

[ ] Assistant
    Started parallel artifact worker thr_98... for ASCII layout review.
```

Manager standard/debug view can include hidden system/client rows:

```text
[ ] User
    Make timeline shippability the primary objective.

[+] Ran 8 commands

[ ] Assistant
    Started long-lived worker thr_c2...
```

Rules:

- Default manager conversation view filters to user messages and manager-visible
  assistant updates.
- Standard manager timeline is intentionally more verbose for debugging.
- App and CLI should expose the same view mode choice.

### Steers

Accepted steer inside an active thread:

```text
[ ] User
    Also check app-vs-CLI parity.
    Steer message

[-] Running pnpm test 3s [~]
    $ pnpm test --filter=@bb/thread-view
    test output stream...
```

Pending optimistic steer:

```text
[ ] User
    After that, commit the artifact.
    Steer requested
```

Rules:

- Pending steers are shared semantic conversation rows, not an app-only side channel.
- Pending steers sit at the active tail and should not be buried in a step
  summary or bundle summary. The pending label has shimmer.
- Accepted steers are conversation rows. Observed/current behavior can split
  completed turn groups; this remains an open question.
- Current CLI labels are `steer` / `steer pending`; agreed shared copy is
  `Steer message` / `Steer requested`.

### Context Compaction

Observed in S1/S2/S4/S5/S6.

Pending:

```text
[~] Compacting context
```

Completed:

```text
[ ] Context compacted
```

Failed:

```text
[!] Context compaction failed
    Provider did not return compacted context.
```

Interrupted:

```text
[x] Context compaction interrupted
```

Rules:

- Prefer `Compacting context` over `Context compacting...` for title grammar.
- Pending compaction uses shimmer even though system rows have no
  prefix segment.
- Completed compaction is static and usually non-expandable.

### Loading, Retry, Empty

Initial thread loading:

```text
[ ] Loading thread...
```

Lazy turn detail loading:

```text
[-] Worked for 4m 12s
  |
  [ ] Loading turn...
```

Retryable lazy load failure:

```text
[-] Worked for 4m 12s
  |
  [!] Could not load turn details. Retry.
```

Empty thread:

```text
[ ] No timeline activity yet.
```

Rules:

- Loading rows are client-local and should not look like durable agent work.
- Retryable load errors should not be grouped into step summaries or bundle
  summaries.
- Empty state appears only when there are no conversation, work, system, pending
  steer, or global activity rows.

## Grouping Rules By Concept

| Concept | Exists when | Default expansion | Notes |
| --- | --- | --- | --- |
| Turn summary | Turn is finished. | Collapsed when historical; expanded/lazy-loaded on demand. | Title is only `Worked for <duration>`. Contains assistant/work/assistant sequence. |
| Step summary | Assistant step has completed work and reaches an assistant-message boundary. | Collapsed and muted unless expanded, problem, or verbose. | Aggregates completed work types: `Explored...`, `Ran...`, `edited...`. |
| Bundle summary | Similar work belongs to the current unfinished assistant step. | Active form expands enough to expose the live child; completed-before-boundary form can collapse same-type completed leaves. | Active title: `Exploring...` or `Running...`; completed-before-boundary title: `Explored...`. Never `Worked for` or `Working on`. |
| Single active work leaf | One current work row exists. | Auto-expanded if detail explains live state. | Show the leaf directly instead of wrapping it. |
| Single terminal work row | One completed work row exists, any terminal status (success, error, denied, interrupted). | Muted direct leaf. Status suffix `(error)`, `(denied)`, `(interrupted)` appended to title for non-success. | One rule for all terminal statuses; no summary wrapper around a single child. |
| Completed bundle summary before step boundary | Same-type work has completed but no new assistant message has closed the step. | Muted/collapsed; no shimmer. | Still a bundle summary, not the all-type step summary. Exact implementation support needs audit. |
| Failed or interrupted child | Child failed or was interrupted. | Show the problem even inside step summaries or bundle summaries. | Problem detail must not disappear behind muted completed treatment. |
| Approval work row | Waiting/resolving user interaction exists. | Auto-expanded while actionable. | Approval is actionable, not low-value work noise. |
| Delegation/subagent | Parent row owns child thread/timeline. | Expanded while active; collapsed when historical. | Child timeline appears inside delegation with its own rail. |
| Steer row | Accepted or pending steer message exists. | Visible conversation row. | Pending steer is a shared semantic tail row, not an App-only side channel. |
| System operation | Compaction, manager assignment, or similar operation. | Non-expandable unless detail adds value. | Not grouped into step summaries or bundle summaries. |
| Active-tail expansion | Any active expandable leaf or bundle summary exists. | Target latest expandable active work. | Target the latest expandable work, not the literal final row. |

## App Vs CLI Notes

| Area | Shared model/policy | App visible treatment | CLI text/rendering | Notes |
| --- | --- | --- | --- | --- |
| Row concepts | Same row kinds, status vocabulary, and grouping boundaries. | Icons, affordances, hover/focus, color, shimmer, and emphasis carry much of the meaning. | Labels, suffixes, separators, and indentation carry the meaning. | Visible copy aligns only when the surfaces intentionally show the same string. |
| Conversation messages | Same semantic row kinds and ordering. | Content-first; no literal `User` / `Assistant` title. Copy and steer affordances live with the row. | Can print speaker labels in transcript/debug modes. | This is the main App/CLI divergence. |
| Turn summary | Finished-turn lazy detail contract. | Historical row `Worked for <duration>`; static, collapsed when old. | Same text with nested detail in verbose/expanded mode. | Not used for active work. |
| Step summary | Completed work at assistant boundary. | Muted row; lower visual priority than active work. | Example: `Explored 2 files, 1 list, edited 1 file`; collapsed by default unless verbose/problem. | Not the same as turn summary. |
| Bundle summary | Same-type grouping inside an unfinished assistant step. | Active form uses shimmer and keeps live child visible; completed-before-boundary form is muted/collapsed. | Active title such as `Exploring 2 files`; completed-before-boundary title such as `Explored 2 files`. | Not `Working on N items` or a turn summary. |
| Expansion defaults | Same policy for active tail, pending, error, and lazy turns. | Persist manual expansion; auto-expand active/actionable rows. | Minimal vs verbose/audit modes control detail volume. | Active tail targets latest expandable active leaf or bundle summary. |
| Nesting | Same parent-child model and order. | Rail and pixel indentation; no nested cards. | Two-space indentation and `|` rail in ASCII/debug. | Child timeline ids are scoped. |
| Command/file details | Same ordering: title, command or path, detail, exit/diff. | Can clamp or virtualize output; object emphasis should be consistent. | Truncate with explicit notices in audit mode. | Exact emphasis tokens need design audit. |
| File links | Same canonical path in the title. | Path can be clickable to open diff. | Prints path text. | App link behavior requires available diff surface. |
| Web result text | Suppress web search/fetch result payload text. | Show query or URL only. | Show query or URL only. | Future detail view needs separate security/product decision. |
| Pending interactions | Same lifecycle words: waiting, resolving, denied, expired. | Can also show banner and composer disabled state. | Prints timeline/status text. | Row and global vocabulary should match. |
| Global activity | Same state source. | Tail indicator adjacent to timeline content. | Usually omitted if active rows already show running state. | Keep distinct from durable work rows. |
| Loading/retry | Client loading is not durable work. | Skeleton/spinner and retry affordance; no work shimmer. | Usually omitted unless interactive. | Loading rows are not grouped into step summaries or bundle summaries. |

## Open Questions

1. Should accepted steers continue to split finished-turn grouping as visible
   conversation rows?
2. Should manager assignment rows include manager names, links, avatars, or only
   non-expandable status text?
3. Should command and file approval interactions emit explicit `resolving`
   timeline rows, or should resolving remain banner/global-only?
4. Should nested subagent timelines always be expandable inside the delegation
   row, or should historical child timelines collapse to a one-line child turn
   summary first?
5. Should CLI minimal mode print active global `Working...`, or rely entirely on
   row-level active titles?
6. Should context compaction wording change globally to `Compacting context` /
   `Context compacted`, and should all ongoing system rows animate the full
   title?
8. Should web search/fetch stay grouped with local exploration when adjacent, or
   always remain separate grouping concepts?
9. What is the maximum app detail height for command output before clamping or
    virtualization is required?

## Exit Criteria For A Shippable Layout Policy

- Every row concept in the visible-copy matrices has one title/treatment rule
  and one detail rule.
- `pending`, `resolving`, `active`, `loading`, `error`, `interrupted`, and
  `completed` have distinct visual treatment.
- Active-tail wording and default expansion are driven by the same predicate.
- Nested timelines use rails and indentation, not nested cards.
- Manager assignment and compaction rows do not become expandable unless detail
  adds information beyond the title.
- App and CLI consume the same row concepts and grouping boundaries.
- Representative scenarios S1-S7 can be sketched without inventing a new row
  shape.
- Open questions above are answered or explicitly deferred before product
  code changes.

## Validation For This Artifact

Lightweight validation only:

```sh
git diff --check -- plans/timeline-layout-ascii-spec.md
rg --pcre2 "[^\\x00-\\x7F]" plans/timeline-layout-ascii-spec.md
```

No broad test suite is required because this file is a planning artifact and
does not change product code.
