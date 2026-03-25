# CLI Quality Improvements

Actionable plan for `apps/cli` code quality, maintainability, and consistency. Can run concurrently with app improvements.

**Important:** Line numbers reference the code as of 2026-03-25. Grep for identifiers rather than trusting line numbers, as earlier steps may shift them.

---

## 1. Split thread.ts (1,180 lines)

The largest CLI file has 12 commands, 17 non-exported helpers, 4 table/print functions, 2 error classes, and 6 parsers in one file.

### Target structure

```
apps/cli/src/commands/thread/
  index.ts              — registerThreadCommands(program, getUrl), delegates to submodules
  spawn.ts              — thread spawn + buildSpawnEnvironment, looksLikePath, requireHostId
  wait.ts               — thread wait + ThreadWaitTimeoutError + ThreadWaitUnreachableError + polling
  show.ts               — thread show + status display + log + output
  actions.ts            — tell, stop, archive, unarchive, delete, rename, set-execution-options
  list.ts               — thread list + printThreadTable
  helpers.ts            — shared types, constants, parsers, statusText
```

### Key design decisions

**`getUrl()` propagation:** Each submodule exports a `register*(parent: Command, getUrl: () => string)` function. `index.ts` calls each one:

```typescript
// thread/index.ts
export function registerThreadCommands(program: Command, getUrl: () => string) {
  const thread = program.command("thread").description("...");
  registerSpawnCommand(thread, getUrl);
  registerWaitCommand(thread, getUrl);
  registerShowCommand(thread, getUrl);
  registerActionsCommands(thread, getUrl);
  registerListCommand(thread, getUrl);
}
```

**`statusText` is shared across spawn, list, and show.** It must go in `helpers.ts` and be imported by all three.

**`postThreadMessage` closure:** Currently defined inside `registerThreadCommands` because it captures `getUrl()`. In the split, it moves to `actions.ts` and receives `getUrl` as a parameter.

**`assertNever` import:** Used by `statusText` and `getThreadStopBlockedReason`. After the split, both `helpers.ts` and `actions.ts` will import it from `../../assert-never.js`.

### Shared types/constants to extract into `helpers.ts`

```typescript
// Types
type ThreadStatusEventMode = "summary" | "raw";
type ThreadWaitTarget = { kind: "status"; ... } | { kind: "event"; ... };

// Constants
const THREAD_WAIT_EXIT_CODE_TIMEOUT = 2;
const THREAD_WAIT_EXIT_CODE_INVALID_REQUEST = 3;
const THREAD_WAIT_EXIT_CODE_UNREACHABLE = 4;
const DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS = 30;
const DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS = 250;

// Functions shared across submodules
function statusText(status: ThreadStatus): string { ... }
function parseRecentEventsCount(value: string): number { ... }
function parseThreadStatusEventMode(value: string): ThreadStatusEventMode { ... }
function parseThreadWaitTimeoutSeconds(value: string): number { ... }
function parseThreadWaitPollIntervalMs(value: string): number { ... }
```

### Validation
- `pnpm exec turbo run typecheck --filter=@bb/cli`
- `pnpm exec turbo run test --filter=@bb/cli`
- Manual: run each thread subcommand (`spawn`, `list`, `show`, `wait`, `tell`, `stop`, `archive`, `unarchive`, `delete`, `log`, `output`, `update`) and verify it works

---

## 2. Extract shared table renderer

Four command files duplicate the same table rendering pattern: calculate max column widths, pad strings, print header + separator + rows.

### Current duplication

| File | Function | Lines |
|------|----------|-------|
| `commands/project.ts` | `printProjectTable()` | 173-200 |
| `commands/provider.ts` | `printProviderTable()` + `printModelTable()` | 57-107 |
| `commands/manager.ts` | `printManagerTable()` + `printManagedThreadTable()` | 182-241 |
| `commands/thread.ts` | `printThreadTable()` | 1053-1089 |

### Target

Create `src/table.ts`:

```typescript
interface TableColumn<T> {
  header: string;
  value: (item: T) => string;
  minWidth?: number;  // minimum column width (default: header.length)
  align?: "left" | "right";
}

interface PrintTableOptions {
  /** Print blank lines before and after the table (default: true — matches current behavior) */
  blankLinePadding?: boolean;
  /** Message to print when rows is empty (default: no output) */
  emptyMessage?: string;
  /** Prefix line to print before the table header */
  prefix?: string;
}

export function printTable<T>(
  columns: TableColumn<T>[],
  rows: T[],
  options?: PrintTableOptions,
): void {
  if (options?.prefix) console.log(options.prefix);

  if (rows.length === 0) {
    if (options?.emptyMessage) console.log(options.emptyMessage);
    return;
  }

  const widths = columns.map((col) =>
    Math.max(col.minWidth ?? col.header.length, ...rows.map((row) => col.value(row).length)),
  );

  const pad = (text: string, width: number, align: "left" | "right" = "left") =>
    align === "right" ? text.padStart(width) : text.padEnd(width);

  if (options?.blankLinePadding !== false) console.log("");

  const headerLine = columns.map((col, i) => pad(col.header, widths[i], col.align)).join("  ");
  console.log(headerLine);
  console.log("-".repeat(headerLine.length));

  for (const row of rows) {
    console.log(
      columns.map((col, i) => pad(col.value(row), widths[i], col.align)).join("  "),
    );
  }

  if (options?.blankLinePadding !== false) console.log("");
}
```

### Notes for migration

- Read each existing table function before migrating — the proposed interface above handles the key variations (minWidth, prefix, emptyMessage, padding), but verify column headers and content match exactly.
- `printProjectTable` takes `localHostId` as a second arg to resolve the local source path — capture it in the `value` closure.
- `printModelTable` prints a prefix line (`"Models for ${providerId}:"`) — use the `prefix` option.
- `printManagedThreadTable` has custom empty handling (`"Managed threads:\n  None"`) — use the `emptyMessage` option.
- Current code uses minimum widths like `Math.max(4, ...)` — use the `minWidth` column option.

### Validation
- Run `bb project list`, `bb provider list`, `bb thread list`, `bb manager list` and verify output matches current formatting exactly (including blank lines and alignment)

---

## 3. Extract error handling wrapper

Every command action (28 occurrences across all command files including `environment.ts` and `server.ts`) wraps its body in identical try/catch:

```typescript
.action(async (id, opts) => {
  try {
    // ... command logic ...
  } catch (err) {
    console.error(`Error: ${getErrorMessage(err)}`);
    process.exit(1);
  }
});
```

### Target

Create `src/action.ts`:

```typescript
import { getErrorMessage } from "./commands/helpers.js";

export function action<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`Error: ${getErrorMessage(err)}`);
      process.exit(1);
    }
  };
}
```

### Usage

```typescript
import { action } from "../action.js";

.action(action(async (id, opts) => {
  const client = createClient(opts);
  const thread = await unwrap(client.getThread(id));
  // ...
}));
```

### Exceptions

**`thread wait`** uses custom exit codes (2, 3, 4). Keep its own try/catch. Also note: its error handling uses fragile string matching on `err.message.startsWith("Provide exactly one of")` and `err.message.startsWith("Invalid thread status")` (around line 361). Consider replacing these with typed error classes (`ThreadWaitInvalidRequestError`) for robustness — but this is optional cleanup, not blocking.

### Scope

All command files: `thread.ts` (or split submodules after step 1), `project.ts`, `provider.ts`, `manager.ts`, `environment.ts`, `server.ts`, `status.ts`.

### Validation
- `pnpm exec turbo run test --filter=@bb/cli`
- Manual: trigger an error (e.g., invalid thread ID) and verify error output is unchanged

---

## 4. Fix misleading function names

### `commands/helpers.ts`

| Current | Issue | Rename to |
|---------|-------|-----------|
| `resolveThreadIdOrSelf(id, self)` | Throws on invalid input — "resolve" implies lookup | `requireThreadIdOrSelf(id, self)` |
| `resolveThreadIdWithLabel(id, opts)` | Throws when context missing | `requireThreadIdWithLabel(id, opts)` |
| `resolveProjectIdWithLabel(opts)` | Throws when context missing | `requireProjectIdWithLabel(opts)` |

### `context-env.ts`

| Current | Issue | Rename to |
|---------|-------|-----------|
| `normalizeValue(v)` | Too generic — trims and converts empty to undefined | `trimToUndefined(v)` |

Note: `resolveProjectId()`, `resolveThreadId()`, `resolveEnvironmentId()` in `context-env.ts` are fine — they return `undefined` on failure, which matches "resolve" semantics. The `require*` variants already exist and correctly throw.

### Validation
- Grep for all callsites of renamed functions, update them
- `pnpm exec turbo run typecheck --filter=@bb/cli`
- `pnpm exec turbo run test --filter=@bb/cli`

---

## 5. Add error context to CLI error messages

Currently all errors show generic "Error: <message>". Add operation context where the generic message is unhelpful.

### Approach

Targeted improvements only — not blanket prefixing. Only add context for API errors where the user wouldn't know what operation failed.

### Priority targets

- `thread spawn` — "Failed to create thread: ..."
- `thread archive` / `thread delete` — "Failed to archive thread <id>: ..."
- `environment commit` / `environment promote` — "Failed to commit in environment <id>: ..."

These can be simple wrapping: catch the error in the action body, add context, and re-throw so the `action()` wrapper from step 3 formats it.

### Validation
- Manual: trigger failures and verify messages are helpful

---

## 6. Shared package cleanup

These items affect `packages/` (shared code), not `apps/cli/` specifically. Grouped here for convenience but they're independent of the CLI-specific work above.

### Update stale "env-daemon" comments in agent-runtime

8 comments reference "env-daemon" instead of "host-daemon":
- `packages/agent-runtime/src/claude-code/bridge/bridge.ts:7`
- `packages/agent-runtime/src/claude-code/adapter.ts:370`
- `packages/agent-runtime/src/codex/adapter.ts:62`
- `packages/agent-runtime/src/shared/bridge-tool-calls.ts:5, 7, 15, 43`
- `packages/agent-runtime/src/pi/bridge/sdk-session.ts:101`

Find-replace "env-daemon" → "host-daemon" in comments only.

### Delete dead package

Remove `packages/env-daemon-contract/` directory entirely. Verify nothing imports it first:
```bash
grep -r "@bb/env-daemon-contract" --include="*.ts" --include="*.json" .
```

Also remove from the root `pnpm-workspace.yaml` if listed there.

### ANSI formatting (optional, low priority)

`packages/core-ui/src/format-timeline-text.ts:22-37` has manual ANSI escape codes. This is only 15 lines and already handles the color toggle correctly. Replacing with `colorette` is optional — the benefit is marginal.

---

## Execution order

Steps 1-4 are independent. Step 5 pairs naturally with step 3 (error wrapper). Step 6 is independent of everything.

```
1 (split thread.ts)     ─────────┐
2 (shared table renderer)        │
3 (error wrapper) → 5 (context)  ├→ done
4 (rename functions)             │
6 (shared package cleanup) ──────┘
```
