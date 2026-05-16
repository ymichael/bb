<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/e40bda56-54a4-47f8-a417-6bbadf2e5b40">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232">
    <img alt="bb" src="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232" width="128">
  </picture>
</p>

# bb

[![npm version](https://img.shields.io/npm/v/bb-app.svg)](https://www.npmjs.com/package/bb-app)

A programmable workspace for coding agents.

bb is a tool that your agents can use too. Delegate your entire workflow
or hand off only specific parts of it. Babysit an agent while it works,
or have another agent do it. Micromanage an agent or let it run. Teach
an agent to work like you would, then watch it use bb like you would.

bb gives coding agents a shared workspace with a UI, CLI, and server they can
all operate through. Use it to run work in threads, inspect progress, steer
execution, and keep humans and agents working in the same loop.

> [!NOTE]
> bb is in active development. Core architecture is stable, but workflows
> and surfaces are still evolving. The npm package is currently published as
> an alpha while the install and first-run flow settles.

## Use bb

```bash
npx bb-app
```

Then open `http://localhost:38886`. For install requirements, provider setup,
configuration, and package-focused docs, start with
[`packages/bb-app`](./packages/bb-app/README.md).

## Repository Overview

This monorepo contains the packaged app plus the runtime services it bundles:

| Package or app                                                     | Role                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [`packages/bb-app`](./packages/bb-app)                             | Published npm package and `npx bb-app` launcher.                                      |
| [`apps/app`](./apps/app)                                           | Web UI for inspecting projects, threads, environments, and running work.              |
| [`apps/server`](./apps/server)                                     | HTTP API, WebSocket notifications, state management, and server-owned product policy. |
| [`apps/host-daemon`](./apps/host-daemon)                           | Host-local runtime that provisions workspaces and runs provider processes.            |
| [`apps/cli`](./apps/cli)                                           | Scriptable `bb` CLI for users and agents.                                             |
| [`packages/server-contract`](./packages/server-contract)           | HTTP and WebSocket contract between clients and the server.                           |
| [`packages/host-daemon-contract`](./packages/host-daemon-contract) | Command/event contract between the server and host daemons.                           |

## Development

Use the development loop when working on bb itself:

```bash
pnpm dev
```

That starts the Vite app on `http://localhost:5173` and proxies API and
WebSocket traffic to a separate dev server on `:3334`, using `~/.bb-dev` by
default so it can run alongside the packaged `npx bb-app` instance.

Development behavior is intentionally split:

- the app hot reloads itself
- the server does not hot reload
- the host daemon does not hot reload

When you want the server and host daemon to pick up the latest build output, use:

```bash
pnpm dev:restart
pnpm dev:restart-server
pnpm dev:restart-host-daemon
```

These rebuild first, then restart only the targeted stateful services.

To test the release-style package launcher from a source checkout:

```bash
pnpm start
```

That builds the local `bb-app` package artifacts and runs
`packages/bb-app/dist/bb-app.js`, matching the published `npx bb-app` path
without downloading from npm.

To test an additional host against that dev server, use:

```bash
pnpm dev:host-daemon -- --auto-join
```

That runs a second host daemon against the dev server and stores its state
under `~/.bb-dev-extra-host`. On first run, it requests local enrollment from
the dev server; after enrollment, the daemon persists its auth state locally.

```bash
pnpm bb --help            # built CLI, targets the default/prod instance
pnpm reset                # clear production state

pnpm bb:dev --help        # source CLI, targets the dev instance
pnpm reset:dev            # clear dev state

pnpm reset:all            # clear both production and dev states
```

These reset commands prompt for confirmation before deleting anything.

## System Overview

### The runtime pieces

| Component       | Role                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server**      | Central hub. Stores all state in a SQLite database, exposes an HTTP API, and pushes change notifications over WebSocket. Stateless itself — the DB is the source of truth. Routes work to hosts by queuing commands.                                                                                    |
| **Host daemon** | Runs on each host (your laptop or a remote server). Connects to the server, picks up commands, provisions workspaces, runs agent provider processes, and streams events back. Exposes a local HTTP API for the app and CLI to do machine-local things (open editor, pick folders, check daemon status). |
| **App**         | Web UI for inspecting projects and threads, following progress, and steering work.                                                                                                                                                                                                                      |
| **CLI** (`bb`)  | First-class interface for both users and agents. Same capabilities as the app, scriptable.                                                                                                                                                                                                              |

### Data model

The core entities and how they relate:

**Project** — the top-level container, usually mapped to a repository. A project has one or more **sources** that say where its code lives: local paths on specific hosts.

**Thread** — the unit of work. Each thread tracks a conversation with an agent provider, has lifecycle state, and produces an append-only stream of **events** (messages, tool calls, file changes, etc.). Threads can be **standard** (does work directly) or **manager** (coordinates other threads). Threads can own child threads for delegation.

**Environment** — the execution context for a thread. It binds a workspace (a directory on disk) to a host. An environment can be **unmanaged** (point at an existing directory), or **managed**. Environments managed by bb will be cleaned up when there are no longer any unarchived threads using it. Multiple threads can share an environment.

**Host** — a long-lived machine that runs a daemon, such as your laptop or a remote server.

**Commands and events** — the server talks to daemons by queuing commands (provision an environment, start a thread, stop a thread). Daemons report back by posting events. This is an asynchronous command/event protocol — the server queues work, the daemon picks it up, results flow back as events.

### Contracts and boundaries

Two contract packages define the boundaries between components:

**`@bb/server-contract`** — the HTTP + WebSocket API between clients (app, CLI) and the server. Route schemas, request/response types, WebSocket notification types.

**`@bb/host-daemon-contract`** — the protocol between the server and host daemons. Command types, event types, session lifecycle, the local API for app/CLI.

Implementation packages never import across these boundaries. The server doesn't know how workspaces are provisioned. The daemon doesn't know about threads or projects beyond what commands tell it.

## Further Reading

- [Vision](docs/VISION.md)
- [Platform support](docs/platform-support.md)
- [Configuration](docs/configuration.md)
- [Using bb on multiple devices](docs/multiple-devices.md)
- [Adding another host](docs/additional-hosts.md)
- [Worktrees and setup scripts](docs/worktrees.md)

## Contributing

The most useful contributions are feature requests and bug reports. If you run into something broken, confusing, or missing, open an issue with the workflow you were trying to accomplish and what happened instead.
