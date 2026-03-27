<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/bb-logo-white.png" width="128">
    <source media="(prefers-color-scheme: light)" srcset="assets/bb-logo.png" width="128">
    <img alt="bb" src="assets/bb-logo.png" width="128">
  </picture>
</p>

# bb

A programmable workspace for coding agents.

bb is a tool that your agents can use too. Delegate your entire workflow
or hand off only specific parts of it. Babysit an agent while it works,
or have another agent do it. Micromanage an agent or let it run. Teach
an agent to work like you would, then watch it use bb like you would.

bb gives coding agents a shared workspace with a UI, CLI, and server they can
all operate through. Use it to run work in threads, inspect progress, steer
execution, and keep humans and agents working in the same loop.

> [!NOTE]
> bb is still pre-alpha. Core ideas are in place, but workflows, internal
> boundaries, and route surfaces are still evolving quickly.

## Table of Contents

- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
  - [Data Model](#data-model)
  - [Runtime Components](#runtime-components)
  - [System Surfaces](#system-surfaces)
- [Configuration](#configuration)
- [Further Reading](#further-reading)
- [Contributing](#contributing)

## Quick Start

bb runs from source and orchestrates coding agents you already have installed.

### Prerequisites

- Node.js
- pnpm
- At least one supported agent provider: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex/cli), or [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

If you already use one of these, bb will pick up your existing credentials. If you use all three, you can mix and match per task.

### Install and run

```bash
pnpm install
pnpm start
```

Then open: `http://localhost:3333`

### Provider credentials

bb uses whichever providers you have configured. If you need to set one up:

| Provider      | Setup                                                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`       | Install the [Codex CLI](https://developers.openai.com/codex/cli). Then run `codex login` or configure credentials per the Codex docs.                                                                                                                                            |
| `claude-code` | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and authenticate per its docs.                                                                                                                                                                             |
| `pi`          | See the [Pi coding agent docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Run `pi` and then `/login` for interactive setup.                                                                                                                          |

Server configuration (ports, data directory, inference model, etc.) is defined in [`packages/config/src/`](./packages/config/src/) with validated defaults for dev and production.

<details>
<summary>Development setup</summary>

If you want to work on bb itself, use the development loop:

```bash
pnpm dev
```

That starts the Vite app on `http://localhost:5173` and proxies API and WebSocket traffic to a separate dev server on `:3334`, using `~/.bb-dev` by default so it can run alongside `pnpm start`.

```bash
pnpm bb:dev --help        # CLI during development
pnpm reset:dev            # clear dev state
pnpm reset                # clear production state
pnpm reset:all            # clear both
```

These reset commands prompt for confirmation before deleting anything.

</details>

## Core Concepts

### Data Model

| Concept        | What it means                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project        | The top-level container for related work, usually mapped to a repository plus its bb-managed state.                                                                          |
| Thread         | The core unit of work. A thread has durable history, lifecycle state, execution settings, and usually a dedicated environment context.                                      |
| Standard thread | A coding thread that does the work directly in an environment and exposes git, diff, and workspace-oriented behavior.                                                       |
| Manager thread | A coordinator thread for a project. It can plan, delegate, and publish user-facing output, and it uses a separate BB-managed workspace instead of a coding worktree flow.   |
| Thread ownership | Threads can be user-created or managed by another thread. Delegation and handoff are first-class parts of the model.                                                     |
| Environment    | The execution context a thread runs in — a workspace on a specific host.                                                                                                     |
| Agent provider | The model/runtime behind a thread, such as `codex`, `claude-code`, or `pi`.                                                                                                  |

### Runtime Components

> TODO: rebuild in progress — see `plans/architecture.md` for the current architecture.

### System Surfaces

| Surface  | What it does                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Web app  | The visual surface for inspecting projects and threads, following progress, and steering active work.              |
| `bb` CLI | A first-class interface for both users and agents. It can inspect and operate the same bb system programmatically. |

Several of these boundaries are intentional extension points, but they should
be read as current architecture, not as a frozen public platform surface.

## Configuration

Runtime configuration is defined in [`packages/config/src/`](./packages/config/src/) with validated defaults. Environment variables can be overridden in a `.env` file at the repo root (gitignored).

Local state defaults to `~/.bb/`. `pnpm dev` uses `~/.bb-dev/` by default so it can run alongside the production-style server. Thread execution context also exposes `BB_PROJECT_ID`, `BB_THREAD_ID`, and `BB_ENVIRONMENT_ID`.

`pnpm reset`, `pnpm reset:dev`, and `pnpm reset:all` remove bb-managed local state only. They do not remove provider credentials or config owned by other tools.

## Further Reading

- [Architecture](plans/architecture.md)
- [Vision](docs/VISION.md)

## Contributing

While bb is still pre-alpha, the most useful contributions are feature requests and bug reports. If you run into something broken, confusing, or missing, open an issue with the workflow you were trying to accomplish and what happened instead.
