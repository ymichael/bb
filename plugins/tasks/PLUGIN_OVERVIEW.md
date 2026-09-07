Turn a plan into tracked tasks, hand each task to an agent, and see the worker's progress on the task itself.

## What you get

- A **Tasks** panel with list and board views, filters, and a detail page for each task.
- Projects with key prefixes such as `PROD-1`, nested folders, labels, priorities, due dates, subtasks, and file attachments.
- Markdown comments with a **Notify last responding agent** switch. The comment goes to the worker thread and resumes it when idle.
- A **Delegate** menu that starts a worker thread from a preset. A preset sets the provider, model, reasoning level, permission mode, and instructions.
- Live thread cards on each task and a **Task** panel action inside a thread.

## How it works

Link a tracker project to a bb project. Delegation then creates a worker thread there, attaches it to the task, and moves the task to `in_progress`. The worker receives the description, subtasks, attachments, recent comments, and a report-back contract.

Type `@` in the composer and choose **Tasks** to send a task as context. Agents see a `::task{key="PROD-1"}` card when they reference a task.

## For agents

The `bb tasks` CLI covers the full tracker: `create`, `list`, `show`, `update`, `comment`, `attachment`, `preset`, `delegate`, `attach`, `detach`, `threads`, `label`, `project`, and `folder`. Add `--json` for machine-readable output. The bundled `tasks` skill tells workers to read the task, comment at milestones, attach artifacts, and move finished work to `in_review`.

Presets are user-defined. Create at least one before you delegate.
