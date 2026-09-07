## Client<->server contract and SDK — facts for an Expo/RN client

### 1. Transport, base URL, auth
- HTTP: `@bb/server-contract` builds a Hono RPC client: `createPublicApiClient(baseUrl, {fetch})` = `hc<PublicApiRoutes>(`${baseUrl}/api/v1`)` (packages/server-contract/src/public-api.ts:1483-1500). All contract routes are mounted under `/api/v1` (apps/server/src/server.ts:486); unmatched `/api/v1/*` → 404 (server.ts:487-489). `/health` at server.ts:331.
- The SDK transport wraps that client: `createHttpTransport({baseUrl, fetch, realtimeUrl, runtime, websocket})` (packages/sdk/src/transport-http.ts:14-31); baseUrl defaults to `""` (same origin). `BbSdkTransport` shape at packages/sdk/src/transport.ts:9-24; socket abstraction `BbRealtimeSocket`/`BbRealtimeSocketFactory` at transport.ts:39-51.
- Local bb server has NO credential auth on `/api/v1` or `/ws`. Only an Origin-header guard: requests with an `Origin` that is not a trusted local app origin get 403 `forbidden_origin` (apps/server/src/browser-request-guard.ts:147-175; applied at server.ts:450-463 and to `/ws` at 501-520, `/ws/terminals/:terminalId` at 522-567). Requests without `Origin` (Node SDK, CLI, RN native fetch) pass. CORS at server.ts:307-319. `/internal/*` (daemon) uses `authorization` header (server.ts:388-409) — not for clients.
- The PWA sends `x-bb-app-surface: web|desktop` (packages/config/src/app-surface.ts:1-8; apps/app/src/lib/app-surface.ts:15-22) via a fetch wrapper passed to `createBrowserBbSdk({baseUrl: window.location.origin, fetch})` (apps/app/src/lib/sdk.ts:1-10).
- Remote access goes through the connect gate (`https://<handle>.getbb.app`, apps/connect/src/worker.ts). Two auth modes: (a) header `x-bb-connect-machine: <machineCredential>` accepted only for `/api/v1*` and `/internal*` paths (worker.ts:393-425; host-management mutations refused 243-260); (b) session cookie — either better-auth `__Secure-better-auth.session_token` or desktop cookie `__Secure-bb-connect.desktop_session` (apps/connect/src/cloud-dev.ts:2-6) — required for everything else including `/ws` and `/ws/terminals/*` (worker.ts:430-463). WebSocket upgrades are proxied directly (461-463). Machine credential comes from `POST {apex}/api/connect/redeem-machine` with a one-time code (packages/connect-client/src/redeem-machine.ts:75-140; code minted by a paired bb via connect plugin RPC `createMachineCode` → `POST {apex}/api/connect/machine-code`, plugins/connect/src/machine-code.ts:26-50, apps/web/src/routes/api.connect.machine-code.tsx:10-27; desktop flow apps/desktop/src/connect-machine-enrollment.ts:73-80). A 1-hour desktop session cookie is minted with `POST {serverUrl}/api/connect/desktop-session` + machine header (packages/connect-client/src/desktop-session.ts:24-33; apps/connect/src/servers.ts:332-379, TTL servers.ts:18). Credential shape `{serverUrl, handle, credential}` (packages/connect-client/src/credential.ts:8-14); list servers `GET /api/connect/servers` (list-servers.ts:55-61).

### 2. @bb/sdk in RN/Hermes
- package.json exports (packages/sdk/package.json:5-38): `"."` → source `src/node.ts`, browser `dist/browser.js`, node/import/default `dist/node.js`; `./browser` → source `src/browser.ts`, import `dist/browser.js`; `./core`, `./node`, `./node-websocket`. No `dist` is present in the worktree (source-first); Metro must add `source` to `resolver.unstable_conditionNames` or dist must be built.
- `src/node.ts` is NOT RN-safe: imports `@bb/config/cli` (node.ts:1) → packages/config/src/env.ts:1 `import { homedir } from "node:os"`; `createNodeWebsocketFactory` (node.ts:5) → `node-websocket.ts:1` imports `ws` and uses `Buffer` (lines 10-17); `createRequestTimeoutFetch` uses `AbortSignal.timeout/any` and `ReadableStream` (packages/sdk/src/response.ts:105-107, 227).
- `src/browser.ts` (packages/sdk/src/browser.ts:20-40) is RN-safe by import graph: `createBrowserBbSdk({baseUrl, fetch, realtimeUrl, websocket})`; module-level `export const bb = createBrowserBbSdk()` (line 40) is side-effect free. Runtime deps: `hono/client` (`hc`: uses fetch/Headers/FormData/URLSearchParams only, packages/server-contract/node_modules/hono/dist/client/client.js:48-99), `zod`, `@bb/domain` (zod only), `@bb/core-ui` (pure, `extractErrorMessage`), `@bb/host-daemon-contract` (zod + hc), `@bb/templates/generated` (117 KB pure data, 0 imports; via areas/guide.ts:1). Areas use only `response.json()/text()/arrayBuffer()`, `FormData`, `Blob`, `URLSearchParams` (areas/projects.ts:351-378, areas/hosts.ts:146-160, areas/system.ts:192-204). `realtime-url.ts:14-30` mutates `URL.protocol/pathname/search/hash` — needs a spec-compliant `URL` (Expo's winter runtime polyfill; bare RN's URL is incomplete). `resolveDefaultWebsocketFactory` uses global `WebSocket` (realtime-client.ts:163-168); to add cookies/headers pass a custom `websocket` factory wrapping `new WebSocket(url, null, {headers})` via `wrapStandardWebsocket` (realtime-client.ts:143-161).
- Plugins/skills areas bypass the typed client and hit raw paths `/api/v1/plugins/*`, `/api/v1/plugin-catalog/*`, `/api/v1/marketplaces*`, `/api/v1/skills-registry*` with `transport.fetch` (packages/sdk/src/areas/plugins.ts:227-246, areas/skills.ts:131-185).

### 3. Realtime
- Endpoint `GET /ws` (server.ts:501-520). Client→server: `{type:"subscribe"|"unsubscribe", target}` where target ∈ thread-detail{threadId}, thread-list, project-detail{projectId}, project-list, environment-detail{environmentId}, environment-list, host-detail{hostId}, host-list, system (packages/domain/src/change-kinds.ts:69-155). Invalid message → server closes 1008 (apps/server/src/ws/client-protocol.ts:30-40). Server→client: `{type:"changed", entity:"thread"|"project"|"environment"|"host"|"system", id?, changes:[...], metadata?}` (change-kinds.ts:209-260; kinds at 9-60; lenient inbound schemas 273-338; `serverMessageLenientSchema` packages/server-contract/src/api/shared.ts:174). Routing: id-scoped messages fan out to both list and detail keys (apps/server/src/ws/hub.ts:53-89, 945-965). Extra ephemeral broadcast types: `thread-open` (server-contract/src/api/threads.ts:521-543), thread pane action (threads.ts:580-596), `plugin-signal` (shared.ts:186-206) — sent to every socket; SDK ignores non-"changed" types (realtime-client.ts:581-590); PWA handles them in apps/app/src/lib/ws.ts:100-150 using `partysocket` (ws.ts:1, 61-67).
- SDK client: `sdk.subscribe({event:"thread:changed"|"project:changed"|"environment:changed"|"host:changed"|"system:changed"|"system:config-changed"|"realtime:connection", callback, threadId?...})` (packages/sdk/src/realtime-types.ts:5-13, 62-118); refcounted targets, resubscribe on open (realtime-client.ts:425-431), backoff 1s×1.5→30s (32-34, 466-513), closes socket when idle (516-552). URL: `realtimeUrl` override, else absolute baseUrl→`ws(s)://host/<prefix>/ws`, else browser `location` (realtime-url.ts:60-84).
- Terminals: `GET /ws/terminals/:terminalId?sinceSeq=N` (server.ts:522-567); client msgs input{dataBase64}/resize/close/ping, server msgs attached/output/session-updated/exited/error/pong (server-contract/src/api/terminals.ts:170-256).
- Long-poll alternative: `GET /threads/:id/events/wait` (public-api.ts:1250-1257) used by `threads.wait` (areas/threads.ts:1179-1230).

### 4. Routes (all `/api/v1` prefix; packages/server-contract/src/public-api.ts:323-1456)
- projects (325-517): GET/POST /projects, GET /sidebar-bootstrap, GET/PATCH/DELETE /projects/:id, PATCH /projects/:id/order, GET default-execution-options, prompt-history, POST sources, PATCH/DELETE sources/:sourceId, GET files, files/content(binary), paths, commands, skills(+DELETE), skills/content(GET/PATCH), skills/files, branches, POST attachments(form), attachments/copy, GET attachments/content(binary).
- files (519-584): POST /files/read|write|list|paths|mkdir|move|remove|previews; GET /file-previews/:id/:filePath (586-593).
- hosts (595-688): POST /hosts/join-codes, GET /hosts, GET/PATCH/DELETE /hosts/:id, PATCH permission-ceiling, POST retry-update, GET directory, clone-default-path, POST paths/exist, pick-folder, GET provider-clis/status, POST provider-clis/install (NDJSON text).
- terminals (690-761): GET/POST /terminals, GET/PATCH /terminals/:terminalId, POST restart|close|input|resize, GET output.
- environments (763-865): GET/PATCH /environments/:id, GET status, pull-request, diff, diff/files, POST diff/patch, GET diff/file, diff/branches, paths, POST actions (commit and pull request actions; 409 on blocked), POST archive-threads.
- thread-sections (867-902): POST/PATCH/DELETE /thread-sections.
- threads (904-1316): GET/POST /threads, GET /threads/search, POST resolve-mentions, fork; GET/PATCH/DELETE /threads/:id; child-summary; POST send (mode queue-if-active|steer-if-active|auto), edit-message; queued-messages CRUD + send/order/group-boundary; prompt-history; POST stop, compact, plan/cancel, goal/clear, open, pane-action; GET/PUT tabs; POST pin/unpin, PATCH pin-order; interactions (list/get/resolve/respond/cancel); archive/archive-all/unarchive/read/unread; GET timeline (query: includeNestedRows, segmentLimit, beforeAnchorSeq/Id, summaryOnly, afterSequence → delta; threads.ts:664-706; delta apply server-contract/src/thread-timeline.ts:541-601), conversation-outline, timeline/turn-summary-details, output, events, events/wait, default-execution-options, thread-storage/files|paths|content, thread-storage/files/:filePath, host-files/content, worktree/files/:filePath, files/raw.
- system/settings (1318-1455): GET /system/attention, /system/config, PUT /settings/general|keyboard|experiments|appearance, GET /settings/themes, POST /system/config/reload, GET/POST /system/cli-skills(/install), GET /system/execution-options, /system/providers, /system/providers/:id/logo, POST /system/onboarding/event, GET /system/onboarding/agents|repos, GET /system/usage-limits, POST /system/voice-transcription(form), GET /system/version.
- Not in the typed contract (string-registered): plugins (apps/server/src/routes/plugins.ts:196-610: GET /plugins, contributions, mentions/search, POST :id/cli, GET :id/assets/:file, :id/logs, POST updates/check, GET updates, POST :id/update, install, GET :id/source, POST reload, :id/enable|disable, GET/PUT :id/settings, DELETE :id, POST :id/token, POST :id/rpc/:method, ALL :id/http/*), plugin-catalog + marketplaces (routes/plugin-catalog.ts:33-148), skills-registry (routes/skills-registry.ts:52-162). Schemas for these live in packages/server-contract/src/api/plugins.ts and api/skills.ts.
- Errors: `{code, message, details?, retryable?}` (server-contract/src/errors.ts:11-17; lifecycle codes 150-158); SDK throws `BbHttpError{status, code, body}` (packages/sdk/src/response.ts:81-97).

### 5. Package exports / tsconfig / workspace
- Every workspace lib uses `exports: {".": {source: ./src/x.ts, types: ./src/x.ts, default: ./src/x.ts}}` with no dist (domain, server-contract, hono-typed-routes, connect-client, core-ui, config, templates, host-daemon-contract). Only `@bb/sdk` (and plugin-sdk) point `import/default` at `dist/`. Metro therefore resolves `@bb/domain` etc. via `default` → TS source without extra config, but `@bb/sdk/browser` needs the `source` condition.
- Typecheck: packages/tsconfig/base.json (strict, ES2022, NodeNext) + typecheck-overrides.json (`customConditions: ["source"]`, noEmit). apps/app/tsconfig.json overrides `moduleResolution: "bundler"` and `paths {"@/*": ["./src/*"]}`. Vite uses `resolve.conditions: ["source"]` (apps/app/vite.config.ts:33-34); vitest.shared.ts and `node --conditions=source` do the same.
- pnpm-workspace.yaml globs `packages/*`, `apps/*`, `tests/*`, `plugins/*`, `examples/plugins/*` — `apps/mobile` is auto-included. No `.npmrc` (default isolated symlinked node_modules). turbo.json: generic `build` (dependsOn `topo`, outputs dist/**), `typecheck` (dependsOn topo), `test` (dependsOn `//#ensure-native-modules`, topo), `lint`; the `topo` transit task hashes upstream sources because `source` resolution reads src. Per-app `dev` tasks are `cache:false, persistent:true, passThroughEnv:["*"]` (e.g. `@bb/app#dev`). Root `pnpm.overrides.zod = 4.3.6`; typescript is `@typescript/typescript6`. hono 4.11.9 (`hono/client` export at `./client`), zod 4.3.6.

## Key files
- packages/sdk/package.json
- packages/sdk/src/browser.ts
- packages/sdk/src/core.ts
- packages/sdk/src/transport.ts
- packages/sdk/src/transport-http.ts
- packages/sdk/src/response.ts
- packages/sdk/src/realtime-client.ts
- packages/sdk/src/realtime-types.ts
- packages/sdk/src/realtime-url.ts
- packages/sdk/src/node.ts
- packages/sdk/src/node-websocket.ts
- packages/sdk/src/areas/plugins.ts
- packages/sdk/src/areas/threads.ts
- packages/server-contract/src/public-api.ts
- packages/server-contract/src/api/shared.ts
- packages/server-contract/src/api/threads.ts
- packages/server-contract/src/api/terminals.ts
- packages/server-contract/src/api/plugins.ts
- packages/server-contract/src/thread-timeline.ts
- packages/server-contract/src/errors.ts
- packages/domain/src/change-kinds.ts
- packages/domain/src/index.ts
- packages/domain/package.json
- packages/hono-typed-routes/src/route-descriptor.ts
- packages/hono-typed-routes/src/typed-routes.ts
- packages/connect-client/src/credential.ts
- packages/connect-client/src/redeem-machine.ts
- packages/connect-client/src/desktop-session.ts
- packages/connect-client/src/list-servers.ts
- packages/config/src/app-surface.ts
- packages/config/src/env.ts
- packages/tsconfig/base.json
- packages/tsconfig/typecheck-overrides.json
- apps/server/src/server.ts
- apps/server/src/browser-request-guard.ts
- apps/server/src/ws/client-protocol.ts
- apps/server/src/ws/hub.ts
- apps/server/src/routes/plugins.ts
- apps/server/src/routes/plugin-catalog.ts
- apps/server/src/routes/skills-registry.ts
- apps/connect/src/worker.ts
- apps/connect/src/servers.ts
- apps/connect/src/cloud-dev.ts
- apps/app/src/lib/sdk.ts
- apps/app/src/lib/ws.ts
- apps/app/src/lib/app-surface.ts
- apps/app/tsconfig.json
- apps/app/vite.config.ts
- apps/desktop/src/connect-machine-enrollment.ts
- apps/desktop/src/connect-desktop-session.ts
- pnpm-workspace.yaml
- turbo.json
- vitest.shared.ts
- scripts/build-package.mjs

## Reuse verdicts
- @bb/sdk (root export "." / src/node.ts): **not-reusable** — packages/sdk/src/node.ts:1 imports @bb/config/cli → packages/config/src/env.ts:1 `node:os`; node.ts:5 imports node-websocket.ts which imports `ws` and uses Buffer (lines 1,10-17); default fetch wrapper uses AbortSignal.timeout/any + ReadableStream (response.ts:105-107,227). Metro `import`/`default` conditions also point at unbuilt dist/node.js.
- @bb/sdk/browser (src/browser.ts + core + areas + realtime): **reusable-with-small-changes** — Import graph is DOM/node-free (fetch, Headers, FormData, Blob, URLSearchParams, WebSocket, URL only). Needs: Metro `source` condition (or built dist/browser.js); absolute `baseUrl` (default "" is same-origin); a custom `websocket` factory if cookies/headers are needed on /ws (RN WebSocket options arg) — realtime-client.ts:163-168 uses bare `new WebSocket(url)`; realtime-url.ts:14-30 requires a spec-compliant URL (setters on protocol/pathname/search/hash) — fine under Expo's URL polyfill, not bare RN. `Response.prototype.text.call` and arrayBuffer/json are supported by RN fetch.
- @bb/server-contract: **reusable-as-is** — Runtime imports are zod, hono/client (`hc`; uses fetch/Headers/FormData/URLSearchParams), @bb/domain, @bb/host-daemon-contract, @bb/hono-typed-routes. No node builtins or DOM. `hono/client` and `hono/utils/http-status` (type-only) resolve via hono package exports (`./client`, `./utils/*`), so Metro package-exports resolution must be on (default in RN ≥0.79).
- @bb/hono-typed-routes: **reusable-as-is** — Only runtime import is `zod` (ZodError) in typed-routes.ts:39; hono imports are type-only. `typedRoutes` itself is server-side (needs a Hono app) but harmless to bundle.
- @bb/domain: **reusable-as-is** — Sole dependency is zod (packages/domain/package.json:36-38); no node/DOM APIs found (grep for node:, window, document, localStorage returned only comments). Uses setTimeout in debounced-callback-scheduler.ts. Includes large zod schemas (provider-event.ts 779 lines) — bundle size only.
- @bb/connect-client: **reusable-as-is** — zod + globalThis.fetch + URL (`new URL(...).origin/hostname/protocol/port`); needs spec-compliant URL (Expo polyfill). No node imports.
- @bb/host-daemon-contract (transitive via server-contract): **reusable-as-is** — zod + hono/client `hc` (local.ts:2, session.ts:2); no node builtins.
- @bb/core-ui (transitive via sdk/response.ts): **reusable-as-is** — Pure TS helpers depending only on @bb/domain.
- @bb/templates/generated (transitive via sdk areas/guide.ts): **reusable-as-is** — 117 KB generated data file with zero imports; the templates package's other entries pull gray-matter/handlebars but are not imported by the SDK.
- @bb/config (only ./app-surface needed): **headless-logic-only** — `@bb/config/app-surface` is a pure constants module (usable for the `x-bb-app-surface` header); `@bb/config/cli` and env.ts import node:os — do not import the CLI/server entries.

## Risks
- Remote access through the connect gate: the machine credential header (`x-bb-connect-machine`) is only honored for `/api/v1*` (apps/connect/src/worker.ts:393-425); `/ws` and `/ws/terminals/*` require a session cookie (worker.ts:430-463). A mobile client must mint the 1-hour desktop session cookie (`POST /api/connect/desktop-session`, servers.ts:332-379) or hold a better-auth cookie and attach it to fetch AND to the WebSocket handshake (RN WebSocket headers option), and renew hourly.
- Local-server access has no credential auth at all; only an Origin-header guard (apps/server/src/browser-request-guard.ts:147-175). RN fetch/WebSocket send no Origin so it passes, but any `Origin` header a library adds would be 403'd. The `x-bb-app-surface` header only has values `web|desktop` (packages/config/src/app-surface.ts:4) — a new `mobile` value would need server changes and telemetry plumbing.
- Metro resolution: `@bb/sdk` root export must NOT be used; `@bb/sdk/browser` resolves to unbuilt `dist/browser.js` under Metro's default `import` condition — add `source` to `resolver.unstable_conditionNames` (and keep `unstable_enablePackageExports`) plus monorepo `watchFolders`/`nodeModulesPaths`. Other @bb libs already point `default` at `src/*.ts`, so Metro must transpile TS from outside the app dir (works via babel-preset-expo since pnpm symlinks resolve to real paths).
- pnpm without `.npmrc` uses isolated symlinked node_modules; Expo autolinking/Metro historically prefers `node-linker=hoisted`. Adding hoisting repo-wide would change every package's install layout — validate before deciding.
- Web-platform API assumptions in shared code: full WHATWG `URL` (packages/sdk/src/realtime-url.ts:14-30, packages/connect-client/src/credential.ts:22-40), `AbortSignal.timeout/any` and `ReadableStream` in `createRequestTimeoutFetch` (packages/sdk/src/response.ts:100-140,220-249) — the latter is node-entry only, but do not reuse it in RN.
- Ephemeral broadcast messages (`thread-open`, thread pane action, `plugin-signal`) are sent to every connected socket regardless of subscription (apps/server/src/ws/hub.ts:741-809) and are ignored by the SDK realtime client (packages/sdk/src/realtime-client.ts:581-590); if mobile wants them it must parse them itself as apps/app/src/lib/ws.ts:100-150 does with the lenient schemas.
- The SDK's plugin/catalog/marketplace/skills areas construct raw `/api/v1/...` URLs from `transport.baseUrl` and use `transport.fetch` directly (packages/sdk/src/areas/plugins.ts:227-246, areas/skills.ts:131-185); any auth/header injection must be done in the injected `fetch`, not the hono client options.
- Binary/file routes (`fileContent`, `attachmentContent`, `storageFile`, `worktreeFile`, `rawFile`, `providerLogo`) return bytes; SDK reads them via `arrayBuffer()` (packages/sdk/src/areas/projects.ts:351,471) — fine in RN, but rendering images from bytes needs base64/data-URI conversion in RN (no Blob URLs).
- Voice transcription and attachment upload rely on `FormData` with `Blob`/`File` (packages/sdk/src/areas/system.ts:192-204, areas/projects.ts:363-378); RN's FormData expects `{uri,name,type}` file descriptors rather than Blob parts — expect to bypass the SDK for uploads on mobile.
- Contract-level `changedMessageLenientSchema` tolerates newer servers, but plugin route bodies are parsed with strict zod schemas in the SDK (`.strict()` in server-contract/src/api/plugins.ts) — server-side additive changes to those routes can break an older mobile build.

## Open questions
- Which remote-auth flow should mobile use against `<handle>.getbb.app`: better-auth session cookie (sign-in via apps/web `api.auth.$` — not read in this pass) vs. machine credential + hourly desktop-session cookie (desktop pattern, apps/desktop/src/connect-desktop-session.ts)? Does the gate need a first-class bearer/header auth for `/ws` so mobile does not need cookies?
- Should the server add a `mobile` value to `APP_SURFACE_VALUES` (packages/config/src/app-surface.ts:4) and what telemetry/UX behavior keys off it?
- Should `@bb/sdk` gain a `./react-native` entry (or should `./browser` accept `headers`/`websocketOptions`) so cookie/credential injection for both fetch and WebSocket is first-class rather than a per-app fetch/websocket wrapper?
- Will the repo adopt `node-linker=hoisted` (or a partial hoist pattern) for Expo, or rely on Metro symlink support with the default pnpm layout? Needs a spike.
- Should Metro build against `source` (TS from packages/*/src) or against built `dist` for `@bb/sdk`? The former mirrors Vite/vitest; the latter needs a turbo `^build` edge from apps/mobile.
- Are the ephemeral `thread-open` / pane-action / `plugin-signal` WS messages relevant on mobile (single-pane UI), or should mobile ignore them like the SDK does?
- Does the timeline delta path (`afterSequence` → `TimelineDelta`, server-contract/src/thread-timeline.ts:541-601) need to be reimplemented in the mobile query layer, or will mobile share apps/app's query hooks (out of this area's scope)?
