---
name: bb-cli
description: "Inspect or manage BB state with the bb CLI; use for BB commands and configuration."
---

# BB CLI

Use bb for BB state and actions. Inspect context when the target project, host,
workspace, or execution selection is not already established.

## Start with context

```sh
bb status --json
```

Use JSON when command output controls later work. Use human output for quick
inspection.

Run `bb --version` for the CLI version. Use `bb --help` or `bb help [command]`
for help. Run bb guide for the system overview. Run bb guide <chapter> for one
area. Use bb <group> --help for current flags and defaults.

A standalone CLI targets http://127.0.0.1:38886. Use BB_SERVER_URL and
BB_HOST_DAEMON_PORT only for an intentional non-default target.

## Read only the relevant reference

- Read references/command-index.md to find the exact core command path. Use
  live help for current flags and defaults.
- Read references/configuration.md for settings, agent instructions, skills,
  remote clients, and environment setup scripts.
- Read references/thread-creation.md before you spawn or fork threads, create
  projects, select machines, or create environments.
- Read references/thread-operation.md for messages, queues, interactions,
  panes, terminals, inspection, and long-running commands.
- Read references/failure-recovery.md when a thread fails, stops, or needs plan
  or goal recovery.
- Read references/theme-commands.md for palette and favicon commands. Read
  references/theming.md before you create or edit theme CSS.
- Read references/plugins.md for plugin discovery, install, build, update,
  configuration, runtime, and contributed commands.
- Read references/app-settings.md for complete app setting keys and effects.

## Command habits

- Resolve names and IDs with a list or show command before mutation.
- Pass an explicit project when a command can act across projects.
- Pass an environment or machine selector when the default host is uncertain.
- Query provider models on the machine that will run the thread.
- Prefer non-interactive commands and machine-readable output for automation.
- Pass `--yes` for a confirmed destructive command in a non-interactive shell.
- Treat plugin commands as normal top-level commands after installation.

- Inspect real status, logs, API results, or diffs instead of assumptions.
- Keep file paths on the machine that owns the selected workspace.

## Common checks

```sh
bb project list --json
bb machine list --json
bb provider list --environment "$BB_ENVIRONMENT_ID" --json
bb thread show "$BB_THREAD_ID" --json
bb environment status "$BB_ENVIRONMENT_ID" --json
bb plugin list --json
bb skill list --environment "$BB_ENVIRONMENT_ID" --json
```

## Completion

Confirm the command result and any affected thread, environment, plugin, or
remote service. Report the stable ID or URL that the user needs next.

## Plugin configuration

Use `bb plugin config <id>` to inspect the plugin’s configuration and
`bb plugin config <id> set <key> <value>` to change it. Read the plugin’s own
skill for its commands, configuration meanings, and operating constraints.
Discover contributed command paths through `bb plugin list`, the generated
`plugin-commands` skill, or `bb plugin run <id> --help`.

Keep this skill and its references focused on core BB commands. Plugin-specific
behavior belongs in the owning plugin’s `skills/` directory, including built-in
plugins; do not add plugin command manuals here.

## Built-in browser control

Use `bb browser instances --host <host-id> --json` to discover a desktop. Commands `tabs`, `create`, `acquire`, `connection`, `release`, `reveal`, `capture`, `close`, and `watch` require explicit `--host`, `--instance`, `--generation`, and `--thread`. See `bb guide browser` and `bb browser --help` for flags. New tabs use separate automation profiles; personal-tab control needs an explicit handoff. Connection credentials are written with `connection --output <new-file>` and work only on the browser host; keep them out of chat and public port shares.
