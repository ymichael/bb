---
kind: instruction
title: bb Guide — Threads
summary: Command reference for thread spawning, inspecting, messaging, and lifecycle.
intent: Provide complete thread command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation. Run the json-flag-enforcement and command-output tests after changes.
---
Thread commands

Every command supports --json for machine-readable output.

Spawning:

  bb thread spawn --project <id> --prompt "..." [options]

    --prompt <prompt>              Initial prompt (required)
    --title <title>                Thread title
    --project <id>                 Project (required)
    --parent-thread <id>           Parent thread (may be in another project)
    --parent-self                  Parent to the current thread (BB_THREAD_ID)
    --provider <id>                Provider override
    --model <model>                Model override
    --reasoning-level <level>      Reasoning level: low, medium, high, xhigh, max (provider-dependent)
    --environment <id-or-path>     Attach to an existing environment (ID or workspace path)
    --new-environment <kind>       Create a fresh personal workspace or managed worktree
    --base-branch <branch>         Exact Git ref for a new managed worktree
    --machine <id-or-name>         Run on a machine (--host is an alias)
    --service-tier <tier>          Service tier: fast, default
    --permission-mode <mode>       Permission mode: accept-edits, auto, or full
    --plan                         Send the prompt as the provider's /plan action (plan first, execute after approval)
    --section <id>                 Create the thread in a section
    --visibility <visibility>      visible or hidden; a child inherits its parent by default
    --send-at <when>               Dispatch the first message at an ISO 8601 timestamp or a duration from now (30s, 10m, 2h, 7d)
    --file <path>                  Host-readable absolute or uploaded file path
    --image <path>                 Host-readable absolute or uploaded image path
    --origin-kind <kind>           Create a fork thread
    --source-thread <id>           Source thread for a fork
    --source-seq-end <seq>         Fork after the source turn containing this event sequence

  Execution defaults resolve from explicit flags, live parent execution, and
  remembered project defaults. With no remembered model, bb uses the explicitly
  requested provider or Codex and resolves its provider-reported default model
  on the target machine. The product reasoning and permission defaults are
  medium and auto.
  accept-edits uses workspace sandboxing with user-reviewed escalation. auto uses
  the same workspace sandbox with provider-native automatic review. full is the
  explicit sandbox and approval bypass. Plan mode is separate from permissions.
  Subagents inherit the parent's permission mode by default, and the parent's mode is a hard ceiling: a child's requested mode can lower it but never exceed it, so a sandboxed parent cannot spawn a full-access child.
  Parenting is opt-in. Inside a thread, pass --parent-self to parent the new thread to the current thread.
  Hidden threads are for plugin/background workers. They remain addressable by
  ID while staying out of sidebar organization and unread/pending favicon
  attention. Thread lists exclude them unless
  --include-hidden is passed; direct-ID operations remain available.
  A new child thread inherits the visibility of its parent, so the subagents of
  a hidden thread stay hidden too. Pass --visibility to override the inherited
  value. A hidden child still reports its turns and blockers to its parent
  thread; only source-derived forks stay silent.
  A machine selector accepts an exact ID or an unambiguous name. It works with
  an unmanaged --environment path, --new-environment worktree, or the personal
  workspace. It cannot be combined with an existing environment ID because that
  environment already selects its machine. Without the flag, local/primary
  machine resolution is unchanged.
  Omit --base-branch for bb's default. Explicit values are exact; use
  origin/<branch> for a remote ref.

Forking:

  bb thread fork <source-thread-id> [options]

    --prompt <prompt>              Optional first prompt; omit for an idle fork
    --source-seq-end <seq>         Fork after the source turn containing this event sequence (tip by default)
    --environment <id-or-path>     Existing environment ID or unmanaged workspace path
    --new-environment <kind>       Create a fresh personal workspace or managed worktree
    --base-branch <branch>         Exact Git ref for a new worktree; omit for the project default
    --title <title>                Thread title
    --permission-mode <mode>       Inherit source by default; accepts accept-edits, auto, full
    --visibility <visibility>      visible (default) or hidden
    --agent-context-seed <text>    Persist agent-only context without a first run
    --file <path>                  Host-readable absolute or uploaded file path
    --image <path>                 Host-readable absolute or uploaded image path

  Forks clone the source provider session on the same machine and inherit the
  source conversation in their timeline. --source-seq-end anchors the fork on
  the completed source turn that contains that sequence: the clone and the
  inherited timeline both end with that turn (an anchor on a user message
  branches before it, like editing it). Without it a fork clones the session
  tip and inherits every completed turn. Providers that can only clone a whole
  session accept an anchor only on the source's latest turn. A fork reuses the
  source environment by default. Use --new-environment personal for a fresh
  personal workspace or --new-environment worktree for a fresh worktree on the
  source machine; --environment can select another environment or unmanaged
  path on that machine. A different machine is rejected because the source
  provider session lives on its original machine. Omit --prompt to create an
  idle fork.

Editing a sent message (requires the default-on `editMessages` experiment):

  bb thread edit-message <id> --message "Replacement text"
    --self                              Target the current thread (BB_THREAD_ID)
    --expected-request-sequence <seq>   Select the message and reject a stale target

  Without --expected-request-sequence, the latest eligible message is edited.
  Codex, Claude Code, and Pi threads are supported. The original conversation
  remains unchanged until the provider prepares the replacement history.
  Failed and incomplete turns are eligible. If the thread is running,
  submission stops the current turn and waits for it to settle. It then
  replaces the selected turn and every later turn while retaining workspace
  changes. From an agent thread, the command carries `BB_THREAD_ID` so the
  replacement runs under agent permission policy.

Listing:

  bb thread list                           List threads
    --project <id>                         Filter by project
    --parent-thread <id>                   Filter by parent thread
    --archived                             Show only archived threads
    --section <id>                         Filter by section
    --unsectioned                          Show only threads outside sections
    --include-hidden                       Include hidden threads

  The table prints ID, Title, Project, and Status. Title uses the thread
  title, then the fallback title from the first prompt, then "-". Long
  titles are cut at 60 characters. Project shows the project name; the
  personal project shows "-". Use --json for the full thread records.

  bb thread search <query> [--limit <1-50>]
                                             Search threads and messages
  bb thread history <id>                   List prompt history

  bb thread count                          Count threads without listing them
    --status <status>                      Count threads in this status: pending, idle, starting, active, stopping, error
    --host <id>                            Count threads whose environment is on this machine
    --provider <id>                        Count threads running on this provider
    --project <id>                         Count threads in this project
    --parent <id|none>                     Count one thread's children, or 'none' for threads with no parent
    --by <dimension>                       Group the count by host, provider, or project

  Counting happens in the database, so use it instead of listing threads and
  counting rows: `bb thread list` pages a bounded window and would miscount.
  Archived, deleted, and hidden threads are excluded. Without --by the command
  prints one number; with --by it prints a count per group (threads with no
  host/provider/project group under "-") followed by the total.

Sections:

  bb thread section list
  bb thread section create <name>
  bb thread section rename <id> <name>
  bb thread section delete <id> [--yes]

Inspecting:

  bb thread show [id]                      Show thread details and pull request status
    --self                                 Target current thread
    --work-status                          Include git working-tree status
    --git-diff                             Include git diff
    --diff-target <type>                   Diff scope: uncommitted, branch_committed, all, commit
    --diff-sha <sha>                       Commit SHA (for --diff-target commit)
    --diff-merge-base <branch>             Override merge-base branch for diff

  Shows pull request status for the attached environment branch when available.

  bb thread log [id]                       Show thread event log
    --self                                 Target current thread
    --format <format>                      Output format: json, minimal, verbose
    --limit <count>                        Max entries: events for json (oldest first, default 100);
                                           user-message turns for minimal/verbose (newest first, default 20, max 100)
    --after-seq <seq>                      Paginate after sequence number (json only)
    --all                                  Print the whole thread, paging through every entry

  Human formats end with a notice when older history was omitted; --json warns
  on stderr when more events exist beyond the printed page.

  bb thread output [id]                    Get the final output of a thread
    --self                                 Target current thread

  bb thread wait <id>                      Wait for a thread status or event (defaults to --status idle)
    --status <status>                      Wait for this status
    --event <type>                         Wait for this event type
    --timeout <seconds>                    Timeout in seconds (default: 1200 / 20 min)
    --poll-interval <ms>                   Polling interval in milliseconds

Opening threads and files in the app:

  bb thread open <path>                    Open a file in the current BB thread panel
  bb thread open <thread-id> [path]        Open a thread, optionally with a panel file
    --line <number>                        Line number to focus
    --split <placement>                    right, down, left, top, or replace
  bb thread pane <action> [thread-id]      Maximize, restore, toggle, spotlight, or clear spotlight

  Inside a BB thread, BB_THREAD_ID selects the current thread automatically and
  the thread ID argument is omitted for file-only opens. Pass an explicit thread
  ID with --split to open another thread. Outside a BB thread, pass the thread ID
  as the first argument. A thread already open in a pane is focused instead of
  duplicated. Edge placement creates panes through the eighth pane; at eight
  panes, it replaces the focused pane.
  Pane actions broadcast to connected BB app windows and affect the matching
  already-open pane without changing its split tree. Spotlight focuses that
  pane and dims the others; clear-spotlight focuses it and removes split dimming.
  Paths can be thread-relative workspace paths, or absolute paths inside the
  target thread workspace. Absolute paths under BB_THREAD_STORAGE open as
  thread-storage files for the current thread. Use this for Markdown or HTML
  artifacts you create for the user so they open in the BB IDE.

Messaging:

  bb thread tell <id> <message>            Send a follow-up message
    --mode <mode>                          Message mode: steer (default), queue, or auto
    --model <model>                        Model override for this turn
    --reasoning-level <level>              Reasoning level override
    --plan                                 Send the message as the provider's /plan action
    --send-at <when>                       Dispatch at an ISO 8601 timestamp or a duration from now (30s, 10m, 2h, 7d)
    --file <path>                          Host-readable absolute or uploaded file path
    --image <path>                         Host-readable absolute or uploaded image path

  Tell steers by default, delivering the message immediately into the active
  turn. Use --mode queue for non-urgent follow-ups that can wait until the agent
  is free; --mode auto steers a live turn and starts a new one on an idle
  thread. Input sent while a turn is starting stays in the queue with
  `waitingOn: turn-starting`; `turn/started` wakes it and steers it into that
  turn. A target that is awaiting user interaction (an open question or
  approval) cannot take a prompt; tell then adds the message to the thread's
  queue and dispatches it once the interaction settles. That outcome is not a
  failure, so do not resend. `--json` reports `delivery` as `sent` or `queued`,
  and a queued answer carries the complete row as `queuedMessage`, including
  its `id`, `waitingOn`, and `sendAt`. A deferred message waits for a thread
  that failed while it was deferred, and delivers when the thread is retried.

  --plan sends the same structured /plan command the composer's plan action
  sends, so the agent proposes a plan for approval before executing (Claude
  Code and Codex threads). Plain "/plan ..." text is not recognized; it reaches
  the provider as literal text. Approve or deny the proposed plan with
  `bb thread interactions`; `bb thread cancel-plan` leaves Plan mode early.
  SDK callers build the same input with
  `createBuiltinPlanCommandTextInput(text)` from `@bb/sdk` and pass it as
  `input` to `threads.spawn` or `threads.send`.

  bb thread stop [id]                      Stop work and release the agent runtime
  bb thread compact [id]                   Request compaction of an idle or errored thread's context
  bb thread clear [id]                     Clear model context for an idle or failed thread
  bb thread cancel-plan [id]               Exit the provider's active Plan mode
  bb thread clear-goal [id]                Clear the provider's active Goal
    --self                                 Target current thread

  `thread compact` enqueues the same structured /compact turn used by the
  composer. Follow the thread timeline for the eventual compaction result.
  `thread clear` keeps the BB thread, workspace, durable event history, and
  sticky execution settings. Its active timeline starts at one visible
  `Context cleared` boundary, and its next prompt starts a fresh provider
  conversation in the same thread.

Ownership:

  bb thread update [id]                    Update thread metadata
    --self                                 Target current thread
    --title <title>                        Set title
    --parent-thread <id>                   Assign to a parent thread
    --clear-parent-thread                  Remove parent assignment
    --section <id>                         Move into a section
    --clear-section                        Remove section assignment
    --model <model>                        Set the sticky model for the next and later turns
    --reasoning-level <level>              Set the sticky reasoning level (provider-dependent)
    --visibility <visibility>              Set visible or hidden

  Model and reasoning updates stay within the thread's current provider. BB
  validates them against that provider's current model catalog, applies them on
  the next turn, and keeps using them on later turns until changed.

  bb thread read [id]                      Mark read
  bb thread unread [id]                    Mark unread
  bb thread reorder-pinned <id> [--after <id>] [--before <id>]

Interactions:

  bb thread interactions list [id]         List a thread's pending and past interactions
  bb thread interactions show <interaction-id> [id]
                                           Show one interaction (approval details, questions, or a plugin form's data)
  bb thread interactions approve <interaction-id> [id]
                                           Allow a command, file-change, plan, or tool-use approval
  bb thread interactions deny <interaction-id> [id]
                                           Deny an approval
  bb thread interactions grant <interaction-id> [id] --scope turn|session
                                           Grant a permission interaction
  bb thread interactions answer <interaction-id> [id] --choice <questionId=value> --text <questionId=text>
                                           Answer a provider's user question
  bb thread interactions respond <interaction-id> [id] --value '<json>'
                                           Answer a plugin form: a plugin's own request, or a request the agent raised through a provider (kind `<pluginId>/<name>`)
    --self                                 Target current thread (every subcommand)
    --json                                 Machine-readable output (every subcommand)

  `show` prints a plugin form's `Data` so you can shape the `--value` JSON.
  A provider's plugin-defined request cannot be cancelled; stop the thread to
  back out of it.

Queued messages:

  bb thread queue list [<thread-id>] [--wait-holder plugin:<plugin-id>]
  bb thread queue create <thread-id> <message>
  bb thread queue update <thread-id> <message-id> <message> [--file <path>] [--image <path>]
  bb thread queue send <thread-id> <message-id> [--mode auto|steer]
  bb thread queue reorder <thread-id> <message-id> [--after <id>] [--before <id>]
  bb thread queue group <thread-id> <boundary-id> --prefix <comma-separated-ids>
  bb thread queue delete <thread-id> <message-id>

  A queued message is one that could not dispatch yet. Every one carries a
  typed reason in its `Waiting on` column: waiting for the current turn to
  finish, for the workspace, for a pending interaction, for a clock (`Send at`),
  or for a plugin that has queued it. `queue list` with no thread id lists every
  queued row in the workspace; `--wait-holder plugin:<plugin-id>` narrows it to
  the rows one plugin is holding.

  `queue send` dispatches a row now, bypassing every plugin wait and its own
  schedule — the invariants (a running turn, an unfinished workspace, an
  unanswered interaction) still apply, and a message that hits one simply queues
  again. `--mode steer` uses those same send-now bypasses and re-attempts the row
  as a steer; it does not bypass the invariants, so a provisioning row remains
  queued until the workspace is ready.
  `queue delete` discards it instead. Both are always permitted.

  --send-at takes an ISO 8601 timestamp (2026-08-25T09:00, local without an
  offset) or a duration from now (30s, 10m, 2h, 7d). A time that has already
  passed is rejected, as is a bare date, which has no time of day. Several
  queued rows on one thread are normal: two scheduled sends coexist.

Persisted panel tabs:

  bb thread tabs show <thread-id>
  bb thread tabs set <thread-id> --expected-revision <n> --tabs-json '<json>'

Lifecycle:

  bb thread retry [id]                     Retry the thread's failed turn
    --self                                 Target current thread
    --turn <requestId>                     Retry this turn request id specifically; fails when it is not the thread's failed turn
    --send-at <when>                       Dispatch at an ISO 8601 timestamp or a duration from now (30s, 10m, 2h, 7d)
    --reason <text>                        Why it is being retried, shown on the queued row

  Retry re-submits the failed turn by reference: no duplicated user message in
  the timeline, and an attempt number that increments (2 is the first retry).
  What the provider is sent follows its own acceptance record — an input it
  never accepted is re-sent verbatim, while an accepted turn (already in the
  provider's conversation) is continued with a nudge rather than asked twice.
  With no --turn it retries the most recent turn, the
  one whose failure put the thread in error; --turn asserts which turn you mean
  and fails when the thread has moved on, as does retrying a thread that has not
  failed or a turn that already has a retry queued. Without --send-at the retry
  is attempted now, and may still queue behind a busy thread or a plugin.

  bb thread archive [id]                   Archive a thread (and children/hidden forks)
    --self                                 Archive current thread

  `thread stop` preserves the thread history, metadata, environment, and future
  resume behavior. It stops active work and releases an idle agent runtime.
  The command succeeds when no runtime is loaded. Archive a finished hidden
  worker first, then stop it to release memory promptly. A stop that only
  releases an idle runtime adds no interruption: it leaves the timeline and any
  pending interaction of that thread untouched.

  bb thread unarchive [id]                 Unarchive a thread
    --self                                 Unarchive current thread

  bb thread delete <id>                    Delete permanently
    --yes                                  Skip confirmation

Read-only commands require a thread ID or --self where supported.
Mutating thread lifecycle and messaging commands require an explicit ID or --self.
