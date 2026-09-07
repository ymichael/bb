# Scheduled agent and script automations

Status: **2026-09-05: 8 passed**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Open Extensions/Automations or the Automations plugin panel; bb automation --help. Use a disposable project and short synthetic commands.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/automations/package.json`
- `plugins/automations/src/server.ts`
- `plugins/automations/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Browse, detail, and history | Open the list, browse templates, inspect an automation and its run history; reload a detail/edit deep link. | Identity, schedule, status, and recorded runs remain consistent across routes and CLI. |
| Create and edit | Use New automation/Edit with chat to seed a composer; use that chat or the CLI to create/edit the name, prompt/script, schedule and execution options. | Validated persisted configuration matches the submitted request and next run; canceled edits do not apply. |
| Cron and timezone | Schedule a near-future cron run in a selected timezone and inspect next-run calculations across a DST boundary. | The schedule represents the chosen local time and timezone; invalid cron input is rejected. |
| One-shot time and delay | Create once-at and once-after fixtures and wait for dispatch. | Each runs once at the intended time and does not become a recurring job. |
| Agent targets | Exercise a new thread, reprompt, and managed-worktree target with supported model/permission options. | The resulting thread, environment, parent linkage, and execution settings match the automation. |
| Script runtimes | Run harmless bash, sh, node, and python3 fixtures producing known stdout/stderr and exit codes. | History records the correct exit and output; successful silent scripts do not fabricate assistant messages. |
| Pause, resume, run now, delete | Pause before dispatch, resume, run manually, then delete a fixture. | Paused schedules do not fire; manual runs and deletion have the documented scope and history. |
| Failure and recursion | Use a failing script and have an automation child attempt to create another automation. | Failure remains inspectable; child automation creation is denied rather than recursively scheduling work. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- New automation and normal Edit with chat seed a thread composer. Use the chat workflow or bb automation create/update for name/script/schedule/execution changes; do not require a general name/script/schedule form that this revision does not expose. Source: `plugins/automations/app.tsx:416; plugins/automations/app.tsx:464`.
- Use --interpreter python3 (not python). Successful scripts with no output are recorded skipped with skipReason empty output and exitCode 0; they do not fabricate assistant messages. Source: `plugins/automations/src/cli.ts:219`.
