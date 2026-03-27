# Phase 8: `@bb/sandbox-host` (real implementation)

Flesh out the stub from Phase 5 with real E2B implementation. Adapted from [terragon-oss](https://github.com/terragon-labs/terragon-oss) to bb's architecture (WebSocket sessions, command protocol, workspace provisioning).

**Each sub-phase is a separate commit.**

**Ordering principle:** Prove E2B plumbing works with trivial payloads first. Daemon bundling is the hardest part (bridge binaries for claude-code and pi must be separately bundled alongside the daemon — they're spawned as child Node.js processes from disk, not inlined). Defer it until everything else works.

**Prerequisites:** `E2B_API_KEY` is set in the project `.env` file and verified working (sandbox create/command/destroy cycle confirmed 2026-03-26). The server config already reads `E2B_API_KEY` and `E2B_TEMPLATE` via `@bb/config/server`. Rename these to use the standard `E2B_API_KEY` / `E2B_TEMPLATE` names (E2B SDK reads `E2B_API_KEY` from env automatically — no need for a `BB_` prefix).

### Research references

**E2B documentation (primary):** https://e2b.dev/docs — use this as the authoritative source for SDK APIs, sandbox lifecycle, filesystem operations, command execution, and networking. Always consult the docs for current API signatures.

**terragon-oss (reference only):** https://github.com/terragon-labs/terragon-oss — this is a working implementation of E2B sandbox provisioning, daemon bundling, and lifecycle management. It's useful context for understanding the overall flow (how they upload daemons, handle credentials, manage sandbox lifecycle), but:
- The E2B SDK version and API calls may be outdated
- Their architecture differs (Unix socket communication vs our WebSocket sessions, different auth model)
- Do not copy code directly — use it to understand patterns, then implement against the current E2B docs
- Key files to study: `packages/sandbox/src/providers/e2b-provider.ts` (provisioning), `packages/sandbox/src/daemon.ts` (daemon install/start), `packages/daemon/` (bundling), `packages/sandbox-image/` (custom template)

---

## Key Design Decisions

### Host ID: server-generated, passed via env var

For persistent hosts, the daemon reads/creates its own host ID from disk. For ephemeral hosts, the **server** generates the host ID before provisioning (so it can create the host record and know what to wait for). The daemon receives it via `BB_HOST_ID` environment variable.

Flow:
1. Server calls `createHostId()` → `host_XXXXXXXXXX`
2. Server creates host record: `upsertHost(db, hub, { id, name, type: "ephemeral", provider: "e2b" })`
3. Server passes `hostId` to `provisionHost()` as part of options
4. `provisionHost()` creates sandbox, writes daemon payload, starts it with `BB_HOST_ID=host_XXXXXXXXXX`
5. Daemon's `loadHostIdentity()` returns the provided ID instead of reading from disk

This requires a small change to `identity.ts` — if `BB_HOST_ID` env var is set, use it directly.

Note: the daemon also calls `acquireDaemonLock(dataDir)` at startup. Inside a sandbox, `/tmp/bb-data/` (or similar) must be writable. The lock is per-machine, so it will just work (only one daemon per sandbox). Ensure the `BB_DATA_DIR` env var is set to a writable path in the sandbox environment.

### Connection handshake: daemon connects out

The daemon inside the sandbox connects to the server via the normal session protocol:
1. `POST /internal/session/open` with hostId, hostType: "ephemeral"
2. Server sees the session, knows the sandbox is alive
3. WebSocket connection established, daemon starts processing commands

The server waits for this connection by polling for an active session with the known hostId. Timeout after 60 seconds.

### E2B SDK: base `e2b` package, not `@e2b/code-interpreter`

We only need filesystem writes, command execution, and lifecycle management. The base `e2b` package (v2.18+) provides all of this. No need for the code-interpreter extension. **Important:** The E2B SDK evolves quickly. The API signatures in this plan (e.g., `sandbox.files.write()`, `sandbox.commands.run()`, `lifecycle: { onTimeout: "pause" }`) are based on v2.18 docs. Phase 8a's smoke test is the validation point — if any API differs, adjust the plan before proceeding.

### `project_sources.hostId` for GitHub repo sources

The `project_sources` table has `hostId TEXT NOT NULL REFERENCES hosts(id)`. For `local_path` sources this is the persistent host where the code lives. For `github_repo` sources there's no natural host. The unique index `(projectId, hostId)` also prevents multiple sources on the same host.

**Decision:** Make `hostId` nullable for `github_repo` sources. This requires:
- A migration to drop the NOT NULL constraint on `project_sources.hostId`
- Drop the `project_sources_project_host_idx` unique index and replace with a partial unique index enforced in application code (Drizzle doesn't support partial indexes natively — see existing comment in schema)
- Update `createProjectSource()` to allow null hostId for `github_repo` type

This is handled in 8d.

### Server URL for sandbox daemon

The server needs to tell the sandbox daemon where to connect back. E2B sandboxes run in the cloud and **cannot reach `localhost`**. This is a solved problem — terragon-oss uses a tunnel (ngrok) in development.

**Production:** Add `BB_PUBLIC_URL` env var to `@bb/config/server`, mapped to `publicUrl` on `ServerRuntimeConfig`. In production this is the actual deployed server URL (e.g., `https://bb.example.com`).

**Development:** Use a Cloudflare Tunnel via the `packages/dev-env` package (see 8a). A named tunnel is already configured — `DEV_CLOUDFLARED_TUNNEL_TOKEN` in `.env` maps `localhost.ymichael.com` → `localhost:3334`. Set `BB_PUBLIC_URL=https://localhost.ymichael.com` in `.env`. The tunnel starts automatically with `pnpm dev`.

Without a tunnel, sandbox provisioning will fail in development (sandbox can't reach localhost). The smoke test in 8a verifies connectivity.

**`BB_PUBLIC_URL` defaults:** No default in production (must be set). In dev, default to `http://localhost:${BB_SERVER_PORT}` for persistent-host workflows (which don't need a tunnel), but sandbox provisioning should check that it's not a localhost URL and error clearly if it is.

### Sandbox host handle cache

The server needs to keep `SandboxHost` handles in memory (they wrap the live E2B SDK connection). Rather than adding a mutable `Map` directly to `AppDeps`, introduce a thin `SandboxHostRegistry` service:

```typescript
// apps/server/src/services/sandbox-registry.ts
interface SandboxHostRegistry {
  get(hostId: string): SandboxHost | undefined;
  set(hostId: string, host: SandboxHost): void;
  remove(hostId: string): void;
}
```

This is a plain `Map` wrapper, injected into `AppDeps` as `sandboxRegistry: SandboxHostRegistry`. On server restart, handles are lost — reconstruct lazily via `resumeHost()` from `hosts.externalId` when a sandbox host is needed but not in the registry.

### Sandbox lifecycle maps to E2B operations

| bb operation | E2B call |
|---|---|
| `provisionHost()` | `Sandbox.create(template, opts)` |
| `suspend()` | `sandbox.pause()` |
| `resume()` | `Sandbox.connect(sandboxId)` |
| `destroy()` | `sandbox.kill()` |
| extend timeout | `sandbox.setTimeout(ms)` |

`hosts.externalId` stores the E2B `sandboxId` for reconnection after pause/resume.

### Auto-pause on timeout

Use E2B's `lifecycle: { onTimeout: "pause" }` so sandboxes pause instead of dying when the timeout expires. The server extends the timeout via `sandbox.setTimeout()` while threads are active. When all threads complete, let it auto-pause.

### Why daemon bundling is hard

The daemon (`apps/host-daemon`) can be esbuild-bundled into a single ESM file. But `@bb/agent-runtime` spawns **bridge processes** as separate Node.js child processes:

- **claude-code bridge** (`packages/agent-runtime/src/claude-code/bridge/bridge.ts`) — wraps Claude Agent SDK, spawned via `node bridge.js`
- **pi bridge** (`packages/agent-runtime/src/pi/bridge/bridge.ts`) — wraps Pi coding agent SDK, spawned via `node bridge.js`
- **codex** — external binary (`codex app-server`), not bundled at all

The bridge files must exist as **separate `.js` files on disk** — the runtime resolves their paths dynamically via `resolveBridgePath()` and spawns them. Each bridge has its own heavyweight SDK dependency tree. So the bundling step must produce **three artifacts**: the daemon bundle, the claude-code bridge bundle, and the pi bridge bundle. Plus codex must be pre-installed in the sandbox.

This is why bundling is deferred to the last sub-phase.

---

## 8a: E2B sandbox provisioning smoke test

Get API keys working. Create a sandbox, write a file, run a command, verify lifecycle operations. Also set up the dev tunnel for sandbox→server connectivity. Pure SDK validation — no daemon, no server integration.

**Changes:**

**`packages/config/src/server.ts`:**
- Rename `BB_E2B_API_KEY` → `E2B_API_KEY` and `BB_E2B_TEMPLATE` → `E2B_TEMPLATE` (the E2B SDK reads `E2B_API_KEY` from env automatically — no need to namespace with `BB_`)
- Add `BB_PUBLIC_URL` env var (see design decision above). Update `packages/config/test/config.test.ts` if it validates the config shape.

**Dev tunnel via `packages/dev-env`:**

Create a new `packages/dev-env` package that hooks into turbo's `dev` task. For now it does one thing: starts a Cloudflare Tunnel so E2B sandboxes can reach the local server.

A named tunnel is already configured — `DEV_CLOUDFLARED_TUNNEL_TOKEN` is in the primary checkout's `.env` (gitignored — if working in a worktree, copy or symlink from `/Users/michael/Projects/bb/.env`). The tunnel maps `localhost.ymichael.com` → `localhost:3334` (dev server port). Ingress is configured in the Cloudflare dashboard.

**`packages/dev-env/package.json`:**
```json
{
  "name": "@bb/dev-env",
  "private": true,
  "scripts": { "dev": "tsx src/index.ts" },
  "dependencies": { "@bb/config": "workspace:*" }
}
```

**`packages/dev-env/src/index.ts`:**
- Read `DEV_CLOUDFLARED_TUNNEL_TOKEN` from `@bb/config` (add to common or dev-env-specific config)
- If the token is not set, log "No tunnel token configured, skipping tunnel" and exit cleanly
- If set: `spawn("cloudflared", ["tunnel", "--no-autoupdate", "run", "--token", token], { stdio: "inherit" })`
- Handle SIGINT/SIGTERM to kill the child process

**`@bb/config`:**
- Add `DEV_CLOUDFLARED_TUNNEL_TOKEN` env var (optional, empty default, dev-only)
- Add `BB_PUBLIC_URL` to both server and host-daemon config scopes (server needs it for sandbox provisioning, host-daemon may need it for future use)
- Dev default for `BB_PUBLIC_URL`: `http://localhost:${BB_SERVER_PORT}` (works for persistent hosts; sandbox provisioning validates it's not localhost)

**`.env`:**
- Set `BB_PUBLIC_URL=https://localhost.ymichael.com`

Now `pnpm dev` starts the tunnel alongside the server, daemon, and app via turbo.

**`packages/sandbox-host/package.json`:**
- Add `e2b` dependency (`^2.18.0`)
- Add `p-retry` dependency

**`packages/sandbox-host/src/provision.ts`** — core provisioning logic:

```typescript
// Create sandbox, write a payload file, start a process, verify lifecycle.
// Initially works with any payload (fake daemon or real bundle).
// The "what to run inside" is a parameter, not hardcoded.

interface SandboxProvisionOptions {
  template?: string;        // E2B template ID (default: "base")
  timeoutMs?: number;       // default: 15 * 60 * 1000
  envs?: Record<string, string>;
  apiKey?: string;          // default: E2B_API_KEY env
  lifecycle?: { onTimeout: "pause" | "kill" };
}

async function createSandbox(options: SandboxProvisionOptions): Promise<Sandbox>
async function writeSandboxFile(sandbox: Sandbox, path: string, content: string): Promise<void>
async function runSandboxCommand(sandbox: Sandbox, command: string, opts?): Promise<CommandResult>
async function startBackgroundProcess(sandbox: Sandbox, command: string, opts?): Promise<CommandHandle>
```

**`packages/sandbox-host/src/lifecycle.ts`** — lifecycle wrappers:

```typescript
interface SandboxHost {
  hostId: string;
  externalId: string;       // E2B sandboxId
  suspend(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
  extendTimeout(ms: number): Promise<void>;
}

function createSandboxHost(sandbox: Sandbox, hostId: string): SandboxHost
async function resumeSandbox(externalId: string, opts?): Promise<Sandbox>
```

**`packages/sandbox-host/src/index.ts`** — re-export public API:

Keep the existing `ProvisionHostOptions` and `provisionHost` signatures but expand them. The stub `throw` is replaced with a call to `createSandbox` + file write + process start.

**Smoke test script** (`scripts/qa/e2b-smoke.mts`):

Standalone script (not vitest) that validates the E2B SDK integration:
1. `Sandbox.create("base", { timeoutMs: 5 * 60 * 1000 })` — verify sandbox created
2. `sandbox.files.write("/tmp/hello.txt", "hello from bb")` — verify file write
3. `sandbox.commands.run("cat /tmp/hello.txt")` — verify stdout === "hello from bb"
4. `sandbox.commands.run("node --version")` — verify Node.js available
5. Write a trivial fake daemon script to `/tmp/fake-daemon.mjs`:
   ```javascript
   import { createServer } from "node:http";
   const server = createServer((req, res) => {
     res.writeHead(200); res.end("ok");
   });
   server.listen(9999, () => console.log("ready"));
   ```
6. Start it: `sandbox.commands.run("node /tmp/fake-daemon.mjs", { background: true })`
7. Verify it's running: poll `sandbox.commands.run("curl -sf http://localhost:9999")`
8. `sandbox.pause()` — verify sandbox paused
9. `Sandbox.connect(sandboxId)` — verify sandbox resumed
10. Re-verify fake daemon or restart it after resume
11. `sandbox.kill()` — verify sandbox destroyed

If `BB_PUBLIC_URL` is set, also test sandbox→server connectivity:
12. `sandbox.commands.run("curl -sf ${BB_PUBLIC_URL}/health")` — verify sandbox can reach the server through the tunnel

Requires `E2B_API_KEY` env var. `BB_PUBLIC_URL` optional (connectivity test skipped if not set). Exit 0 on success, non-zero with diagnostics.

**Validation:**
- [ ] Smoke script passes with real E2B API key
- [ ] Can create sandbox, write files, run commands
- [ ] Pause/resume/kill lifecycle works
- [ ] Background process runs and is reachable via localhost
- [ ] Dev tunnel works: sandbox can reach server via `BB_PUBLIC_URL` (if configured)

---

## 8b: `@bb/sandbox-host` provisioning with fake daemon

Wire `provisionHost()` to create a sandbox, write a trivial fake daemon that opens an HTTP health endpoint and connects to the server session protocol, and verify the server sees the session.

The fake daemon is a short inline script — just enough to prove the sandbox → server connection works. It does NOT need to handle commands, provision workspaces, or process events. Keep it minimal.

What it does:
1. Starts an HTTP server on port 9111 that responds 200 to `/health` (for the sandbox-side health check)
2. `POST ${BB_SERVER_URL}/internal/session/open` with JSON body:
   ```json
   {
     "hostId": "${BB_HOST_ID}",
     "instanceId": "<random-uuid>",
     "hostName": "sandbox",
     "hostType": "ephemeral",
     "protocolVersion": 2
   }
   ```
   Headers: `Content-Type: application/json`, `Authorization: Bearer ${BB_SECRET_TOKEN}`
3. Stays alive (the HTTP server keeps the process running)

It does NOT open a WebSocket connection or handle heartbeats. The server will create the session record from the POST, which is enough to prove the handshake works. The session will eventually expire (no heartbeats), which is fine for testing.

**Changes:**

**`apps/host-daemon/src/identity.ts`:**
- At the top of `loadHostIdentity()`: if `BB_HOST_ID` env var is set, return it as `hostId` (skip file read/create).

**`packages/sandbox-host/src/provision.ts`:**

```
provisionHost(options):
  1. createSandbox({ envs, template, timeoutMs, lifecycle: { onTimeout: "pause" } })
  2. Write daemon payload to /tmp/bb-daemon.mjs
     - For now: the fake daemon script (inline string constant)
     - Later (8e): the real bundled daemon
  3. Start background: node /tmp/bb-daemon.mjs
  4. Poll health check (curl localhost:PORT) — up to 30 attempts, 2s each
  5. Return SandboxHost { hostId, externalId, suspend, resume, destroy, extendTimeout }
```

**`packages/sandbox-host/src/index.ts`** — replace stub with real interface. The existing stub has `SandboxHost { hostId, suspend, resume, destroy }` and `ProvisionHostOptions { sandboxType, serverUrl, authToken }`. Expand both — add `externalId` and `extendTimeout()` to `SandboxHost`, add `hostId`/`hostName`/`template`/etc to options:

```typescript
export interface ProvisionHostOptions {
  hostId: string;
  hostName: string;
  serverUrl: string;
  authToken: string;
  sandboxType: string;
  template?: string;
  timeoutMs?: number;
  apiKey?: string;
  daemonPayload?: string;   // Override daemon script (for testing)
}

export interface ResumeHostOptions {
  externalId: string;
  hostId: string;
  serverUrl: string;
  authToken: string;
  timeoutMs?: number;
  apiKey?: string;
}

export async function provisionHost(options: ProvisionHostOptions): Promise<SandboxHost>;
export async function resumeHost(options: ResumeHostOptions): Promise<SandboxHost>;
```

**Unit tests** (`packages/sandbox-host/test/provision.test.ts`):
- Mock `Sandbox.create`, `sandbox.files.write`, `sandbox.commands.run`, `sandbox.pause`, `sandbox.kill`
- Test: `provisionHost` calls create with correct template and envs
- Test: daemon payload written to correct path
- Test: background process started with correct command
- Test: health check polling retries on failure, succeeds when ready
- Test: SDK create failure retries up to 3 times, then throws
- Test: `suspend()` calls `sandbox.pause()`
- Test: `destroy()` calls `sandbox.kill()`

**Manual validation** (extend `scripts/qa/e2b-smoke.mts`):
- Call `provisionHost()` with a running local server
- Verify server sees session open from the fake daemon
- Verify `suspend()` / `resumeHost()` / `destroy()` work

**Validation:**
- [ ] `provisionHost()` creates sandbox and starts fake daemon
- [ ] Fake daemon's health check passes
- [ ] Fake daemon connects to server (session open visible in server logs or DB)
- [ ] `suspend()` pauses sandbox
- [ ] `resumeHost()` reconnects, fake daemon restarts and reconnects
- [ ] `destroy()` kills sandbox
- [ ] Unit tests pass with mocked SDK

---

## 8c: Server integration

Wire the server's thread creation flow to call `provisionHost()` for `sandbox-host` environment requests. Uses the fake daemon — the full provisioning flow works but the daemon can't actually run threads yet.

**Changes:**

**`apps/server/src/services/thread-create.ts`:**

Replace the 501 block with real provisioning:

```
if (request.environment.type === "sandbox-host") {
  // 1. Generate host ID
  const hostId = createHostId();

  // 2. Create host record
  upsertHost(db, hub, {
    id: hostId,
    name: `sandbox-${hostId.slice(-6)}`,
    type: "ephemeral",
    provider: request.environment.sandboxType,
  });

  // 3. Provision sandbox (with fake daemon for now)
  const sandboxHost = await provisionHost({
    hostId,
    hostName: `sandbox-${hostId.slice(-6)}`,
    serverUrl: config.publicUrl,         // new field on ServerRuntimeConfig
    authToken: config.authToken,         // mapped from BB_SECRET_TOKEN at startup
    sandboxType: request.environment.sandboxType,
  });

  // 4. Store externalId for suspend/resume
  updateHost(db, hub, hostId, { externalId: sandboxHost.externalId });

  // 5. Cache handle for lifecycle management
  deps.sandboxRegistry.set(hostId, sandboxHost);

  // 6. Wait for daemon session (poll getActiveSession)
  const session = await waitForHostSession(db, hostId, { timeoutMs: 60_000 });

  // 7. Create environment + thread (same as host-type flow)
  // The environment.provision command will be queued to the daemon
  // With fake daemon this will time out — that's expected for 8c
}
```

**`packages/db/src/data/hosts.ts`:**
- Add `updateHost(db, notifier, hostId, updates: Partial<{ name, provider, externalId }>)` — partial update that only sets provided fields, touches `updatedAt` and `lastSeenAt`. Export from `@bb/db`.
- Currently only `upsertHost`, `getHost`, `listHosts` exist. `updateHost` is needed to set `externalId` after provisioning without overwriting all fields.

**`apps/server/src/types.ts`:**
- Add `sandboxRegistry: SandboxHostRegistry` to `AppDeps` (see design decision above)
- Add `publicUrl` to `ServerRuntimeConfig`

**`apps/server/src/services/host-lifecycle.ts`** (new file):

- `waitForHostSession(db, hostId, opts)` — poll `getActiveSession()` every 2s until found or timeout
- `suspendIdleHost(deps, hostId)` — calls `suspend()` on cached handle via `deps.sandboxRegistry`
- `resumeSuspendedHost(deps, hostId)` — calls `resumeHost()` with stored `externalId`, caches new handle
- `destroyHost(deps, hostId)` — calls `destroy()`, removes from registry, updates host record

**Validation:**
- [ ] `POST /threads` with `{ type: "sandbox-host", sandboxType: "e2b" }` creates sandbox
- [ ] Host record has `type: "ephemeral"`, `provider: "e2b"`, `externalId` set
- [ ] Server detects daemon session open
- [ ] Server waits for session before proceeding with thread creation
- [ ] Existing persistent-host tests still pass (no regression)

---

## 8d: GitHub project sources and cloud sandbox UX

Before we can run real threads in sandboxes, users need a way to:
1. Configure a GitHub personal access token
2. Add GitHub repo project sources (not just local paths)
3. Select "cloud sandbox" as an environment option when creating threads

This step enables the full user flow: configure token → add GitHub repo → create thread in cloud sandbox → sandbox clones repo using token.

**Changes:**

**`packages/config/src/server.ts`:**
- Add `BB_GITHUB_PAT` config: `str({ desc: "GitHub personal access token for repo cloning in sandboxes", default: "", allowEmpty: true })`

**`packages/config/src/common.ts`** (or new `packages/config/src/shared.ts`):
- If `BB_GITHUB_PAT` is needed by both server and daemon (daemon needs it for git clone inside sandbox), add to common config. Otherwise server-only.

**Server: project source management:**

The schema already supports `github_repo` sources with `repoUrl` (see `project_sources` table). The contract already has `createProjectSourceRequestSchema` with `type: z.enum(["local_path", "github_repo"])`. Verify the server routes handle `github_repo` type correctly:

- `POST /projects/:id/sources` — should accept `{ type: "github_repo", repoUrl: "https://github.com/org/repo" }` with no `hostId` (see design decision above — `hostId` becomes nullable for `github_repo` sources). This requires the schema migration described in the design decisions section.

**App UI: project source management** (`apps/app/src/views/ProjectMainView.tsx`):

Add a "Sources" section to the project main page:
- Show current project sources (list)
- "Add source" button/dialog that allows:
  - Type selection: "Local path" or "GitHub repository"
  - For GitHub repo: repo URL input field
  - For local path: path input (existing flow)

**App UI: environment selector** (`apps/app/src/views/ProjectMainView.tsx`):

Currently offers "Direct" and "Worktree" options, both targeting the local host. When a project has a `github_repo` source and `E2B_API_KEY` is configured:
- Add "Cloud sandbox" option to the environment selector
- Selecting it sets `environment: { type: "sandbox-host", sandboxType: "e2b" }`

The option should only appear when:
1. The project has at least one `github_repo` source, AND
2. The server has E2B configured

To expose (2) to the app: add `e2bConfigured: boolean` and `githubConnected: boolean` to `systemConfigResponseSchema` (in `@bb/server-contract`) and the `GET /system/config` handler. Set them to `!!config.e2bApiKey` and `!!config.githubPat` respectively. The app reads these via the existing `useSystemConfig` hook. The "Cloud sandbox" option requires both (`e2bConfigured && githubConnected`), since sandbox environments need a GitHub token to clone repos.

**Server: pass GitHub PAT to sandbox environment:**

Git clone is owned by `@bb/workspace`, which runs inside the daemon via the `environment.provision` command — the same path as persistent hosts. The sandbox-host package only handles host lifecycle (create/pause/resume/kill), not workspace operations. The daemon is host-agnostic.

When provisioning a sandbox, pass `GITHUB_TOKEN` as an env var so the daemon's workspace provisioning can authenticate git clones:
```
envs: {
  BB_HOST_ID: hostId,
  BB_SERVER_URL: serverUrl,
  BB_SECRET_TOKEN: authToken,
  GITHUB_TOKEN: config.githubPat,       // for authenticated git clone
}
```

The flow for a sandbox thread with a `github_repo` source:
1. Server provisions sandbox host → daemon starts and connects
2. Server creates environment record, queues `environment.provision` command with `managed-clone` workspace type and the `repoUrl` from the project source
3. Daemon handles `environment.provision` → calls `provisionWorkspace()` → git clone using `GITHUB_TOKEN` from env
4. Daemon reports environment ready → server queues `thread.start`

This means `@bb/workspace`'s `provisionWorkspace()` must support cloning from a URL (not just creating worktrees from an existing local repo). Check if `managed-clone` already handles this, or if it needs to be extended to accept a `repoUrl` instead of a local source path.

Also verify that git credential helper is configured inside the sandbox so `GITHUB_TOKEN` is used for HTTPS clones. The daemon may need to run `git config --global credential.helper '!f() { echo password=$GITHUB_TOKEN; }; f'` at startup when running in ephemeral mode.

**Validation:**
- [ ] `BB_GITHUB_PAT` accepted by server config
- [ ] `POST /projects/:id/sources` works with `type: "github_repo"`
- [ ] Project main page shows sources and allows adding GitHub repos
- [ ] Environment selector shows "Cloud sandbox" when appropriate
- [ ] `GITHUB_TOKEN` is passed through to sandbox environment
- [ ] Existing local-path project creation still works

---

## 8e: Custom E2B template

The default `base` template has Node.js but lacks provider CLIs. Before daemon bundling, build a custom E2B template that has everything the daemon needs at runtime. This follows the same approach as [terragon-oss](https://github.com/terragon-labs/terragon-oss) — pre-bake dependencies into the image so provisioning is fast.

**Template contents:**
- Node.js 22 (already in base)
- `codex` CLI (OpenAI) — external binary spawned by `@bb/agent-runtime`
- `git`, `gh` CLI — for workspace provisioning (git clone, branch management)
- Any system deps the provider CLIs require

Note: `claude-code` and `pi` providers don't need CLI binaries — they use bridge processes that wrap their SDKs directly. Only `codex` is an external binary.

**Implementation:**

Create `packages/sandbox-image/` (or similar):
- `Dockerfile` — extends E2B base, installs provider CLIs at pinned versions
- `templates.json` — tracks template IDs after `e2b template build`
- Build script that runs `e2b template build` and records the template ID
- Update `packages/sandbox-host` to use the custom template ID instead of `"base"`

**Validation:**
- [ ] Custom template builds successfully via E2B CLI
- [ ] Template has Node.js 22, codex CLI, git, gh
- [ ] Sandbox created from custom template can run `codex --version`, `node --version`, `git --version`
- [ ] Provisioning time with custom template is reasonable (< 30s)

---

## 8f: Daemon bundling and real daemon in sandbox

Replace the fake daemon with the real bundled daemon. This is the most complex sub-phase.

**The bundling challenge:**

The daemon (`apps/host-daemon`) imports `@bb/agent-runtime`, which spawns **bridge processes** as child Node.js processes:
- **claude-code bridge** (`packages/agent-runtime/src/claude-code/bridge/bridge.ts`) — wraps `@anthropic-ai/claude-agent-sdk`, resolved via `resolveBridgePath()` and spawned as `node bridge.js`
- **pi bridge** (`packages/agent-runtime/src/pi/bridge/bridge.ts`) — wraps `@mariozechner/pi-coding-agent`, spawned the same way
- **codex** — external binary (`codex app-server`), pre-installed in custom template (8e)

The bridge files must exist as **separate `.js` files on disk** because they're spawned as child processes. Each has its own SDK dependency tree. So the bundle step must produce **multiple artifacts**:

1. `daemon-bundle.mjs` — the main daemon (esbuild single-file ESM)
2. `claude-code-bridge-bundle.mjs` — the claude-code bridge (esbuild single-file ESM)
3. `pi-bridge-bundle.mjs` — the pi bridge (esbuild single-file ESM)

All three get written to the sandbox filesystem. The daemon's `resolveBridgePath()` needs to resolve to the sandbox paths (e.g., `/tmp/bb-claude-code-bridge.mjs`) when running in ephemeral mode.

**Changes:**

**`apps/host-daemon/package.json`:**
- Add `esbuild` as devDependency (`^0.25.0`)
- Add `"bundle"` script that produces all three artifacts
- Add `"bundle:check"` script that syntax-checks all bundles

**`packages/agent-runtime/src/claude-code/adapter.ts`** and **`packages/agent-runtime/src/pi/adapter.ts`:**
- Modify `resolveBridgePath()` to check for `BB_BRIDGE_DIR` env var. If set, resolve bridge from that directory instead of relative to `__dirname`. This is the ephemeral path — bridges are uploaded to a known location in the sandbox.

**`packages/sandbox-host/src/provision.ts`:**
- Replace fake daemon with real bundle:
  1. Read daemon bundle from filesystem (`apps/host-daemon/dist/daemon-bundle.mjs`)
  2. Read bridge bundles from filesystem
  3. Write all three to sandbox: `/tmp/bb-daemon.mjs`, `/tmp/bb-claude-code-bridge.mjs`, `/tmp/bb-pi-bridge.mjs`
  4. Start daemon with `BB_BRIDGE_DIR=/tmp` env var

**`turbo.json`:**
- Add `"bundle"` task to host-daemon pipeline, depending on `^build`

**Validation:**
- [ ] `pnpm exec turbo run bundle --filter=@bb/host-daemon` produces three bundle files
- [ ] All three pass `node --check`
- [ ] Bundle sizes are reasonable (< 10 MB total)
- [ ] `provisionHost()` with real daemon: sandbox created, daemon connects, session opens
- [ ] Server creates thread, environment.provision command dispatched and handled by daemon in sandbox
- [ ] Daemon in sandbox provisions workspace (git clone using GITHUB_TOKEN)
- [ ] Thread start command dispatched, provider bridge spawned, events flow through
- [ ] Full end-to-end: create project with GitHub source → create thread with cloud sandbox → see events
- [ ] Existing `pnpm exec turbo run test --filter=@bb/host-daemon` still passes

---

## 8g: Testing

**Unit tests (mocked E2B SDK):**

Already started in 8b. Expand:
- Resume flow: `resumeHost` calls `Sandbox.connect` with stored sandboxId
- Resume with dead daemon: re-uploads and restarts
- `extendTimeout` calls `sandbox.setTimeout`

**Server integration tests:**

Add to `tests/integration/fake/sandbox.test.ts`:
- Inject a fake `SandboxHostRegistry` via `AppDeps` (dependency injection, not module mocking — per AGENTS.md, don't mock our own code). The fake registry returns a stub `SandboxHost` that records calls.
- Test: thread creation with sandbox-host type creates host record, calls provisionHost, waits for session
- Test: host record has correct type/provider/externalId
- Test: environment.provision command queued after session opens
- Test: second thread on same project reuses existing host (if connected)

**Real E2B end-to-end smoke test:**

Extend `scripts/qa/e2b-smoke.mts` to cover the full flow:
1. Start server
2. Create project with GitHub source
3. Create thread with cloud sandbox
4. Verify sandbox provisions, daemon connects, repo cloned, events flow
5. Destroy sandbox

Requires `E2B_API_KEY` and `BB_GITHUB_PAT` env vars.

**Validation:**
- [ ] `pnpm exec turbo run test --filter=@bb/sandbox-host` passes
- [ ] `pnpm exec turbo run test --filter=@bb/integration-tests` passes
- [ ] Manual smoke test with real E2B API key succeeds

---

## Dependency Graph

```
8a (E2B smoke test)           — prove SDK works, no daemon
  ↓
8b (fake daemon in sandbox)   — prove sandbox→server connection
  ↓
8c (server integration)       — wire POST /threads, uses fake daemon
  ↓
8d (GitHub sources + UX)      — PAT config, repo sources, cloud sandbox option
  ↓
8e (custom E2B template)      — pre-bake provider CLIs into sandbox image
  ↓
8f (daemon bundling)          — real daemon + bridge bundles in sandbox
  ↓
8g (testing)                  — full test coverage
```

8a–8d use the default `base` E2B template. Custom template and bundling are 8e–8f.

---

## Exit Criteria

Phase 8 is complete when:
- [ ] E2B SDK integration works (create, pause, resume, kill)
- [ ] `provisionHost()` creates a sandbox, installs and starts real daemon, daemon connects to server
- [ ] Bridge binaries bundled and functional inside sandbox
- [ ] `suspend()` / `resumeHost()` / `destroy()` work correctly
- [ ] Server's `POST /threads` with `sandbox-host` type provisions sandbox and starts thread
- [ ] Users can configure GitHub PAT and add GitHub repo project sources
- [ ] Users can select "Cloud sandbox" environment when creating threads
- [ ] Thread events flow normally through the sandbox daemon
- [ ] Git clone inside sandbox uses GitHub PAT for authentication (via daemon's `environment.provision` → `@bb/workspace`)
- [ ] Custom E2B template with provider CLIs pre-installed
- [ ] Unit tests with mocked E2B SDK pass
- [ ] Server integration tests pass
- [ ] Manual smoke test with real E2B API key succeeds
