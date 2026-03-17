---
kind: instruction
title: bb System Overview
summary: Core concepts and mental model for the bb system.
intent: Give any agent a grounded understanding of what bb is, how its primitives relate, and how work flows through the system.
editingNotes: Keep this concept-oriented, not command-oriented. The CLI guide covers commands. This should teach the mental model so an agent can interpret user requests correctly.
---

`bb` is an agent orchestration tool for managing multiple agents.

Core concepts:

- **Project**: A project maps to a code repository. All threads belong to a project.
- **Thread**: A thread is a single agent conversation. Threads are the fundamental unit of work in bb.
- **Environment**: Each thread is attached to an environment that determines where it runs. Environments are first-class entities — multiple threads can share the same environment. For example, a coding thread and a review thread can both attach to the same worktree. Environment kinds include `local` (project root), `worktree` (isolated git worktree), and `docker` (sandboxed container).
- **Agent Provider**: Each thread is powered by an agent provider (e.g., `codex`, `claude-code`). Different agent providers support different models (e.g., opus, gpt-5).

There are 2 types of threads:

- `standard` — a regular agent thread that does coding, research, debugging, or other tasks.
- `manager` — a long-running thread that coordinates work across other threads.

Manager threads:

- Use the `bb` CLI to spawn, inspect, and manage other threads.
- Communicate with the user exclusively via the `message_user` tool.
- Get their own durable workspace: a directory under the bb data root for storing preferences, notes, memories, and other deliverables. The workspace lives outside the repo.

Thread management and handoff:

- Threads can have a parent-child relationship. The parent "manages" the child.
- When a child thread completes, the system notifies the parent via a system message.
- Parent-child relationships are transferable: the user can assign a thread to a manager or take over an existing child thread.
- Threads without a parent are implicitly managed by the user.

Thread lifecycle:

- Threads are spawned, run, and become idle when waiting for input.
- A typical thread involves several back-and-forth exchanges across multiple turns.
- Unarchived threads represent active work that needs attention. Threads are archived when they are no longer needed, or deleted permanently.

Communication:

- Users talk to threads and managers by sending messages. Users typically only interact directly with threads that have no parent — managed threads are the manager's responsibility.
- Managers talk to users exclusively through the `message_user` tool.
- Messages prefixed with `[bb system]` are internal context (thread assignments, completions, etc.), not direct user requests.

Built-in actions:

bb provides a few convenient shortcuts for common operations. These are not critical to using bb but are useful in practice: `commit` (agent-driven git commit), `squash-merge` (agent-driven squash merge into a target branch), and `promote` / `demote` (move a thread's worktree into the primary checkout for testing, or reverse it).
