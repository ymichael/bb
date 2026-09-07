# Tasks, boards, and delegation

Status: **2026-09-05: 11 passed, 2 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Tasks panel; bb tasks --help. Use a uniquely prefixed disposable task project and synthetic attachments.

Use the main skill’s isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/tasks/package.json`
- `plugins/tasks/server.ts`
- `plugins/tasks/app.tsx`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Project and organization | Create a project/prefix, folders and labels; rename/update and list them. | Task keys and organization remain consistent and unique within their defined scope. |
| Create and detail | Create a task with title/body, priority, due date, labels and attachments; reopen detail. | All supported fields persist with correct project/task identity. |
| List and board | Switch list/board, apply status/label/priority filters and move a task between offered states. | Both views show the same persisted status and filter membership. |
| Subtasks and links | Add/edit/reorder supported subtasks and inspect task/parent links. | Relationships and completion data belong to the intended task without losing body edits. |
| Comments and notifications | Add a Markdown comment with a dummy author and notify a linked test agent. | Comment history and targeted delivery match the requested action; unrelated agents are not notified. |
| Presets and delegation | Choose a preset and delegate a harmless task to a project/worktree with supported model options. | Linked worker and task state reflect actual dispatch; completion report moves through the documented review state. |
| Thread task panel and mentions | Open a task from its worker, resolve @task and a task directive card, then follow back to detail. | All links resolve the same task key and current content. |
| CLI and SDK operations | Exercise each registered tasks command group against the fixture, including list/show/update and organization operations. | Agent interfaces observe the same task state and report conflicts/invalid keys without unintended writes. |
| Close and delete | Move a fixture to a supported closed status; delete a task/project through its UI/plugin RPC confirmation, canceling one attempt first. | State/removal scope matches the action; linked thread history remains interpretable. There is no standalone tasks delete CLI command in this revision. |
| Preset management | Create/list/show/update/delete a disposable dispatch preset through tasks preset and UI, then dispatch using it. | Stored prompt/project/execution choices match actual worker creation; deleted presets cannot be selected. |
| Attach and detach existing threads | Attach an existing synthetic agent with tasks attach, inspect tasks threads, then detach it. | Both task and thread show the same linkage; detaching removes the association without deleting the conversation. |
| Attachment transport | Add/list/download/remove synthetic attachments, including a comment attachment and an explicitly selected test machine. | Downloaded bytes match; path resolution uses the invoking/selected machine and reference removal has the requested scope. |
| Demo seed and status | Inspect tasks status; run seed-demo --yes only in an empty disposable plugin store. | Status reports the plugin identity and sample data is recognizably synthetic; omitted confirmation prevents seeding. |

## Evidence and cleanup

Record each row’s UI/tool/CLI action and observed result separately. Inspect the
registered plugin command and SDK call before claiming agent parity; do not
invent a plugin CLI where the feature uses a core command instead. Preserve
failed attempts and missing prerequisites as unverified results. Restore plugin
configuration and remove only this run’s fixtures, registrations, and workers.
External account changes use authorized disposable targets.

## Maintenance notes

- Apply list filters before switching to Board. At narrow widths, horizontally scroll the board to see later status columns. The encoded ?view=board subpath is decoded by the plugin and is valid. Source: `plugins/tasks/shell/topbar.tsx:292; plugins/tasks/shell/routes.ts:28`.
- For SDK coverage, verify deleteProject(force:false) refuses a nonempty project, then delete the fixture task and empty project. deleteTask has no separate confirmation field; the UI owns confirmations where provided. Source: `plugins/tasks/shared/contract.ts:455; plugins/tasks/shared/contract.ts:492`.
