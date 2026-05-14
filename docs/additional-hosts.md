# Adding another host

By default, bb runs and executes work on one machine. You can also connect
additional machines as **hosts** — each one runs a small daemon that picks up
work from the server. This is how you point bb at a dedicated build machine,
a beefier workstation, or any other persistent machine you want to use for
execution.

The server still stores all your projects, threads, and history. Hosts just
give you more places to actually run things.

## What you'll need

- A bb server already running on one machine, reachable from the machine you
  want to add.
- `BB_APP_URL` set in the server's `.env`, so the app can generate join
  commands. See [Using bb on multiple devices](./multiple-devices.md) if you
  haven't set this up yet.
- A checkout of the bb repo on the new host, with dependencies installed.
- Provider CLIs and credentials installed on the new host — each host runs
  with whatever is available locally, nothing is shared from the server.

## Enroll the new host

In the app, open **Settings** and click **New host**. bb creates a single-use
join code (valid for 15 minutes) and shows a modal with the command to run.

On the new host, paste that command into a terminal in the bb checkout. It
looks like:

```bash
BB_SERVER_URL='http://<server>.<tailnet>.ts.net:38886' \
BB_HOST_ID='host_...' \
BB_HOST_TYPE='persistent' \
BB_HOST_ENROLL_KEY='bbde_...' \
pnpm start:host-daemon
```

The app's modal updates as soon as the daemon connects.

After the first run, the daemon writes its auth under `BB_DATA_DIR` (`~/.bb/`
by default). To restart it later, only the server URL is needed:

```bash
BB_SERVER_URL='http://<server>.<tailnet>.ts.net:38886' pnpm start:host-daemon
```

To confirm a host is connected, run this from any machine that can reach the
server:

```bash
BB_SERVER_URL='http://<server>.<tailnet>.ts.net:38886' pnpm bb host list
```

## Point a project at the new host

A project can only run on a host if it has a local-path source for that host.
The path is interpreted on the host machine, not on the server.

The app doesn't yet support adding a source path on another host, so add it
from the CLI:

```bash
BB_SERVER_URL='http://<server>.<tailnet>.ts.net:38886' \
pnpm bb project source add <project-id> \
  --host <remote-host-id> \
  --path /absolute/path/on/the/host
```

Once that's set, the host shows up in the app's environment picker for that
project.

## A note on access

bb has no built-in user authentication on the server today. Keep traffic
between the server and hosts on a private network like a Tailscale tailnet —
don't expose bb directly to the public internet.

## If something isn't working

A few quick checks:

1. Run `pnpm bb host list` from any machine that can reach the server. The
   new host should show up as connected.
2. If the app shows an "app URL required" prompt when generating a join
   command, set `BB_APP_URL` in the server's `.env` and restart bb.
3. Join codes are single-use and expire after 15 minutes. If you missed the
   window, request a new one from the app.
4. If `pnpm start:host-daemon` fails to start without `BB_HOST_ENROLL_KEY`,
   its persisted auth may be missing or pointing at a different server.
   Re-run the enrollment from the app.
