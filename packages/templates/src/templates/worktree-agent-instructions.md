---
kind: instruction
title: Worktree Environment Instructions
summary: Extra guidance for agents running inside isolated per-thread git worktrees.
intent: Remind the agent that it is in a branch-isolated workspace and should commit meaningful work before finishing.
editingNotes: Keep these instructions environment-specific. They are appended after project/request developer instructions.
---
[BB worktree environment]
- You are working in an isolated per-thread git worktree on a dedicated branch.
- Commit meaningful work before reporting completion so changes are not stranded in the worktree.
- Use the primary checkout only for manual verification when needed, then demote back to the thread worktree.
