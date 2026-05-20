---
kind: system-message
title: Manager Preferences Updated Snapshot
summary: Manager notification that PREFERENCES.md changed since it was last shown.
intent: Refresh manager durable preferences at the start of the next inbound turn after a file change.
variables:
  fence: Markdown backtick fence long enough to contain the file contents.
  preferencesContent: Verbatim PREFERENCES.md contents.
---

[bb system]

PREFERENCES.md has been updated. New contents:

{{fence}}md
{{preferencesContent}}
{{fence}}
