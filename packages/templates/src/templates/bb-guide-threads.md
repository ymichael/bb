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

  bb thread spawn --prompt "..." [options]

    --prompt <prompt>              Initial prompt (required)
    --title <title>                Thread title
    --project <id>                 Project (defaults to BB_PROJECT_ID)
    --parent-thread <id>           Parent thread (defaults to BB_THREAD_ID)
    --provider <id>                Provider override
    --model <model>                Model override
    --reasoning-level <level>      Reasoning level: low, medium, high, xhigh
    --environment <id-or-path>     Attach to an existing environment (UUID or workspace path)
    --new-environment <kind>       Create a new environment (worktree, sandbox/e2b)
    --service-tier <tier>          Service tier: fast, default
    --sandbox-mode <mode>          Sandbox mode: read-only, workspace-write, danger-full-access
    --host <id>                    Host ID (defaults to local host)
    --no-context-parent-thread     Do not default parent thread to BB_THREAD_ID

  When --provider and --model are omitted, the project's remembered defaults apply.
  When --parent-thread is omitted inside a thread, BB_THREAD_ID is used automatically.

Listing:

  bb thread list                           List threads
    --project <id>                         Filter by project (defaults to BB_PROJECT_ID)
    --parent-thread <id>                   Filter by parent/manager
    --archived                             Show only archived threads

Inspecting:

  bb thread show [id]                      Show thread details (defaults to BB_THREAD_ID)
    --self                                 Target current thread
    --work-status                          Include git working-tree status
    --git-diff                             Include git diff
    --diff-target <type>                   Diff scope: uncommitted, branch_committed, all, commit
    --diff-sha <sha>                       Commit SHA (for --diff-target commit)
    --diff-merge-base <branch>             Override merge-base branch for diff
    --merge-base-branches                  List available merge-base branches

  bb thread log [id]                       Show thread event log
    --self                                 Target current thread
    --format <format>                      Output format: json, minimal, verbose
    --limit <count>                        Limit entries
    --after-seq <seq>                      Paginate after sequence number

  bb thread output <id>                    Get the final output of a thread

  bb thread wait [id]                      Wait for a thread status or event
    --status <status>                      Wait for this status
    --event <type>                         Wait for this event type
    --timeout <seconds>                    Timeout
    --poll-interval <ms>                   Polling interval in milliseconds

Messaging:

  bb thread tell <id> <message>            Send a follow-up message
    --mode <mode>                          Message mode (e.g., steer)
    --model <model>                        Model override for this turn
    --reasoning-level <level>              Reasoning level override

  bb thread stop [id]                      Stop an active thread
    --self                                 Stop current thread

Ownership:

  bb thread update [id]                    Update thread metadata
    --self                                 Target current thread
    --title <title>                        Set title
    --parent-thread <id>                   Assign to a parent/manager
    --clear-parent-thread                  Remove parent assignment

Lifecycle:

  bb thread archive [id]                   Archive a thread
    --self                                 Archive current thread
    --force                                Force archive

  bb thread unarchive [id]                 Unarchive a thread
    --self                                 Unarchive current thread

  bb thread delete <id>                    Delete permanently
    --yes                                  Skip confirmation

Read-only commands infer the thread from BB_THREAD_ID.
Mutating commands require an explicit ID or --self.
