<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/e40bda56-54a4-47f8-a417-6bbadf2e5b40">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232">
    <img alt="bb" src="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232" width="128">
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
> bb is in active development. Core architecture is stable, but workflows
> and surfaces are still evolving.

## Quick Start

bb runs from source and orchestrates coding agents you already have installed.

### Prerequisites

- Node.js
- pnpm
- At least one supported agent provider: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex/cli), or [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)

If you already use one of these, bb will pick up your existing credentials. If you use all three, you can mix and match per task.

### Supported host environments

- macOS
- Linux
- Windows via Ubuntu on WSL2

If you use Windows, run all `bb` commands inside WSL2, install Node.js, pnpm,
Git, and your provider CLIs inside that WSL2 distro, and use Linux-style paths
such as `/home/me/repo` or `/mnt/c/Users/me/repo`. Native Windows PowerShell,
CMD, drive-letter paths, and UNC paths are not supported product paths. Repos
inside the WSL filesystem are recommended; `/mnt/c/...` is intentionally
supported so you can keep an existing Windows checkout, but it is slower and
less reliable for file watching.

### Install and run

```bash
pnpm install
pnpm start
```

Then open: `http://localhost:3333`

The full platform policy and checkout/path expectations live in
[`docs/platform-support.md`](./docs/platform-support.md).

### Provider credentials

bb uses whichever providers you have configured. If you need to set one up:

| Provider      | Setup                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex`       | Install the [Codex CLI](https://developers.openai.com/codex/cli). Then run `codex login` or configure credentials per the Codex docs.                  |
| `claude-code` | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and authenticate per its docs.                                                   |
| `pi`          | See the [Pi coding agent docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Run `pi` and then `/login` for interactive setup. |

Server configuration (ports, data directory, inference model, etc.) is defined in [`packages/config/src/`](./packages/config/src/) with validated defaults for dev and production.

<details>
<summary>Development setup</summary>

If you want to work on bb itself, use the development loop:

```bash
pnpm dev
```

That starts the Vite app on `http://localhost:5173` and proxies API and WebSocket traffic to a separate dev server on `:3334`, using `~/.bb-dev` by default so it can run alongside `pnpm start`.

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

To test an additional host against that dev server, use:

```bash
BB_HOST_ENROLL_KEY=<join-code> pnpm dev:host-daemon
```

That runs a second host daemon against the dev server and stores its state under `~/.bb-dev-host-daemon` by default. Provide the join code from the server-side host join flow on first run; after enrollment, the daemon persists its auth state locally.

```bash
pnpm bb --help            # built CLI, targets the default/prod instance
pnpm reset                # clear production state

pnpm bb:dev --help        # source CLI, targets the dev instance
pnpm reset:dev            # clear dev state

pnpm reset:all            # clear both production and dev states
```

These reset commands prompt for confirmation before deleting anything.

</details>

## How It Works

### The runtime pieces

| Component       | Role                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server**      | Central hub. Stores all state in a SQLite database, exposes an HTTP API, and pushes change notifications over WebSocket. Stateless itself — the DB is the source of truth. Routes work to hosts by queuing commands.                                                                                                      |
| **Host daemon** | Runs on each machine (your laptop, a cloud sandbox, a remote server). Connects to the server, picks up commands, provisions workspaces, runs agent provider processes, and streams events back. Exposes a local HTTP API for the app and CLI to do machine-local things (open editor, pick folders, check daemon status). |
| **App**         | Web UI for inspecting projects and threads, following progress, and steering work.                                                                                                                                                                                                                                        |
| **CLI** (`bb`)  | First-class interface for both users and agents. Same capabilities as the app, scriptable.                                                                                                                                                                                                                                |

### WebSocket is notification-only

WebSocket connections never carry data payloads. They send lightweight change hints (e.g. "thread X changed") so clients know to refetch via HTTP. This keeps the protocol simple and means WS disconnects don't lose data — the DB is always current.

### Data model

The core entities and how they relate:

**Project** — the top-level container, usually mapped to a repository. A project has one or more **sources** that say where its code lives — either a local path on a specific host, or a GitHub repository URL.

**Thread** — the unit of work. Each thread tracks a conversation with an agent provider, has lifecycle state, and produces an append-only stream of **events** (messages, tool calls, file changes, etc.). Threads can be **standard** (does work directly) or **manager** (coordinates other threads). Threads can own child threads for delegation.

**Environment** — the execution context for a thread. It binds a workspace (a directory on disk) to a host. An environment can be **unmanaged** (point at an existing directory), or **managed**. Environments managed by bb will be cleaned up when there are no longer any unarchived threads using it. Multiple threads can share an environment.

**Host** — a machine that runs a daemon. **Persistent** hosts are long-lived (your laptop, remote server etc). **Ephemeral** hosts are cloud sandboxes (eg. E2B / Daytona etc) that the server provisions on demand and can suspend/resume/destroy.

**Commands and events** — the server talks to daemons by queuing commands (provision an environment, start a thread, stop a thread). Daemons report back by posting events. This is an asynchronous command/event protocol — the server queues work, the daemon picks it up, results flow back as events.

### Contracts and boundaries

Two contract packages define the boundaries between components:

**`@bb/server-contract`** — the HTTP + WebSocket API between clients (app, CLI) and the server. Route schemas, request/response types, WebSocket notification types.

**`@bb/host-daemon-contract`** — the protocol between the server and host daemons. Command types, event types, session lifecycle, the local API for app/CLI.

Implementation packages never import across these boundaries. The server doesn't know how workspaces are provisioned. The daemon doesn't know about threads or projects beyond what commands tell it.

## Configuration

All configuration is via environment variables, validated at startup with sensible defaults. Override them in `.env` files at the repo root (gitignored) and they will be loaded automatically by `pnpm dev` and `pnpm start`. The standard [dotenv-cli](https://github.com/entropitor/dotenv-cli) cascade applies: `.env`, `.env.local`, `.env.<environment>`, `.env.<environment>.local` — where environment is `development` for `pnpm dev` and `production` for `pnpm start`. See [`packages/config/src/`](./packages/config/src/) for the full set of variables.

`BB_DATA_DIR` is the most important one — it's the root directory for all bb-managed state: the SQLite database, logs, host identity, and thread storage. Defaults to `~/.bb/` (or `~/.bb-dev/` when using `pnpm dev`). Pointing two instances at different data directories gives you fully isolated environments — this is how dev and production run side by side, and how tests get clean state.

Use `pnpm reset` or `pnpm reset:dev` to clear a data directory. These only remove bb-managed state, not provider credentials.

Root commands such as `pnpm start`, `pnpm bb`, `pnpm bb:dev`, and `pnpm reset`
are thin wrappers around `@bb/scripts`. Those wrappers force `NODE_ENV` to the
intended mode (`production` or `development`) so ambient shell state does not
silently retarget bb. If you set a concrete `BB_*` variable such as
`BB_DATA_DIR`, `BB_SERVER_URL`, or `BB_HOST_DAEMON_PORT`, that explicit value
still wins over the mode-selected default.

Inside the product itself, `NODE_ENV` is only used to choose defaults. When one
process needs to target a specific bb instance, it passes explicit `BB_*`
addressing values instead.

## Further Reading

- [Vision](docs/VISION.md)

## Contributing

The most useful contributions are feature requests and bug reports. If you run into something broken, confusing, or missing, open an issue with the workflow you were trying to accomplish and what happened instead.
