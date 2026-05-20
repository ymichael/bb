---
kind: system-message
title: Manager Preferences Warning
summary: Manager warning that PREFERENCES.md exists but cannot be inlined.
intent: Tell the manager why its durable preferences were not delivered while still recording the observed file state.
variables:
  reason: Human-readable reason the file was not delivered.
---

[bb system]

PREFERENCES.md was not delivered. {{reason}}
