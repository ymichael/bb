# Codebase Guidelines

## Typing and Unions

- Classify string domains before refactoring: `closed_internal` (Beanbag-owned) vs `open_external` (provider/runtime-owned).
- For `closed_internal` unions, require exhaustive `switch` handling with `assertNever`; avoid permissive `default` branches.
- Keep tolerant fallbacks only for `open_external` values, with an explicit comment that unknown values are intentional.
- Prefer typed decode/guard helpers over repeated inline casts like `as Record<string, unknown>`.
- For known union keys, use `Record<MyUnion, ...>` instead of `Record<string, ...>`.
- Do not modify generated code under `packages/core/src/generated/**`.

## UI Consistency

- Reuse shared primitives before introducing view-local class bundles (for example: page shell, detail card/rows, collapsible headers, status pill).
- Keep one canonical message rendering path; remove or clearly deprecate parallel/legacy surfaces.
- Centralize repeated formatting behavior (for example relative time) in shared web utilities.
- Avoid arbitrary `text-[Npx]` classes; prefer sanctioned typography tokens/utilities.
- Keep theme typography tokens consistent across light/dark modes unless an intentional divergence is documented.

## Debugging Data Flows

- When investigating entity/state issues from a route like `http://localhost:5173/projects/<projectId>/threads/<threadId>`, prefer inspecting data through the daemon HTTP API or CLI first.
- For data-only debugging, prefer daemon API/CLI over `curl` + browser workflows; it is faster to inspect entities directly without frontend/UI noise.
- Use direct SQLite queries as an alternative fast path, especially when you need to validate persisted state or compare raw stored values against daemon/API responses.
