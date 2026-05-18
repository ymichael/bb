---
kind: instruction
title: bb Guide — Managers
summary: Command reference for hiring and managing project managers.
intent: Provide complete manager command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Manager commands

Managers are long-running threads that coordinate work across other threads.
Use bb thread commands for most manager interactions.

  bb manager hire [projectId]             Hire a new manager
    --project <id>                        Project ID (defaults to BB_PROJECT_ID)
    --name <name>                         Manager name
    --provider <id>                       Provider override
    --model <model>                       Model override
    --reasoning-level <level>             Reasoning level: low, medium, high, xhigh, max (provider-dependent)
    --permission-mode <mode>              Permission mode: full, workspace-write, or readonly
    --host <id>                           Target host (defaults to local host)
    --json                                Print machine-readable JSON output

  When --provider and --model are omitted, the project's remembered manager defaults apply first.
  If there are no remembered manager defaults, the server manager policy is used.

  bb manager list [projectId]             List managers for a project
    --project <id>                        Project ID (defaults to BB_PROJECT_ID)
    --json                                Print machine-readable JSON output

  bb manager status <id>                  Show manager status and managed threads
    --json                                Print machine-readable JSON output

  bb manager delete <id>                  Delete a manager permanently
    --yes                                 Skip the confirmation prompt
    --json                                Print machine-readable JSON output

Common manager interactions via thread commands:

  bb thread list --parent-thread <manager-id>    List managed threads
  bb thread tell <manager-id> "message"          Message a manager
  bb thread log <manager-id>                     Show manager log

Manager thread logs use the conversation view by default. `--format verbose`
expands returned timeline details but does not switch to the internal manager
debug timeline.
