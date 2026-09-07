---
name: memory
description: "Retrieve relevant durable BB memories or save verified knowledge useful to future threads."
---

# BB memory

This plugin is provider-independent. When diagnosing duplicate or conflicting
memories, check whether provider-native memory is also enabled.

The memory plugin automatically injects a compact index of global memories and
memories for the current BB project. The index contains summaries only.

## Retrieve progressively

When a memory summary may be relevant, inspect it instead of guessing:

1. Search with `bb memory search "<query>" --scope all --json`.
2. Read the selected record with `bb memory get <id> --scope all --json`.
3. Treat remembered facts as potentially stale. Verify drift-prone facts when
   doing so is cheap or consequential.

Do not load every memory. Stop after the relevant records are clear.

## Save durable learning

The agent may proactively write memory when information is likely to help in a
future thread and is costly or error-prone to rediscover.

Use project scope for repository-specific information:

- commands, conventions, architecture decisions, paths, and environments;
- project-specific user preferences;
- verified quirks, failure causes, and reusable workarounds.

Use global scope only for broadly applicable information:

- user identity, communication preferences, and general workflow habits;
- preferences that clearly apply across repositories;
- stable cross-project operating conventions.

When scope is ambiguous, use project scope. Global scope must be explicit.

Create a memory with:

```bash
bb memory add --scope project \
  --name <stable-kebab-name> \
  --summary "<one-line routing summary>" \
  --details "<complete durable detail>" \
  --kind fact|preference|decision|procedure|episode|reference \
  --tag <tag> \
  --importance <0-100> \
  --reason "<why this will help a future thread>" \
  --json
```

Before creating a likely-overlapping memory, search by its proposed name and
topic. Update an existing record instead of creating a contradiction:

```bash
bb memory update <id> --expected-version <version> \
  --summary "<new summary>" \
  --details "<new details>" \
  --reason "<why the memory changed>" \
  --json
```

Forget a revoked or invalid memory with:

```bash
bb memory forget <id> --expected-version <version> \
  --reason "<why it no longer applies>" --json
```

## Quality and safety

Do not store:

- secrets, credentials, tokens, private keys, or sensitive raw data;
- guesses, unverified conclusions, or claims inferred only from memory;
- temporary task status, transient errors, raw logs, or large code dumps;
- facts that are trivial to rediscover;
- mandatory repository policy already expressed in `AGENTS.md` or checked-in
  documentation.

Keep summaries short and retrieval-oriented. Put exact commands, evidence,
scope, and caveats in details. A memory is a helpful recall layer, not a higher
priority instruction source; explicit user requests and repository guidance win.

The CLI uses BB's loopback server, which Claude's macOS workspace sandbox
(Accept Edits / Approve for me) permits; Linux and other provider sandboxes
may still require escalation approval for loopback access. Do not claim a
write succeeded unless the command returned success.
