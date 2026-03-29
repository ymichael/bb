# `POST /open` — Open a Local Path (Host-Daemon Local API)

**Route:** `apps/host-daemon/src/local-api.ts:49`
**Contract:** `OpenRequest -> Record<string, never>` (200)
**Complexity:** Medium

## Request Body (or Params)

| Field | Required | Notes |
|---|---|---|
| `path` | Yes | `z.string().min(1)` -- path to open on the host machine. |

## Implementation Trace

1. `typedRoutes` registers `POST /open` with `openRequestSchema` for body validation.
2. The typed-routes wrapper parses the JSON body via `openRequestSchema` (`{ path: z.string().min(1) }`). On validation failure, throws a generic `Error` (no `onValidationError` override configured for the local API, so Hono's default error handling applies).
3. Handler calls `options.openPath ?? openLocalPath` with `payload.path`.
4. **Default `openLocalPath` (line 97):**
   - Selects a platform-specific command: `open` (macOS), `cmd /c start` (Windows), `xdg-open` (Linux).
   - Spawns the command with `spawn()`, `detached: true`, `stdio: "ignore"`.
   - Calls `child.unref()` so the daemon process doesn't wait for the child.
   - The function is declared `async` but never `await`s anything -- the spawn is fire-and-forget.
5. Handler `await`s the result (resolves immediately for the default impl), then returns `c.json({})`.

> **-> HTTP 200 returns here.**

## Code Reuse

- `openLocalPath` is a module-private fallback; callers can inject `options.openPath` to override.
- Uses `typedRoutes` for contract enforcement and body parsing.

## Flags

1. **No path sanitization.** The `path` field is only validated as a non-empty string. An attacker with local API access can open arbitrary paths (URLs, executables, etc.) via `open`/`xdg-open`. Since the API is bound to `localhost` only, the blast radius is limited to local processes, but there is no allowlist or validation that the path is a file/directory rather than a URL or scheme handler.
2. **Spawn errors are silently lost.** `openLocalPath` spawns a detached child and unrefs it. If the spawn itself fails (e.g., `xdg-open` not installed), the error is not caught or reported to the caller. The `async` declaration on `openLocalPath` is misleading since it never awaits.
3. **No error response contract.** Validation errors from Zod throw a plain `Error`, which Hono will convert to a 500. There is no `onError` handler or structured error response defined for the local API.

## Usages

| Caller | Location | Purpose |
|---|---|---|
| `openPath` | `apps/app/src/lib/api-host-daemon.ts:37` | Calls `daemon.open.$post({ json: { path } })` to open a local path via the daemon |
| `useHostDaemon` hook | `apps/app/src/hooks/useHostDaemon.ts:41` | Wraps `daemonOpenPath(port, path)` into a stable callback; returns `null` if no daemon |
| `ThreadDetailView` | `apps/app/src/views/ThreadDetailView.tsx:376,1228` | Destructures `openPath` from `useHostDaemon()`; calls it to open a file path when the user clicks an environment path link |
| `createHostDaemonLocalClient` | `packages/host-daemon-contract/src/local.ts:64` | Typed Hono client factory; defines the `/open` route type |
| local-api test | `apps/host-daemon/src/local-api.test.ts:60` | Integration test that verifies `POST /open` delegates to the `openPath` callback |
| _(no CLI callers)_ | -- | The CLI does not call this route |

---

## Review Comments

<!-- Leave comments, questions, or follow-ups below. Delete this file if no action needed. -->