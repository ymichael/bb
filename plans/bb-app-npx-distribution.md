# bb-app npx Distribution Plan

## Goal

Ship a user-facing npm package that makes local bb usable without cloning the repo:

- `npx bb-app` starts the local app server and host daemon.
- `npx bb-app host-daemon ...` starts or joins only the host daemon.
- `npx --package bb-app bb ...` runs the CLI against a configured or local server.

The package should feel like an app installer/launcher, while still exposing lower-level binaries for advanced hosting and debugging.

## Proposed Package Shape

Publish one package named `bb-app` with multiple bins:

```json
{
  "name": "bb-app",
  "bin": {
    "bb-app": "./dist/bb-app.js",
    "bb": "./dist/bb.js",
    "bb-server": "./dist/bb-server.js",
    "bb-host-daemon": "./dist/bb-host-daemon.js"
  }
}
```

Invocation behavior:

- `npx bb-app` runs the bin whose name matches the package name, so it starts the app launcher.
- `npx --package bb-app bb status` runs the CLI bin from the same package.
- `bb-server` and `bb-host-daemon` are available for process managers, Docker, systemd, and debugging, but should not be the primary user path.

## Launcher UX

`bb-app` should be the coordinator for common workflows:

- `bb-app` or `bb-app start`: start server, frontend, and local host daemon.
- `bb-app host-daemon`: start host daemon only.
- `bb-app host-daemon join`: enroll this machine with an existing server and persist the daemon config.
- `bb-app config get|set|list`: inspect and update managed configuration.

The server and daemon should still be separable internally. The launcher should resolve configuration once and spawn child processes with explicit `BB_*` env so the server, daemon, and CLI agree on ports, data dir, auth, bridge paths, and CLI path.

## Configuration Direction

Avoid making `.env` files or manual config editing the primary UX.

Use this precedence:

1. CLI flags
2. environment variables
3. managed config file
4. built-in defaults

The managed config file can live under `~/.bb/config.json`, but users should normally mutate it through commands, not by hand. Defaults should be enough for `npx bb-app` to work on a clean machine:

- data dir: `~/.bb`
- server/frontend: `127.0.0.1:38886`
- host daemon: `127.0.0.1:38887`
- logs: `~/.bb/logs`
- bundled CLI and provider bridges from the installed package

Config commands should make remote-host flows explicit, for example:

```bash
npx bb-app host-daemon join --server https://bb.example.com --join-code <code>
npx bb-app config set server.url https://bb.example.com
```

This broader config UX can be punted until the package shape, binaries, native dependency handling, and tarball execution work. The first pass still needs a small internal config resolver so the launcher can consistently map flags, env vars, and defaults into child-process env, but it does not need the final `config get|set|list` UX.

## Native Dependency Strategy

Keep native add-ons external from JS bundles and install them as real runtime dependencies of `bb-app`.

Known native-sensitive dependencies include:

- `better-sqlite3`
- `@parcel/watcher`
- packages used by logging transports, if they rely on native/runtime worker files

The package should not ship a single prebuilt `.node` binary for all platforms. It should let npm install the correct dependency artifacts on the user machine. This protects the normal `npx` path because installation happens on the target platform.

Risks to document and test:

- user changes Node version after install without reinstalling/rebuilding
- copied `node_modules` across machines, containers, OSes, CPU arches, or libc variants
- Alpine/musl availability differs from glibc
- lifecycle scripts are disabled
- no build toolchain is available when no prebuild exists
- native dependency is accidentally bundled or omitted from runtime dependencies

## Provider Bridges

Bundled provider bridges should work if the package includes the bridge files and the launcher passes explicit paths:

- `BB_BRIDGE_DIR` points at packaged bridge files.
- `BB_CLI_DIR` points at packaged CLI bins so runtime shells can find `bb`.

Validation must include at least one packaged provider-flow smoke test. Merely starting the server is not enough to prove bridge resolution works.

## Implementation Phases

1. Rename/package-align the current standalone work to `bb-app`.
2. Split package entrypoints into `bb-app`, `bb`, `bb-server`, and `bb-host-daemon`.
3. Add a shared config resolver used by all entrypoints.
4. Add launcher commands for full-stack start and daemon-only start/join.
5. Ensure packaged bridge and CLI directories are copied into the npm tarball.
6. Keep native dependencies external in esbuild and present in `bb-app` runtime dependencies.
7. Add tarball-based tests that execute the package as an installed artifact.
8. Add CI matrix coverage for supported Node/platform combinations.
9. Add the managed config UX once the package and process model are proven.

## Validation

Local validation should use packed tarballs, not workspace execution:

```bash
pnpm exec turbo run build --filter=bb-app
npm pack ./packages/bb-app --pack-destination /tmp
BB_DATA_DIR="$(mktemp -d)" npx --package /tmp/bb-app-*.tgz bb-app
```

Required smoke tests:

- `npx --package /tmp/bb-app-*.tgz bb-app` starts server and host daemon with a temp data dir.
- `curl http://127.0.0.1:<server-port>/health` succeeds.
- `npx --package /tmp/bb-app-*.tgz bb status` talks to the running server.
- `npx --package /tmp/bb-app-*.tgz bb-app host-daemon ...` joins a separately started server.
- packaged daemon runtime can find packaged `bb` on `PATH`.
- packaged provider bridge path is used successfully in a fake/test provider flow.
- package still works after installing in a clean temp directory outside the monorepo.

CI validation should cover:

- Node 22, Node 24, and Node 26 as the main compatibility matrix
- Node 20 as a best-effort compatibility signal only, because it is EOL
- macOS and Linux
- arm64 and x64 where available

Do not claim Alpine/musl support in the initial package.

## Exit Criteria

- `npx bb-app` works on a clean supported machine without manual `.env` or config edits.
- `npx --package bb-app bb ...` works as the user-facing CLI path.
- daemon-only host enrollment has a command-driven flow and persists managed config.
- server, daemon, CLI, and bridges all resolve paths from the installed package, not the source repo.
- native add-ons are installed as runtime dependencies and are not bundled into JS artifacts.
- tarball tests pass outside the monorepo.
- final managed config UX is either implemented or explicitly deferred behind a minimal launcher config resolver.
- docs explain the normal commands and the native-addon rebuild escape hatch.
