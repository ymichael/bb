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

## Planning Workflow

- When the user asks to "make a plan", create or update a Markdown file under `plans/` instead of only replying with plan text.
- Use a descriptive kebab-case filename in `plans/` that matches the feature or subsystem being planned.
- Structure plan docs with these sections: `Goal`, `Scope`, `Implementation Steps`, `Validation`, and `Open Questions/Risks`.
- Delete plan files from `plans/` once they are completed, obsolete, or superseded by a newer plan.

## Build and Typecheck

- Prefer `pnpm exec turbo run typecheck --filter=@beanbag/<pkg>` for package-scoped typechecks instead of `pnpm --filter @beanbag/<pkg> typecheck`; Turbo preserves upstream `^build` dependencies and package-script runs do not.
- Do not "fix" workspace typecheck issues by pointing package `types` at `src/**` unless that source is also shipped in the packed artifact; keep package metadata valid for packed consumers.
