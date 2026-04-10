---
kind: instruction
title: bb Guide — Environments
summary: Command reference for environment inspection, commits, merges, and promote/demote.
intent: Provide complete environment command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Environment commands

Environments determine where threads run. Multiple threads can share an environment
(e.g., a coding thread and a review thread in the same worktree).

  bb environment show <id>                Show environment details (path, branch, status)

  bb environment update <id>              Update environment metadata
    --merge-base-branch <branch>          Set merge-base branch override
    --clear-merge-base-branch             Clear merge-base override

  bb environment commit <id>              Create a commit in the environment

  bb environment squash-merge <id>        Squash-merge into a target branch
    --merge-base-branch <branch>          Target branch (required)

  bb environment promote <id>             Move environment into the primary checkout
  bb environment demote <id>              Move environment out of the primary checkout
