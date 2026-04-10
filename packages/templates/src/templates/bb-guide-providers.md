---
kind: instruction
title: bb Guide — Providers
summary: Command reference for discovering providers and models.
intent: Provide complete provider command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Provider commands

Providers are agent backends (e.g., codex, claude-code). Each supports different models.

  bb provider list                        List available providers
  bb provider models [providerId]         List models for a provider

Use these before spawning threads if you are unsure which provider or model to use.
When provider and model are omitted from bb thread spawn, the project's remembered
defaults apply.
