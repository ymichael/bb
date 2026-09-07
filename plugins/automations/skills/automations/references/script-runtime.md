# Automation script runtime

Read this file before you use a script file or depend on the script runtime.

## Stored script files

`--script-file` reads a file through the host file API. A relative path starts
at the current directory.

Inside a thread, the command reads from the thread environment host. Outside a
thread, it reads from the server host. Use `--host <name-or-id>` for another
machine.

The plugin stores a private copy under
`<data dir>/plugins/automations/scripts/<automationId>/`. Runs use this copy.
Source edits do not apply until an update copies the file again.

The create and update commands print the exact refresh command. The create,
update, and show commands print the stored path on the `Script:` line. JSON
output returns it as `execution.storedScriptPath`.

## Variables and CLI lookup

The plugin injects these variables:

```text
BB_SERVER_URL          The BB server API base URL
BB_PROJECT_ID          The automation project
BB_AUTOMATION_ID       The automation ID
BB_AUTOMATION_RUN_ID   The run ID
BB_CLI                 The absolute BB CLI path, when available
```

The plugin does not inject `BB_ENVIRONMENT_ID` or `BB_HOST_DAEMON_PORT`.

The plugin resolves `bb` from `BB_CLI`, `BB_CLI_DIR`, `PATH`, and common macOS
install paths. It adds the selected directory to `PATH`.

If the plugin cannot find `bb`, the script still starts. Its output starts with
a `[bb] warning:` line. A later `bb` call then fails normally.

## Execution safety

- An automation has at most one active run. A duplicate tick or manual request
  uses the active run.
- Failed recurring runs retry after 30 seconds and then 60 seconds. The third
  consecutive failure pauses the automation.
- A successful or skipped run clears the failure count. A resume command also
  clears the count.
- An unavailable target thread disables every enabled automation that targets
  the thread immediately. This path does not retry and does not use the failure
  count. The plugin treats a thread as unavailable when it is missing, deleted,
  archived, or cannot accept a run.
- A timeout or output limit stops the process group. On Windows, it stops the
  direct child.
- Startup settles runs interrupted by a server restart or plugin reload.
  Script runs without a process become skipped.
- Agent runs without a thread become skipped. Other agent runs follow their
  thread state.

An exit-zero run with no output is a silent skipped tick. A final non-empty
line of `{"wakeAgent": false}` has the same result.
