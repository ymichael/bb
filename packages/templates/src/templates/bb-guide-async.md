---
kind: instruction
title: bb Guide - Async
summary: Scheduled nudge reference for ASYNC.md.
intent: Explain how to define scheduled nudges for manager threads.
editingNotes: Keep this as the canonical ASYNC.md syntax reference. Manager prompts should point here instead of inlining schedule syntax.
---
Async scheduled nudges

Use `ASYNC.md` in thread storage when the system should wake a manager thread
later for reminders, recurring check-ins, or follow-up work.

`ASYNC.md` is Markdown with YAML frontmatter:

```yaml
---
timezone: America/Los_Angeles
schedules:
  - name: daily-recap
    cron: "0 8 * * 1-5"
  - name: deploy-check
    cron: "0 */2 * * *"
    timezone: UTC
---
```

Each schedule has a matching `## <name>` section in the body with instructions
for your future self. The top-level `timezone` defaults to UTC; each schedule
can override it.

For one-off reminders like "in 10 minutes", encode the next daily occurrence
and note in the body to remove the schedule after it fires once.

Keep schedule `name` values stable. The server syncs entries by name, so
renaming one creates a new schedule rather than editing it.

Constraints:

- No more than 20 schedules.
- No interval shorter than 5 minutes.
- The cron month field must stay `*`.

When a scheduled nudge arrives, read the matching section in `ASYNC.md` and
decide whether there is real work to do. Only message the user when the nudge
produced something useful. Remove schedules that are no longer needed.
