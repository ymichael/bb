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
- Machine — an execution host where project sources and thread environments live.
- Terminal — a persistent PTY session scoped to a thread, environment, or machine path. Use terminals for long-running commands such as dev servers.
- Provider — the agent backend powering a thread (e.g., codex, claude-code). Each provider supports different models.

Threads can have a parent-child relationship. The parent coordinates the child and receives lifecycle notifications when it completes, fails, or is interrupted. Threads without a parent are managed directly by the user.

Context variables set automatically inside a thread environment:

- BB_PROJECT_ID — current project
- BB_THREAD_ID — current thread
- BB_ENVIRONMENT_ID — current environment
- BB_CLI — absolute path to the daemon-managed `bb` executable (prefer this if bare `bb` is wrong; official entrypoints also re-exec to it)

Run `bb status` to see your current context (resolved project and thread IDs).
It also warns when an enabled plugin is not running (incompatible after a bb
upgrade, failed to load, or missing); run `bb plugin list` for the detail.

All commands support --json for machine-readable output.

To make a repo work with bb worktrees, run `bb guide environments` for the
repo-level `.bb-env-setup.sh` and `.bb-env-teardown.sh` hooks. Run `bb guide
agent-configuration` for the data-dir and workspace files that customize agent
behavior.

Run `bb guide <chapter>` for command details:

  threads              Spawning, inspecting, messaging, and managing threads
  environments         Environment lifecycle hooks, operations, commits, and merges
  agent-configuration  AGENTS.md and skills files that shape agents
  providers            Discovering providers and models
  projects             Project CRUD and sources
  machines             Listing and targeting execution machines
  terminals            Persistent PTY sessions across all supported scopes
  browser              Experimental built-in browser tabs and control leases
  customization        Theming the app palette, settings, mobile push
                       notifications
  plugins              Installing plugins, plugin marketplaces, and their
                       contributed bb commands
  automations          Scheduling and editing recurring or one-shot work
