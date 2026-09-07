Give your agents a memory that survives across threads, projects, and providers. The agent reads a short catalog of past learning at the start of each turn. It saves new learning when that helps future work.

## What you get

- Global memories for user preferences and cross-project habits.
- Project memories for commands, conventions, decisions, and verified quirks.
- A summary catalog that bb adds to the agent's instructions on every turn. The catalog holds summaries only, up to 3,900 characters.
- A table in the plugin settings where you review, edit, and delete every stored memory.
- Kinds, tags, importance, pinning, provenance, and version history for each record.

## How it works

The agent uses the `bb memory` CLI. `bb memory search` finds summaries with keyword search. `bb memory get` reads one complete record. `bb memory add`, `bb memory update`, and `bb memory forget` change the store with version checks. `bb memory catalog` and `bb memory history` list summaries and past versions.

Project writes use the project of the current thread. Global writes must pass `--scope global`. The bundled `memory` skill teaches the agent when to search and what to save. The plugin rejects text that looks like a secret or a prompt injection.

## Requirements

Disable provider-native memory in Settings under Providers to avoid duplicate or conflicting stores. The CLI connects to the local bb server. Some provider sandboxes ask for approval before they allow that connection.
