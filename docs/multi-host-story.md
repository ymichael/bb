# Multi-host Story

## Goal

Real-user testing should support one bb server coordinating multiple persistent
hosts:

- the server stores state and serves the app/API
- each host daemon runs on the machine where work should execute
- host daemons connect outbound to the server and receive queued commands
- users can pick a connected host when starting work

The host daemon's local API remains bound to that host's `localhost`; it is for
browser/CLI actions running on the same machine as the daemon. Cross-machine
work uses the server-to-daemon command channel.

## Network setup

The server URL must be reachable from every host daemon. For real-user testing,
prefer a private Tailscale tailnet:

```bash
BB_APP_URL=http://<server-machine>.<tailnet>.ts.net:38886 pnpm start
```

Hosts can also use any other trusted network URL, but do not expose bb directly
to the public internet. The public API currently has no user authentication.

## Enroll another persistent host

In the app, open Settings and click **New host**. bb creates join material and
opens a modal with the CLI command to run on the other machine.

On the remote host, run the command from a checkout of this repo:

```bash
BB_SERVER_URL='http://<server-machine>.<tailnet>.ts.net:38886' \
BB_HOST_ID='host_...' \
BB_HOST_TYPE='persistent' \
BB_HOST_ENROLL_KEY='bbde_...' \
pnpm start:host-daemon
```

The modal updates when the host connects. The join code is single-use and
expires after 15 minutes.

The API fallback is:

```bash
curl -s -X POST \
  -H 'content-type: application/json' \
  --data '{"hostType":"persistent"}' \
  http://<server-machine>.<tailnet>.ts.net:38886/api/v1/hosts/join
```

After first enrollment, the daemon writes its auth state under `BB_DATA_DIR`
(`~/.bb/` by default). Future starts only need the server URL if the persisted
auth points somewhere else:

```bash
BB_SERVER_URL='http://<server-machine>.<tailnet>.ts.net:38886' pnpm start:host-daemon
```

Verify from any machine that can reach the server:

```bash
BB_SERVER_URL='http://<server-machine>.<tailnet>.ts.net:38886' pnpm bb host list
```

## Configure projects for remote hosts

A host is eligible for normal project work only when the project has a
local-path source for that host. The path is interpreted on that host, not on
the server machine.

Add a source for the remote host:

```bash
BB_SERVER_URL='http://<server-machine>.<tailnet>.ts.net:38886' \
pnpm bb project source add <project-id> \
  --host <remote-host-id> \
  --path /absolute/path/on/remote/host
```

Then start work on that host:

```bash
BB_SERVER_URL='http://<server-machine>.<tailnet>.ts.net:38886' \
pnpm bb thread spawn \
  --project <project-id> \
  --host <remote-host-id> \
  --new-environment worktree \
  --prompt "Run the test suite on the remote host."
```

The app environment picker should also show the host once it is connected and
the project has a local-path source for it.

## Development mode

For local development against the dev server, request join material from the
app or API first, then run the extra host daemon with that join code:

```bash
BB_SERVER_URL=http://<dev-server-machine>:3334 \
BB_HOST_ID='host_...' \
BB_HOST_TYPE='persistent' \
BB_HOST_ENROLL_KEY='bbde_...' \
pnpm dev:host-daemon
```

That stores state under `~/.bb-dev-extra-host`. It is useful for testing the
multi-host path without touching production-mode `~/.bb/` state.

## Current gaps

- The generated `joinCommand` requires `BB_APP_URL` to be set. If it is unset,
  the join endpoint returns `{ status: "app-url-required" }` and the app
  surfaces a configuration prompt instead of issuing a join command.
- `pnpm start:host-daemon` does not auto-request join material. It requires
  persisted auth or an explicit `BB_HOST_ENROLL_KEY`.
- The app can add a local-path source for the browser-local host, but it does
  not yet provide a dedicated flow for adding a source path on a different
  persistent host. Use the CLI with `--host` for now.
- Provider credentials and CLIs are host-local. Each remote host must have the
  needed provider CLI and credentials installed where the daemon runs.
- Remote "open in editor" is not part of this story. Editor-opening uses the
  local daemon API on the browser's machine; remote host work should be reviewed
  through bb output, git state, or by connecting to that host separately.

## Smoke test

1. Start the server with a reachable `BB_APP_URL`.
2. Enroll a second host and confirm `pnpm bb host list` shows it connected.
3. Add a project source for the second host using a path that exists on that
   host.
4. Spawn a managed worktree thread on the second host.
5. Confirm the environment is provisioned under the second host and the thread
   streams output back to the server.
6. Stop and restart the remote daemon without `BB_HOST_ENROLL_KEY`; it should
   reconnect using persisted auth.
