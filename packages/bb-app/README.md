<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/e40bda56-54a4-47f8-a417-6bbadf2e5b40">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232">
    <img alt="bb" src="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232" width="128">
  </picture>
</p>

# bb

[![npm version](https://img.shields.io/npm/v/bb-app.svg)](https://www.npmjs.com/package/bb-app)

bb is an agentic IDE that builds itself. It can control, customize, and automate
itself, laying the groundwork for your own software factory.

This package provides the `npx bb-app` launcher, bundled `bb` CLI entry, and
Node SDK export. Every surface — the web app, CLI, and HTTP API — is a
first-class way to drive bb. Work runs in threads you can follow live, steer at
any point, or hand off to another agent.

> Note: bb is in active development. Workflows and surfaces are still evolving.

## Quick Start

bb runs from npm and orchestrates coding agents you already have installed.

### Prerequisites

- Node.js 22.19, 24, or 26.
- Git.
- At least one supported agent provider: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex/cli), Cursor via ACP, [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), or another ACP-compatible agent.

If you already use one of these providers, bb will pick up your existing
credentials. If you use multiple providers, you can mix and match per task.

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
npx bb-app@latest
```

Then open: `http://localhost:38886`

To opt into the automated nightly channel:

```bash
npx bb-app@nightly
```

Nightly versions are built from `main` and may be unstable. The `nightly`
dist-tag moves independently of the stable `latest` tag.

npm 12 and later block dependency install scripts by default. bb needs those
scripts to build its native add-ons (`better-sqlite3`, `node-pty`,
`@parcel/watcher`). Without them bb stops at startup with
`Could not locate the bindings file`. If your npm version is 12 or later, allow
the scripts for the install:

```bash
npx --allow-scripts=better-sqlite3,node-pty,@parcel/watcher bb-app@latest
```

Or set the policy once for all global installs:

```bash
npm config set allow-scripts=better-sqlite3,node-pty,@parcel/watcher --location=user
```

`npx bb-app@latest` downloads the published `bb-app` package, starts the server and
local host daemon, and serves the web app. It stores bb-managed state under
`~/.bb/` by default. If either managed child process exits unexpectedly, the
launcher restarts that child without stopping the other one. Press `Ctrl+C` in
the terminal to stop both processes and exit with status `0`.

To stop a bb that runs in another terminal or in the background:

```bash
npx bb-app stop
```

`stop` reads `bb-app-runtime.json` from the data directory, confirms that the
recorded process really is that launcher, then stops it. Pass `--data-dir` when
the bb you want to stop does not use the default `~/.bb/`.

From the app, add or open a project, start a thread, and choose the provider
you want that thread to use.

## CLI

The package also exposes the `bb` CLI for an already-running bb server:

```bash
npx --package bb-app bb --help
```

The CLI uses the same `BB_SERVER_URL` and bb config resolution as the SDK. When
unset, it targets the default local packaged server at
`http://127.0.0.1:38886`.

## Scripting with the SDK

The package also exposes a Node SDK for scripts that drive an already-running
bb server:

```ts
import { BBSdk } from "bb-app";

const bb = new BBSdk();
const thread = await bb.threads.spawn({
  projectId: "proj_personal",
  environment: { type: "host", workspace: { type: "personal" } },
  prompt: "Summarize my active bb work.",
});
await bb.threads.wait({ threadId: String(thread.id), status: "idle" });
console.log(await bb.threads.output({ threadId: String(thread.id) }));
```

`new BBSdk()` uses the same `BB_SERVER_URL` and bb config resolution as the
CLI. Pass `new BBSdk({ baseUrl: "http://host:38886" })` for remote or test
targets (see the remote-access note below). Scripts launched by bb already receive `BB_SERVER_URL` and
`BB_THREAD_ID` in their environment.

## Provider Credentials

bb uses whichever providers you have configured. Common providers:

| Provider       | Setup                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`        | Install the [Codex CLI](https://developers.openai.com/codex/cli). Then run `codex login` or configure credentials per the Codex docs.                                                     |
| `claude-code`  | Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and authenticate per its docs.                                                                                      |
| `cursor`       | Install [Cursor's agent CLI](https://cursor.com/cli) (`cursor-agent`) and authenticate per Cursor's docs.                                                                                 |
| `pi`           | Install [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) with `npm install -g @earendil-works/pi-coding-agent` (0.84.0 or newer) and authenticate per its docs; BB can run the install from Settings.          |
| `opencode`     | Install [opencode](https://opencode.ai/) and authenticate per its docs.                                                                                                                   |
| `grok`         | Install [Grok Build](https://docs.x.ai/build/overview) and authenticate with `grok login` or `XAI_API_KEY`.                                                                               |
| `hermes-agent` | Install [Hermes Agent](https://hermes-agent.nousresearch.com/docs/getting-started/installation), configure credentials with `hermes model`, then verify ACP with `hermes acp --check`.    |

BB indexes the documented native skill roots for Codex, Claude Code, Pi,
Cursor, OpenCode, omp, Grok Build, and Hermes Agent. It includes user roots,
project roots, and compatibility roots such as `.agents/skills`. These skills
appear in the selected provider's `/` command menu. The Skills page and
`bb skill list` show native skills for Claude Code, Codex, and Cursor. BB also
reads configured Pi, omp, Grok, and Hermes skill directories, plus enabled
provider plugin skills.

BB reads Pi's global `~/.pi/agent` files and each workspace's `.pi` files.
This includes settings, credentials, models, packages, extensions, skills,
prompts, themes, and context files. Pi extensions can add models and tools.
BB loads project resources only after Pi's saved or global trust policy approves
the workspace. An unresolved `ask` decision stays untrusted because BB has no Pi
trust prompt.
You can still use the Pi CLI and `/login` to create this configuration.

Custom ACP agents are configured through the ACP providers plugin's
`customAgents` setting: `bb plugin config provider-acp set customAgents
'[...]'`. See the configuration docs for the optional `modelCli` and
`reasoningCli` or `nativeReasoning` reasoning settings. The optional
`nativeSkillRoots` field adds provider-native skills to the composer. Its
`user` paths resolve from the target host home directory. Its `project` paths
resolve from the selected workspace. The `customAcpAgents` array in
`~/.bb/config.json` is the deprecated form of the same list; bb reads it, warns
about each entry, and stops reading it in 0.41.
Top-level `sharedSkillRoots` uses the same `user` and `project` path format.
BB lists these sources as read-only skills. BB injects them into Codex, Claude,
Pi, and ACP threads. This permits one physical skill collection for BB and a
standalone provider CLI.

## Configuration

Use `bb-app config` for persistent non-secret package settings under
`~/.bb/config.json`:

```bash
npx bb-app config set BB_APP_URL https://<machine>.<tailnet>.ts.net
npx bb-app config set BB_INFERENCE codex/gpt-5.6-luna
npx bb-app config set BB_INFERENCE_FALLBACK codex/gpt-5.4-mini
npx bb-app config set BB_TRANSCRIPTION codex/gpt-transcribe
npx bb-app config list
npx bb-app config refresh
```

For remote access, use bb connect or publish the default loopback listener with
Tailscale Serve. Direct tailnet or LAN access to port `38886` requires the
explicit, security-sensitive `--server-bind-host 0.0.0.0` compatibility option;
see the multiple-devices guide.

Use `bb-app client ssh-target` to configure local editor opens for remote
bb servers under `~/.bb/client.json`. The target is the value that works after
`ssh`, such as `devbox` or `user@devbox`:

```bash
npx bb-app client ssh-target set https://bb.example.test devbox --host-id host_abc
npx bb-app client ssh-target list
```

Use `bb-app env` for provider credentials under `~/.bb/env.json`:

```bash
npx bb-app env set OPENAI_API_KEY <key>
npx bb-app env list
npx bb-app env unset OPENAI_API_KEY
```

`env list` redacts all values. Config and env writes ask a running local bb
server to reload; if bb is stopped, the values apply on the next start.

For all config keys, precedence, startup flags, and source-development `.env`
behavior, see the
[configuration docs](https://github.com/get-bb/bb/blob/main/docs/configuration.md).

## Further Reading

- [Main README](https://github.com/get-bb/bb#readme)
- [Platform support](https://github.com/get-bb/bb/blob/main/docs/platform-support.md)
- [Configuration](https://github.com/get-bb/bb/blob/main/docs/configuration.md)
- [Using bb on multiple devices](https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md)
- [Worktree setup and teardown scripts](https://github.com/get-bb/bb/blob/main/docs/worktrees.md)
