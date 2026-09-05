---
kind: instruction
title: bb Guide — Machines
summary: Command reference for listing and targeting execution machines.
intent: Explain execution-machine discovery and selection from the CLI.
editingNotes: Keep the user-facing noun machine; internal APIs and types use Host.
---
Machine commands

A machine is a host daemon that can run thread environments. Add remote or
plugin-provisioned machines under Settings → Machines.

The server listens on loopback by default. Remote execution machines need the
account-gated bb connect route or a private Tailscale Serve URL; generate their
installer while using that reachable server URL.

The Settings installer first uses the exact `bb-app` tarball served by that bb
server at `/install/bb-app.tgz`; only servers that do not implement the route
(HTTP 404) fall back to the npm registry. npm installs bb-app under this
machine enrollment's bb data directory, so the installer needs neither `sudo`
nor a global npm configuration. Installed launchd/systemd services pass
`--auto-update`. On a newer server protocol mismatch, the daemon downloads that
same artifact, updates its private install, and exits for the service manager to
restart. Failed attempts use a persisted exponential backoff that starts at 5
seconds and caps at 5 minutes. A daemon never auto-downgrades to an older server
protocol. Use Settings → Machines or `bb machine retry-update` to bypass the
current backoff after a transient failure.

To opt out, remove `--auto-update` from the launchd plist or systemd user unit
and reload that service. Foreground/manual `bb-app host-daemon` runs leave it off
unless you pass `--auto-update` explicitly.

  bb machine list                         List machines with ID, connection
                                          status, and relative last-seen time
    --json                                Print the raw host list
  bb machine providers [--project <id>]   List installed machine providers
    --json                                Include inputs schemas and policy
  bb machine show <id-or-name>            Show machine details
  bb machine join-code                    Create a machine pairing code
  bb machine rename <id-or-name> <name>   Rename a machine
  bb machine retry-update <id-or-name>    Retry a pending daemon update now
  bb machine remove <id-or-name> [--yes]  Revoke and remove a machine
  bb machine provider-cli status <machine>
  bb machine provider-cli install <machine> <claudeCode|codex|cursor>
    --action <install|update>

Each machine has a permission limit: the highest permission mode any thread on
that machine can run with. The default is Full Access. A thread that asks for
more resolves down to the limit, and a provider that supports no mode under the
limit cannot run there. Set it in Settings → Machines → the machine → Permission
limit; that page also shows the machine's projects, provider CLIs, update state,
and rename/remove. There is no CLI or SDK command to set it, and a paired
machine cannot set it for any machine, so a sandbox machine can stay at Full
Access while your laptop stays lower. `bb machine list --json` and `bb machine
show` report the current limit.

Updates commands

One consolidated view of bb and provider CLI updates across machines — the
CLI counterpart of Settings → Updates and the sidebar Updates badge.

  bb updates [status]                     Show bb-app and provider CLI update
                                          status for every machine
    --machine <id-or-name>                Limit to one machine
    --json                                Print the aggregate as JSON
  bb updates apply                        Run every available provider CLI
                                          install/update, one at a time
    --machine <id-or-name>                Limit to one machine
    --json                                Print per-target results as JSON

`bb updates apply` covers provider CLIs only. Update bb-app itself with the
printed upgrade command (`npx bb-app@latest`) or the desktop app's relaunch;
connected daemons then follow the server version automatically.

Machine selectors accept either an exact machine ID or an unambiguous machine
name. `--host` is an alias for `--machine`.

  bb thread spawn --project <id> --machine <id-or-name> --prompt "..."
  bb thread spawn --project <id> --new-machine <provider-id> --prompt "..."
    --machine-inputs <json>
  bb project create --name "..." --root <path> --machine <id-or-name>
  bb project source add <projectId> --machine <id-or-name> --path <path>

For thread spawning, machine targeting works with an unmanaged workspace path,
a new managed worktree, or the personal workspace. Do not combine it with an
existing environment ID: the reused environment already selects its machine.
`--new-machine` creates through a machine provider and uses its advertised
environment row. Machine inputs are persisted and readable by plugins; never
put secrets there. Store credentials in plugin settings and pass only
non-secret configuration or references.

For project creation and sources, `--root`/`--path` refers to a path on the
selected connected machine. Omit the selector to keep the existing local CLI
machine fallback (normally the primary machine). Pass `--clone` to source add
instead of `--path` to clone the project's Git remote there; `--remote-url` and
`--target-path` optionally override the clone inputs.
