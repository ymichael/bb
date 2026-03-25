# Codebase Guidelines

## Type Safety

- No `unknown`, no `as X` casts unless the type is genuinely unknowable (e.g., freeform tool input). Our boundaries validate and parse; everything inside the system is strongly typed.
- Never inline types in function signatures. Define them in the appropriate shared package.
- When renaming a domain type, search project-wide for the old name in variables, functions, files, query keys, and constants — not just type references. TypeScript only validates types; stale identifiers compile fine. Rename everything in the same commit.

## Code Quality

- Prefer maintainability and readability over speed. No one-off hacks — ask whether it would pass code review. We are never in a rush.
- Reuse before duplicating. If a pattern exists N times, extract a shared component or utility so consistency is structural, not aspirational. When fixing a bug, check whether the same pattern is repeated elsewhere.
- Separate concerns. When a concern is better handled by a well-known, battle-tested library, install and use it.
- Prefer a single object argument over multiple positional arguments, especially when a function takes 3+ parameters of the same type.
- No inline dynamic imports unless for genuine performance reasons. If it's working around a circular dependency, fix the dependency graph instead.

## UI Consistency

- Reuse shared primitives before introducing view-local class bundles (page shell, detail card/rows, collapsible headers, status pill).
- Avoid arbitrary `text-[Npx]` classes; prefer sanctioned typography tokens.
- Keep one canonical rendering path per concept; remove or deprecate parallel/legacy surfaces.

## Build and Typecheck

- Always use Turbo: `pnpm exec turbo run <task> --filter=@bb/<pkg>`. Turbo ensures upstream `^build` dependencies run first. Running package scripts directly (e.g., `pnpm --filter @bb/foo test`) skips these and will often fail.

## Testing

- Quality over quantity. Tests that pass when the package is broken are worse than no tests — they create false confidence. Every test should be able to catch a real bug.
- Test real behavior and outcomes — resulting state, return values, persisted data, response bodies. Not call sequences.
- Never mock the database. Use in-memory SQLite via `createConnection(":memory:")` + `migrate(db)`.
- Almost never mock our own code. Mock only at true external boundaries: network calls to third-party providers, timers, and similar unpredictable externals.
- Never mock the module under test or its private methods.

## Debugging

- Don't assume — instrument and observe. Add logging, read logs, inspect the database, repeat.
- Prefer server API, CLI, direct SQL queries, or log files over browser-based debugging. Use the browser only for browser-specific issues.
- Work methodically. Everything in this app is traceable; there is no need to guess.

## Planning Workflow

- When asked to "make a plan", create or update a Markdown file under `plans/`.
- Plans must have clear exit criteria and concrete validation instructions.
- Delete plan files once completed or superseded.
