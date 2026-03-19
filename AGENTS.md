# Codebase Guidelines

## Typing and Unions

- Classify string domains before refactoring: `closed_internal` (BB-owned) vs `open_external` (provider/runtime-owned).
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

- When investigating entity/state issues from a route like `http://localhost:5173/projects/<projectId>/threads/<threadId>`, prefer inspecting data through the server HTTP API or CLI first.
- For data-only debugging, prefer server API/CLI over `curl` + browser workflows; it is faster to inspect entities directly without frontend/UI noise.
- Use direct SQLite queries as an alternative fast path, especially when you need to validate persisted state or compare raw stored values against server/API responses.

## Planning Workflow

- When the user asks to "make a plan", create or update a Markdown file under `plans/` instead of only replying with plan text.
- Use a descriptive kebab-case filename in `plans/` that matches the feature or subsystem being planned.
- Structure plan docs with these sections: `Goal`, `Scope`, `Implementation Steps`, `Validation`, and `Open Questions/Risks`.
- Delete plan files from `plans/` once they are completed, obsolete, or superseded by a newer plan.

## Build and Typecheck

- Prefer `pnpm exec turbo run typecheck --filter=@bb/<pkg>` for package-scoped typechecks instead of `pnpm --filter @bb/<pkg> typecheck`; Turbo preserves upstream `^build` dependencies and package-script runs do not.
- Do not "fix" workspace typecheck issues by pointing package `types` at `src/**` unless that source is also shipped in the packed artifact; keep package metadata valid for packed consumers.

## Testing / QA

### Mocking Principles

Mock at boundaries, not inside the system.

**Run the real thing when it's cheap:**
- SQLite/DB operations — use in-memory DB via `createConnection(":memory:")` + `migrate(db)`. This catches real FK violations, constraint issues, and schema mismatches that mock repos silently pass.
- Pure functions, helpers, type transformations, validators, serializers.

**Mock when the real thing is expensive, slow, or has side effects:**
- External providers (Codex, OpenAI) — network calls, cost, flakiness.
- File system operations that create/delete real files.
- Process spawning (`child_process.spawn`).
- Network listeners (HTTP servers, WebSocket).
- Timers and delays (use `vi.useFakeTimers`).

**Never mock:**
- The module under test.
- Private methods of the class being tested — test through the public API.
- Database repositories — use real in-memory SQLite instead.

**Assert outcomes, not call sequences:**
- Good: check resulting state, return values, persisted data, HTTP response bodies.
- Bad: check that internal method A called internal method B with args C.
- Prefer `expect(repo.getById(id)?.status).toBe("idle")` over `expect(repo.update).toHaveBeenCalledWith(id, { status: "idle" })`.

### QA Passes

- For server or environment-daemon changes, run QA passes before wrapping up. Use the surface-based QA docs in `qa/` to pick the relevant pass instead of defaulting to one monolithic full-server checklist.
- Start with `qa/README.md`; it is the canonical entrypoint for "what QA should I run for this change?" and for mapping informal requests like "run QA for the Pi provider" or "run e2e QA and any relevant QA for the code we touched."
- Prefer the owning surface for the behavior you changed: `qa/server/`, `qa/env-daemon/`, `qa/providers/`, `qa/cli/`, `qa/environments/`, `qa/product/`, and `qa/e2e/`. Add `qa/e2e/smoke` for cross-cutting or user-visible changes.
- Use the checked-in package scripts and aliases in `package.json` as the source of truth for current automation entrypoints, including `qa:e2e:smoke`, `qa:providers:smoke*`, and `qa:env-daemon:recovery*`. When asked to do provider-facing QA, default to the real provider unless the owning pass explicitly depends on fake-provider control hooks.
- Use the fast e2e suite in `apps/server/src/__tests__/e2e/` for targeted scenario work. Treat real-provider coverage as the default QA path for provider-facing behavior; use fake-provider coverage only when you specifically need deterministic fake-codex control hooks.
- Use `qa/shared/standalone-workflow.md` for the shared standalone setup and relaunch procedure that supports the owned surface docs.
- For package-scoped validation, prefer `pnpm exec turbo run typecheck --filter=@bb/<pkg>`.
