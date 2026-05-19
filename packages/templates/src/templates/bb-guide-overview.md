---
kind: instruction
title: bb Guide Overview
summary: System overview and chapter index for the bb CLI guide.
intent: Orient agents to bb core concepts and help them find the right guide chapter.
editingNotes: Keep this concise. Concepts only — command details belong in chapter files.
---
bb is an agent orchestration tool for managing multiple agents.

Core concepts:

- Project — maps to a repository. All threads belong to a project.
- Thread — a single agent conversation. The fundamental unit of work.
- Environment — where a thread runs. Kinds: project checkout or isolated worktree. Multiple threads can share an environment.
- Provider — the agent backend powering a thread (e.g., codex, claude-code). Each provider supports different models.
- Host — where environments run. Hosts are long-lived local or remote machines.

Thread types:

- standard — does coding, research, debugging, or other tasks.
- manager — coordinates work across other threads. Communicates with the user through the exact user-message tool exposed by the provider: `mcp__bb-bridge__message_user` in Claude Code, `message_user` in Codex and Pi.

Threads can have a parent-child relationship. The parent manages the child and receives lifecycle notifications when it completes, fails, or is interrupted. Threads without a parent are managed by the user.

Context variables set automatically inside a thread environment:

- BB_PROJECT_ID — current project
- BB_THREAD_ID — current thread
- BB_ENVIRONMENT_ID — current environment

Run `bb status` to see your current context (resolved project and thread IDs).

All commands support --json for machine-readable output.

Run `bb guide <chapter>` for command details:

  threads        Spawning, inspecting, messaging, and managing threads
  environments   Environment operations, commits, and merges
  managers       Hiring and managing project managers
  providers      Discovering providers and models
  projects       Project CRUD and sources
  hosts          Listing and understanding hosts
  styling        How to style STATUS.html to match the bb UI
  async          Defining scheduled nudges with ASYNC.md
