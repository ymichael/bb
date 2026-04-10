---
kind: instruction
title: bb Guide — Hosts
summary: Command reference for listing and understanding hosts.
intent: Provide complete host command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Host commands

Hosts are where environments run.

- Persistent hosts are long-lived machines (your laptop, a remote server).
- Ephemeral hosts are cloud sandboxes provisioned on demand (e.g., E2B).

Ephemeral hosts are created automatically when a thread spawns with a cloud
environment. They suspend on idle and are destroyed when no longer needed.

  bb host list                            List persistent hosts with status

Host status values: connected, disconnected, suspended.
