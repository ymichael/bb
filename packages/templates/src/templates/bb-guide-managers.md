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
    --project <id>                        Project ID
    --name <name>                         Manager name
    --provider <id>                       Provider override
    --model <model>                       Model override
    --reasoning-level <level>             Reasoning level
    --host <id>                           Target host

  bb manager list [projectId]             List managers for a project
  bb manager status <id>                  Show manager status and managed threads
  bb manager delete <id>                  Delete a manager permanently

Common manager interactions via thread commands:

  bb thread list --parent-thread <manager-id>    List managed threads
  bb thread tell <manager-id> "message"          Message a manager
  bb thread log <manager-id>                     Show manager log
