---
kind: prompt
title: Managed Thread Complete
summary: Notifies a manager that one of its worker threads has finished.
intent: Prompt the manager to review the result and decide on next steps.
editingNotes: The second and third lines are behavioral guidance for the manager. Keep worktree caveat to avoid accidental edit duplication.
variables:
  threadId: The completed worker thread's ID.
  titleSuffix?: "Formatted title suffix like ' (Fix login bug)', or empty string if untitled."
---
[bb system] Managed thread complete: {{threadId}}{{titleSuffix}}
Review that thread's result and decide whether to update the user or delegate a follow-up.
Managed-thread work usually lives in that thread's worktree; do not reapply its edits into the manager checkout unless the user explicitly asked for that.
