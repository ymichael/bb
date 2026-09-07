<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/e40bda56-54a4-47f8-a417-6bbadf2e5b40">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232">
    <img alt="bb" src="https://github.com/user-attachments/assets/4d9d02fb-c179-449b-a38a-041955143232" width="128">
  </picture>
</p>

# bb

[![npm version](https://img.shields.io/npm/v/bb-app.svg)](https://www.npmjs.com/package/bb-app)
[![Join Discord](https://img.shields.io/badge/Discord-Join%20server-5865F2?logo=discord&logoColor=white)](https://discord.gg/kvBU6tJhcJ)

bb is an agentic IDE that builds itself. It can control, customize, and automate
itself, laying the groundwork for your own software factory.

Every surface — the desktop app, web app, CLI, and HTTP API — is a first-class
way to drive bb. Work runs in threads you can follow live, steer at any point,
or hand off to another agent.

> [!NOTE]
> bb is in active development. Core architecture is stable, but workflows
> and surfaces are still evolving.

<p align="center">
  <img alt="bb desktop app showing a code review thread, dispatch panel, and task board" src="assets/app-screenshot.png" width="800">
</p>

## Use bb

### Download the desktop app

The recommended way to start using bb is the desktop app:

**[Download the latest desktop app](https://github.com/get-bb/bb/releases/tag/desktop-latest)**

The desktop app supports macOS on Apple Silicon (arm64). The Linux x64 AppImage
is alpha: expect problems, and please report them. Intel Mac users should run bb
with `npx` instead. On Windows, run bb inside
[WSL2 (Windows Subsystem for Linux)](https://learn.microsoft.com/windows/wsl/install):
install WSL2 first, then run the same `npx` command below from your WSL2 (Linux)
shell. Native Windows PowerShell and CMD are not supported.

Early adopters can install
**[bb Nightly](https://github.com/get-bb/bb/releases/tag/desktop-nightly)**
alongside the stable desktop app. It has a separate application identity,
yellow icon, and auto-update feed.

### Or run it anywhere with npx

```bash
npx bb-app@latest
```

Then open `http://localhost:38886`.

To run the newest automated build instead:

```bash
npx bb-app@nightly
```

npm 12 and later block dependency install scripts by default. bb needs those
scripts to build its native add-ons. If your npm version is 12 or later, allow
the scripts for the install:

```bash
npx --allow-scripts=better-sqlite3,node-pty,@parcel/watcher bb-app@latest
```

Or set the policy once for all global installs:

```bash
npm config set allow-scripts=better-sqlite3,node-pty,@parcel/watcher --location=user
```

bb uses the provider CLI you already have authenticated.

For install requirements, provider setup, configuration, and package-focused
docs, start with
[`packages/bb-app`](./packages/bb-app/README.md).

### Telemetry

Production runs (the desktop app and `npx bb-app`) send anonymous usage
telemetry (app starts, thread creation counts, user message counts, and plugin
installs) to help us understand adoption. Identification is a random per-install
id stored in your data dir — no user, host, project, workspace, or message
content is ever attached. Plugin install events name only public plugins
(bundled plugins and `bb-community` marketplace entries); installs from a local
path, a private git or npm source, or a third-party marketplace report no name. Development/source runs never send. Opt out any run with
`BB_TELEMETRY=false`. See
[`apps/server/src/services/system/telemetry.ts`](./apps/server/src/services/system/telemetry.ts).

## Development

Use the development loop when working on bb itself:

```bash
pnpm dev
```

That starts the Vite app and proxies API and WebSocket traffic to a separate
dev server. The launcher prints the actual ports at startup. Each checkout gets
a data directory under
`~/.bb-dev/<checkout-instance>/` and deterministic high ports derived from the
checkout path. The checkout instance id is the sanitized path to the checkout,
relative to your home directory, plus a short hash suffix. Separate worktrees
can run alongside each other and the packaged `npx bb-app@latest` instance.

To test the production bundle and serving path without switching to production
data or ports, use:

```bash
pnpm start:worktree
```

This builds the same optimized frontend and runtime artifacts as `pnpm start`,
then serves the app from the BB server on the checkout-specific dev server port.
It keeps the normal checkout-specific dev data directory and host-daemon port.
There is no Vite dev server or hot reload in this mode; rerun the command after
source changes. As with `pnpm dev`, worktree starts do not send telemetry.

To run that same source dev server with the Electron desktop shell:

```bash
pnpm dev:desktop
```

This uses `scripts/bb-dev-app current --desktop`, which stops stale launcher
sessions, checks dependencies and native modules, starts the source dev server,
then opens the desktop shell against that dev app. The launcher prints the web
URL but does not open a browser unless you pass `--open`.

To use the dev app from another machine over Tailscale, run `pnpm dev`, note the
printed app port, and publish the loopback Vite listener:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:<app-port>
```

Then open `https://<machine>.<tailnet>.ts.net`. Source dev binds both the Vite
app and main server to loopback by default; Vite continues to proxy API and
WebSocket traffic.

For direct access at `http://<tailscale-ip>:<app-port>` instead, run:

```bash
pnpm dev:remote
```

This binds the Vite app and main server to all IPv4 interfaces. The remote
browser must be able to reach both the printed app and server ports for realtime
updates. The server API is unauthenticated and permits command execution and
file reads, so use this only behind a trusted network boundary and restrict the
ports to Tailscale traffic with the host firewall when the LAN is not trusted.

To access the production-style worktree server directly from another machine,
run:

```bash
pnpm start:worktree-remote
```

This uses the same checkout-specific data directory and ports as
`pnpm start:worktree`, but binds its single server listener to all IPv4
interfaces. The server API is unauthenticated and permits command execution and
file reads, so use it only behind a trusted network boundary and restrict the
port to Tailscale traffic with the host firewall when the LAN is not trusted.

To use the component storybook from another machine, run:

```bash
pnpm storybook
```

Ladle binds to all interfaces and configures its HMR WebSocket to use the
browser's current host instead of `localhost`. Do not run `pnpm storybook` on an
untrusted network.

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

To run a production-mode build from a source checkout:

```bash
pnpm start
```

That builds only the app, server, and host-daemon runtime artifacts, then runs
the launcher directly against those workspace outputs. Use the `bb-app`
tarball smoke task when validating the published `npx bb-app@latest` package
layout.

```bash
pnpm bb --help            # built CLI, targets the default/prod instance
pnpm reset                # clear production state

pnpm bb:dev --help        # source CLI, targets this checkout's dev instance
pnpm reset:dev            # clear this checkout's dev state

pnpm reset:all            # clear both production and dev states
```

These reset commands prompt for confirmation before deleting anything.

## Repository Overview

See [Repository overview](docs/repository-overview.md) for the monorepo package and app map.

## System Overview

See [System overview](docs/system-overview.md) for runtime architecture, data model, and component boundaries.

## Further Reading

- [Vision](docs/VISION.md)
- [Platform support](docs/platform-support.md)
- [Configuration](docs/configuration.md)
- [Using bb on multiple devices](docs/multiple-devices.md)
- [Worktrees and setup scripts](docs/worktrees.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Troubleshooting

### `Could not locate the bindings file`

bb uses native add-ons, for example `better-sqlite3` and `@parcel/watcher`. npm
downloads or builds those binaries in a package install script. If npm does not
run install scripts, the binaries are absent. bb then stops at startup with this
error:

```
Error: Could not locate the bindings file. Tried:
 → .../node_modules/better-sqlite3/build/better_sqlite3.node
```

There are two usual causes.

The first cause is npm 12 or later. Since npm 12, npm blocks dependency install
scripts by default and prints
`npm warn install-scripts N packages had install scripts blocked`. Name bb's
native add-ons in `--allow-scripts` to let this one command run their install
scripts:

```bash
npx --allow-scripts=better-sqlite3,node-pty,@parcel/watcher bb-app@latest
```

For a permanent install with the same setting, use:

```bash
npm install -g --allow-scripts=better-sqlite3,node-pty,@parcel/watcher bb-app
bb-app
```

To allow them for all global installs on this machine, run
`npm config set allow-scripts=better-sqlite3,node-pty,@parcel/watcher --location=user`.
npm 10 and 11 accept or ignore the flag, so it is safe on every supported Node.

The second cause is `ignore-scripts=true` in your `~/.npmrc`. Set the
`npm_config_ignore_scripts` environment variable to let this one command run its
install scripts:

```bash
npm_config_ignore_scripts=false npx bb-app@latest
```

For a permanent install with the same setting, use:

```bash
npm_config_ignore_scripts=false npm install -g bb-app
bb-app
```

The environment variable applies to that one command only. Keep
`ignore-scripts=true` in your `~/.npmrc` if you want it for security.

The same error has other causes. A Node.js major-version change after the
install causes it. A copy of `node_modules` from a different operating system,
CPU architecture, or libc variant also causes it. To recover, install the
package again, or run `npm rebuild better-sqlite3`.

## Acknowledgements

<a href="https://blacksmith.sh"><img src="assets/blacksmith-ci.png" alt="CI powered by Blacksmith" width="400"></a>
