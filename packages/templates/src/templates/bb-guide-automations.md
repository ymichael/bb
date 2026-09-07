---
kind: instruction
title: bb Guide Automations
summary: Command reference for scheduled agent and script work.
intent: Help agents create, edit, inspect, and run automations through the CLI.
---
Automations schedule recurring or one-shot work. Agent automations run a prompt
in a thread; script automations run stored code without model usage.

  bb automation list --project <id>
  bb automation show <automationId> --project <id>
  bb automation create --project <id> --name <name> <schedule> <execution>
  bb automation update <automationId> --project <id> [changes]
  bb automation pause|resume <automationId> --project <id>
  bb automation run <automationId> --project <id>
  bb automation runs <automationId> --project <id> [--limit <count>]
  bb automation delete <automationId> --project <id> --yes

Schedules:

  --cron <expression> --timezone <iana-timezone>
  --at <iso-date-time>
  --in <duration>                 For example: 30s, 5m, 2h, or 1d

Agent execution:

  --prompt <text> --provider <id> --model <model>
  [--reasoning <none|low|medium|high|xhigh|ultracode|max|ultra>]
  [--service-tier <default|fast>]
  [--permission-mode <accept-edits|auto|full>]
  [--environment <environment-id|path> | --new-environment worktree]
  [--base-branch <branch>] [--target-thread <thread-id>]

Script execution:

  --script <inline> | --script-file <path> [--host <name-or-id>]
  [--interpreter <bash|sh|node|python3>]
  [--timeout <milliseconds>] [--env-json '{"KEY":"value"}']

`--script-file` reads the file relative to your current directory from the
thread's environment host, or from the server host outside a thread. Pass
`--host <name-or-id>` to read from another machine. The plugin stores a private
copy that runs execute. The copy is a snapshot: edits to the source file do not
apply until you run `update <automationId> --script-file <path>` again;
`create` and `update` print that exact command. `create`, `update`, and `show`
print the stored copy path on the `Script:` line (`execution.storedScriptPath`
with `--json`).

`update` can combine name, schedule, and execution changes. A complete agent
replacement supplies `--prompt`, `--provider`, and `--model`; a script
replacement supplies a complete script source. Partial updates to an existing
agent preserve omitted fields and accept `--prompt`, `--provider`, `--model`,
`--reasoning`, `--service-tier default|fast|none`, `--permission-mode`, or one
target option. Pass provider, model, reasoning, service tier, and permission
together when switching providers.

Add `--json` for machine-readable output. The JSON returned by `list` and
`show` is a union discriminated by `problem`: canonical records omit it;
degraded records use `"missing-agent-prompt"` or `"invalid-stored-data"`.
The missing-prompt variant retains the full readable automation, while the
invalid-data variant contains only its identity fields and `problem`. Use
`runs --output <runId>` to print a script run's captured output.

`list` and `show` keep damaged stored records visible as `Prompt required` or
`Invalid data` instead of failing the whole read. Opening a `Prompt required`
record in the Automations panel takes you through the standard editor, where
you can add the prompt while reviewing its other settings. The same repair is
available through the CLI:

  bb automation update <automationId> --project <id> --prompt "<prompt>"

Writes remain strict. Run, pause, and resume reject damaged records; update
succeeds only when the resulting complete record is canonical.
