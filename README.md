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
> bb is still pre-alpha. Core ideas are in place, but interfaces, workflows,
> and APIs may still change quickly.

## Table of Contents

- [Quick Start](#quick-start)
- [Setup](#setup)
- [Core Concepts](#core-concepts)
  - [Data Model](#data-model)
  - [Runtime Components](#runtime-components)
  - [System Surfaces](#system-surfaces)
- [Configuration](#configuration)
- [Further Reading](#further-reading)
- [Contributing](#contributing)

## Quick Start

bb currently runs from source.

### Prerequisites

- Node.js
- pnpm
- Credentials for at least one supported agent provider

```bash
pnpm install
```

## Setup

Before starting bb, configure credentials for at least one supported provider.

1. Copy `.env.example` to `.env`.
2. Configure at least one provider:

| Provider      | Setup                                                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`       | Install the [Codex CLI](https://developers.openai.com/codex/cli). Then either set `OPENAI_API_KEY` in your environment or `.env`, or run `codex login`.                                                                                                                          |
| `claude-code` | Either set `ANTHROPIC_API_KEY` in your environment or `.env`, or run `claude setup-token` and then set the resulting token as `CLAUDE_CODE_OAUTH_TOKEN` in your environment or `.env`.                                                                                           |
| `pi`          | Authenticate with the Pi agent. See the [Pi coding agent docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Pi supports API keys in the environment, or interactive login through `pi` and then `/login` to authenticate with a supported subscription. |

3. Set `OPENAI_API_KEY` in your environment or `.env`. bb uses it for non-agent inference features such as thread title generation and commit message generation.

See [.env.example](./.env.example) for the full set of options and setup notes.

### Start bb

```bash
pnpm start
```

Then open: `http://localhost:3333`

`pnpm start` builds the app, server, and CLI when needed, then runs the built server without watch mode or hot reloading.

If you want to work on bb itself, use the development loop instead:

```bash
pnpm dev
```

That starts the Vite app on `http://localhost:5173` and proxies API and WebSocket traffic to a separate dev server on `:3334`, using `~/.bb-dev` by default so it can run alongside `pnpm start`.

If you want to drive bb from the CLI during development:

```bash
pnpm bb:dev --help
pnpm bb:dev status
```

To run the built server and CLI instead of the dev setup:

```bash
pnpm build
pnpm server --help
pnpm bb --help
```

## Core Concepts

### Data Model

| Concept        | What it means                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project        | The top-level container for related work, usually mapped to a repository.                                                                                                    |
| Thread         | The fundamental unit of agent work. Standard threads do the work directly. Manager threads coordinate other threads and can delegate work across the project.                |
| Thread Ownership | Threads can be managed by the user or another thread. Delegation and handoff are core to bb's model, not bolt-on workflow features.                                      |
| Environment    | The execution context a thread runs in, such as a local checkout, worktree, or other sandboxed environment. Environments are first-class, multiple threads can share one, and bb is designed to support different execution backends. |
| Environment Provisioning | bb can provision and manage environments for you, but the system is designed to support both managed and unmanaged environments.                                  |
| Agent provider | The model runtime that powers a thread, such as `codex`, `claude-code`, or `pi`. bb is designed to support different provider implementations.                               |

### Runtime Components

| Part               | What it does                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Server             | The main bb service that owns state, orchestration, APIs, provider coordination, and thread lifecycle.                            |
| Environments       | The runtime layer where threads actually execute, whether that is a local checkout, worktree, or another environment kind.        |
| Environment daemon | The environment-side session layer that communicates with the server and manages agent and command execution within environments. This split keeps orchestration in the server and execution inside environments. |
| Agent providers    | The provider runtimes that power threads and models.                                                                              |

### System Surfaces

| Surface  | What it does                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| Web app  | The visual surface for inspecting projects and threads, following progress, and steering active work.              |
| `bb` CLI | A first-class interface for both users and agents. It can inspect and operate the same bb system programmatically. |

Several of these boundaries are intentional extension points. bb is meant to
support different provider implementations, environment models, and execution
setups over time.

## Configuration

Most runtime configuration lives in [.env.example](./.env.example), including provider selection, authentication, server settings, worktree settings, and inference options.

Local state defaults to `~/.bb/`. Thread execution context also exposes `BB_PROJECT_ID`, `BB_THREAD_ID`, and `BB_ENVIRONMENT_ID`.

## Further Reading

- [Vision](docs/VISION.md)
- [QA docs](qa/README.md)
- [.env.example](./.env.example)

## Contributing

While bb is still pre-alpha, the most useful contributions are feature requests and bug reports. If you run into something broken, confusing, or missing, open an issue with the workflow you were trying to accomplish and what happened instead.
