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

This package provides the `npx bb-app` launcher. bb gives coding agents a
shared workspace with a web app, CLI, and server they can all operate through.
Use it to run work in threads, inspect progress, steer execution, and keep
humans and agents working in the same loop.

> Note: bb is in active development. The npm package is currently published as
> an alpha while the install and first-run flow settles.

## Quick Start

bb runs from npm and orchestrates coding agents you already have installed.

### Prerequisites

- Node.js `22.12.0` or newer. Node `20.19.x` also works.
- Git.
- At least one supported agent provider: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex/cli), or [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent).

If you already use one of these providers, bb will pick up your existing
credentials. If you use all three, you can mix and match per task.

### Supported host environments

- macOS
- Linux

<details>
<summary>Windows via Ubuntu on WSL2</summary>

Run all `bb` commands inside WSL2, install Node.js, Git, and your provider CLIs
inside that WSL2 distro, and use Linux-style paths such as `/home/me/repo` or
`/mnt/c/Users/me/repo`.

Native Windows PowerShell, CMD, drive-letter paths, and UNC paths are not
supported product paths. Repos inside the WSL filesystem are recommended;
`/mnt/c/...` is intentionally supported so you can keep an existing Windows
checkout, but it is slower and less reliable for file watching.

</details>

### Install and run

```bash
npx bb-app
```

Then open: `http://localhost:38886`

`npx bb-app` downloads the published `bb-app` package, starts the server and
local host daemon, and serves the web app. It stores bb-managed state under
`~/.bb/` by default. Press `Ctrl+C` in the terminal to stop both processes.

From the app, add or open a project, start a thread, and choose the provider
you want that thread to use.

## Provider Credentials

bb uses whichever providers you have configured. If you need to set one up:

| Provider      | Setup                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex`       | Install the [Codex CLI](https://developers.openai.com/codex/cli). Then run `codex login` or configure credentials per the Codex docs.                  |
| `claude-code` | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and authenticate per its docs.                                                   |
| `pi`          | See the [Pi coding agent docs](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Run `pi` and then `/login` for interactive setup. |

`OPENAI_API_KEY` is recommended for the best default experience. bb uses it for
server-side helpers such as generated thread titles, branch names, commit
messages, and voice transcription. Core agent threads can still run when the
selected provider CLI is authenticated, such as `codex login` or a logged-in
Claude Code install.

```bash
npx bb-app config OPENAI_API_KEY <key>
```

## Configuration

Use `bb-app config` for persistent settings:

```bash
npx bb-app config list
npx bb-app config refresh
```

For config keys, precedence, startup flags, and source-development `.env`
behavior, see the
[configuration docs](https://github.com/ymichael/bb/blob/main/docs/configuration.md).

## Further Reading

- [Main README](https://github.com/ymichael/bb#readme)
- [Platform support](https://github.com/ymichael/bb/blob/main/docs/platform-support.md)
- [Configuration](https://github.com/ymichael/bb/blob/main/docs/configuration.md)
- [Using bb on multiple devices](https://github.com/ymichael/bb/blob/main/docs/multiple-devices.md)
- [Adding another host](https://github.com/ymichael/bb/blob/main/docs/additional-hosts.md)
- [Worktrees and setup scripts](https://github.com/ymichael/bb/blob/main/docs/worktrees.md)
