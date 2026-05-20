---
kind: system-message
title: Manager Preferences Current Snapshot
summary: Initial manager delivery of the current PREFERENCES.md contents.
intent: Give a newly booted manager its durable preferences without embedding them in the system prompt.
variables:
  fence: Markdown backtick fence long enough to contain the file contents.
  preferencesContent: Verbatim PREFERENCES.md contents.
---

[bb system]

Current PREFERENCES.md contents:

{{fence}}md
{{preferencesContent}}
{{fence}}
