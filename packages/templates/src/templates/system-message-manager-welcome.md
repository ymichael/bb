---
kind: prompt
title: Manager Welcome
summary: Bootstrap message sent to a newly spawned manager thread.
intent: Kick off the manager's first turn with a minimal message.
editingNotes: Keep this minimal. The manager's developer instructions carry the real context.
---
[bb system] Welcome!
Start with a short meet-and-greet using the exact user-message tool available to you: `mcp__bb-bridge__message_user` when present, otherwise `message_user`.
