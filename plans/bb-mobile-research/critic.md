## Spot-checks (opened cited files)
Verified TRUE: `packages/sdk/src/browser.ts:31-40` (createBrowserBbSdk + module-level `bb`), `packages/sdk/package.json:5-38` ("." has a `browser` condition → dist/browser.js and `source` → src/node.ts, so `import "@bb/sdk"` under Metro with `source` first resolves the NODE entry — always import `@bb/sdk/browser`), `apps/server/src/browser-request-guard.ts:147-175` (Origin checked only if present), `apps/connect/src/worker.ts:393-425` (machine header only on /internal*, /api/v1*), `apps/connect/src/servers.ts:18` (1h desktop-session TTL), `apps/web/src/server/auth.ts:53-55` (crossSubDomainCookies), `apps/app/src/lib/ws.ts:58-150` (partysocket + thread-open/pane-action/plugin-signal parsing), `packages/sdk/src/realtime-client.ts:558-570` (SDK drops non-"changed"), `packages/thread-view/package.json` (deps domain/server-contract/zod, no `main`), `apps/app/src/lib/api.ts:75-77` (HTML 401/403 → "Authentication failed"), `apps/app/src/main.tsx:62-70`, `apps/app/src/lib/query-client.ts:145-155` (staleTime 2000, refetchOnWindowFocus, mutation error toasts), `apps/app/src/hooks/useThreadReadTracking.ts:41-55`, `apps/server/src/services/system/app-keybindings.ts:148-160`, `apps/app/src/components/ui/theme.css:408-409`, `packages/plugin-sdk/src/app-contract.ts:672`, `apps/app/index.html:5-8`, `.nvmrc`=22.12.0 vs engines >=22.19.0, ThreadTimelineRows 2221 lines / PromptBoxInternal 3445 / sidebar 2282, react-virtual only in DiffFilesPanel, `/system/attention` unused by app, no first-party plugin uses homepageSection/threadList/threadHeaderAction/newThreadPanelAction/contentScripts.

## (2) Wrong / imprecise claims
- mobile-pwa-today table row "Auth → send `x-bb-connect-machine` on fetch + WebSocket": WRONG for WS. The gate honors that header only on `/api/v1*` (`worker.ts:393-425`); `/ws` and `/ws/terminals/*` require a session cookie (`worker.ts:430-463`). auth-connect report is right.
- testing report: "RN WebSocket sends an Origin derived from the URL — passes". Unverifiable from repo. What IS verifiable: `Origin: null` (opaque WebView origins) is rejected because `new URL("null")` throws → 403 (`browser-request-guard.ts:105-110`); only absent Origin, exact allowlisted origin, request-target origin, or same-hostname+known-BB-port pass (:118-131). This also answers the secondary-panel report's open question about WebView terminals.
- ui-surface: `/auth/callback` route exists (`route-paths.ts`) but nothing in apps/server, plugins, or packages redirects to it — orphaned; ignore for mobile.
- Minor line drift: AppToaster is main.tsx:64, AppErrorBoundary :62.

## (1) Uncovered subsystems, filled in
**Attachments/images**: upload `POST /projects/:id/attachments` multipart with exactly one field named `file` (`apps/server/src/routes/projects.ts:859-877`); image ≤10 MiB, other ≤25 MiB (`services/projects/attachments.ts:21-22,145-152`); response `{type:"localImage"|"localFile", path(stored name), name, mimeType?, sizeBytes}` (`server-contract/src/api/projects.ts:548-556`); the client then sends `PromptInput` `{type:"localImage", path}` / `{type:"localFile", path,name,sizeBytes,mimeType}` / `{type:"image", url}` (`packages/domain/src/shared-types.ts:299-337`). Timeline user rows carry `attachments{webImages,localImages,localFiles,imageUrls,localImagePaths,localFilePaths}` (`server-contract/src/thread-timeline.ts:74-81`); the app renders `<img src="/api/v1/projects/:id/attachments/content?path=...">` (`ConversationAttachments.tsx:62-70`, `lib/file-content-urls.ts:12`). Assistant `image-view` work rows carry only `path` (`thread-timeline.ts:329-333`). `copyAttachments` moves attachments across projects (fork/handoff).
**Voice**: multipart `file` (+`prompt`) to `/system/voice-transcription` (`routes/system.ts:360-369`); server does NOT check container/MIME, only size ≤25 MB (`services/ai/voice-transcription.ts:27,250-255`); default `BB_TRANSCRIPTION=codex/gpt-transcribe` routed through the primary host daemon (`packages/config/src/defaults.ts:14`, `voice-transcription.ts:118-146`), else OpenAI with OPENAI_API_KEY; availability flag `voiceTranscriptionEnabled` in `/system/config` (`api/system.ts:229`).
**Telemetry**: server-side PostHog only (`apps/server/src/services/system/telemetry.ts:26-104`): events app_started, onboarding_*, thread_created, user_message_sent, plugin_installed with `app_surface` from `x-bb-app-surface` (`request-context.ts:56-64`; values only desktop|web, `packages/config/src/app-surface.ts:4`); production+release only; `BB_TELEMETRY=false`. No client analytics, no Sentry/crash reporting anywhere.
**Version/update**: `GET /system/version` `{currentVersion, latestVersion, source:"npm", updateAvailable, isDevelopment, upgradeCommand}` (`api/system.ts:258-273`) — server package updates; app badge shows only when not desktop (`useUpdateInventory.ts:130-135`).
**Deep links**: no custom scheme/AASA anywhere; only server→client `thread-open` WS broadcast `{threadId, split?, file?}` (`api/threads.ts:521-543`).
**Offline/connection**: no navigator.onLine use; `connection-aware-query-state.ts:10,34-66` treats load errors as "loading" for 10 s while WS ≠ connected, then "unavailable"; send/edit mutations consult `wsManager.getConnectionState()` to decide follow-up invalidation (`thread-runtime-mutations.ts:198,217`); on WS reconnect ALL realtime queries are invalidated (`realtime-cache-effects.ts:304-316`); main `/ws` has no ping/pong and no resume/sinceSeq (`ws/client-protocol.ts:1-58`, hub.ts grep).
**WS side effect**: subscribing `thread-detail`/`environment-detail` drives host-daemon watch sets (workspace/thread-storage watching) via `apps/server/src/ws/watch-interests.ts` — mobile subscriptions create daemon load; unsubscribe on background.
**Project creation**: `POST /projects {name, source:{type:"local_path", hostId, path}}` (`api/projects.ts:37-42,62-65`); sources may be `local_path` or `clone{remoteUrl?,targetPath?}` (:44-52); project kinds standard|personal, `proj_personal` always exists (`domain/src/project.ts:3-16`); server dedups by host+path (`routes/projects.ts:363-370`). Path browsing `GET /hosts/:id/directory`; native picker only when clientHostId===hostId.
**Thread create/env picking**: `POST /threads` (`api/threads.ts:99-133`): projectId, origin ("app"), input[], optional providerId/model/serviceTier(fast|default)/reasoningLevel(none…ultra, `shared-types.ts:14-23`)/permissionMode(accept-edits<auto<full, :44), `environment` ∈ `{type:"project-default"}` | `{type:"reuse", environmentId}` | `{type:"host", hostId, workspace: unmanaged{path,branch?} | managed-worktree{baseBranch: named|default} | personal}` (`api/shared.ts:62-150`), parentThreadId, sectionId. `project-default` lets mobile skip picker policy. There is NO environments-list route; the reuse-worktree picker derives options from thread list entries' `environmentId/Name/BranchName` (`WorktreePicker.tsx:32-42`, `domain/src/thread.ts:419-428`). Execution options: `GET /system/providers` (capabilities incl. permissionModes, supportsFork/SessionRewind, composerActions skills/plan/goal; `provider-types.ts:28-78`) and `GET /system/execution-options?providerId&hostId|environmentId` → models w/ supportedReasoningEfforts + permissionCeiling (`api/system.ts:36-59`).
**Thread mutations**: `PATCH /threads/:id {title,sectionId,parentThreadId,model,reasoningLevel,visibility}` (`api/threads.ts:448-470`); `DELETE` body `{childThreadsConfirmed}` (:443-445); statuses idle/starting/active/stopping/error + display provisioning/host-reconnecting/waiting-for-host (`thread.ts:26-31`); list query filters (archived, sectionId, hasParent, originKind, includeHidden, limit/offset; `threads.ts:616-636`); search needs ≥2 chars (:638-642).
**Sidebar bootstrap**: `GET /projects/sidebar-bootstrap` = sections + every project with ALL non-archived visible threads inline + defaultExecutionOptions (`routes/projects.ts:209-217,251`, `api/projects.ts:520-546`) — one unpaginated payload.
**Timeline defaults**: segmentLimit default 20, max 100 (`services/threads/timeline.ts:169-171`), web app uses defaults; `timelineWindowEventBudget` 1500 feature flag (`domain/src/feature-flags.ts:12-37`); thread open = `GET /threads/:id?include=environment,host` + timeline prefetch (`thread-queries.ts:601-623`).
**Provider CLI / login**: status record per CLI `{installed,currentVersion,latestVersion,needsUpdate,installAction{command}}` (`host-daemon-contract/src/local.ts:217-238`), install NDJSON events started/output/completed/error (:250-297). bb never drives provider login — user runs `codex login` / `claude /login` / `cursor-agent login` in a terminal (`onboarding.ts:55-69`, `OnboardingFlow.tsx:228-231`), so a phone cannot complete provider sign-in.
**Pending interactions**: approval subjects command/file_change/permission_grant/plan (`pending-interactions.ts:126-183`), resolutions `{decision: allow_once|allow_for_session|deny}` | `{kind:"user_answer", answers: Record<qid,{selected[≤4], freeText?≤4096}>}` | `{kind:"plugin_submitted"}` (:393-433).
**Mentions**: "@" default mention trigger (plugins may register @ # $ ! ~, `plugin-sdk/src/internal/host-policy.ts:199-209`), "/" commands (`shared-types.ts:190-193`); resource kinds thread/project/section/path/command/plugin (:216-263).
**Localhost links**: markdown links to localhost/127.0.0.1 are rewritten to the app's current hostname (`localhost-link-rewrite-preference.ts`, `markdown-preview.tsx:618-626`); connect plugin `expose/unexpose` RPC shares host ports (`plugins/connect/src/rpc.ts:113-114`).
**Experiments/flags**: `editMessages` default true, `newOnboarding` false (`experiments.ts:29-34`).
**No thread-completion toasts**: attention only via sidebar glyphs/favicon/title; no toasts from realtime effects.
**Process constraints (AGENTS.md)**: any new server route for mobile (push tokens, bearer auth, mobile app-surface) must ship SDK + `bb` CLI surfaces and docs; daemon changes bump HOST_DAEMON_PROTOCOL_VERSION; new plugin API members need `experimental_` + docs/api_to_audit.md.

## Key files
- packages/server-contract/src/api/environments.ts
- packages/server-contract/src/api/threads.ts
- packages/server-contract/src/api/shared.ts
- packages/server-contract/src/api/projects.ts
- packages/server-contract/src/api/system.ts
- packages/server-contract/src/thread-timeline.ts
- packages/domain/src/shared-types.ts
- packages/domain/src/thread.ts
- packages/domain/src/environment.ts
- packages/domain/src/host.ts
- packages/domain/src/project.ts
- packages/domain/src/provider-types.ts
- packages/domain/src/pending-interactions.ts
- packages/domain/src/feature-flags.ts
- packages/domain/src/experiments.ts
- packages/host-daemon-contract/src/local.ts
- packages/plugin-sdk/src/internal/host-policy.ts
- packages/sdk/package.json
- packages/sdk/src/browser.ts
- packages/sdk/src/realtime-client.ts
- apps/server/src/browser-request-guard.ts
- apps/server/src/request-context.ts
- apps/server/src/routes/projects.ts
- apps/server/src/routes/threads/data.ts
- apps/server/src/services/projects/attachments.ts
- apps/server/src/services/ai/voice-transcription.ts
- apps/server/src/services/system/telemetry.ts
- apps/server/src/services/system/onboarding.ts
- apps/server/src/services/threads/timeline.ts
- apps/server/src/ws/watch-interests.ts
- apps/server/src/ws/client-protocol.ts
- apps/connect/src/worker.ts
- apps/connect/src/servers.ts
- apps/web/src/server/auth.ts
- apps/app/src/lib/ws.ts
- apps/app/src/lib/api.ts
- apps/app/src/lib/query-client.ts
- apps/app/src/lib/file-content-urls.ts
- apps/app/src/lib/localhost-link-rewrite-preference.ts
- apps/app/src/hooks/realtime-cache-effects.ts
- apps/app/src/hooks/queries/connection-aware-query-state.ts
- apps/app/src/hooks/mutations/thread-runtime-mutations.ts
- apps/app/src/hooks/queries/thread-queries.ts
- apps/app/src/hooks/useUpdateInventory.ts
- apps/app/src/hooks/useThreadReadTracking.ts
- apps/app/src/components/thread/timeline/ConversationAttachments.tsx
- apps/app/src/components/pickers/WorktreePicker.tsx
- apps/app/src/components/pickers/environment-picker-value.ts
- apps/app/src/components/onboarding/OnboardingFlow.tsx
- apps/app/src/views/thread-detail/ThreadDetailView.tsx
- apps/app/src/main.tsx
- packages/config/src/app-surface.ts
- packages/config/src/defaults.ts
- AGENTS.md

## Reuse verdicts
- @bb/sdk (root '.' export): **not-reusable** — package.json '.' maps source→src/node.ts (node:os via @bb/config/cli, ws, Buffer) and import/default→dist/node.js; Metro with a `source` condition would pick node.ts. Import `@bb/sdk/browser` only.
- @bb/sdk/browser: **reusable-with-small-changes** — Needs Metro `source` condition or built dist; global fetch/WebSocket/URL; upload+voice paths use Blob/File FormData semantics that RN's FormData handles differently; header/cookie injection must go through injected fetch and a custom websocket factory.
- @bb/domain, @bb/server-contract, @bb/thread-view, @bb/core-ui, @bb/host-daemon-contract: **reusable-as-is** — Pure zod/TS; grep for node:/Buffer/process found nothing (only `arrayBuffer` false positives). Only packaging: exports point at src/*.ts with NodeNext `.js` specifiers → Metro needs `unstable_enablePackageExports` + `.js`→`.ts` resolver.
- apps/app hooks (query keys, cache owners, realtime-cache-effects, connection-aware-query-state, mutations): **headless-logic-only** — Logic is React Query only, but modules import `@/lib/ws` (partysocket + window.location), `@/lib/sdk` (window.location.origin fetch wrapper) and react-router in places; extractable with DI of sdk/ws.
- apps/app/src/lib/localhost-link-rewrite-preference.ts, lib/prompt-attachments.ts, components/pickers/environment-picker-value.ts: **reusable-as-is** — Pure functions (URL parsing only); jotai atom parts depend on localStorage via browser-storage.
- apps/app/src/lib/api.ts (transcribeVoiceInput, postMultipart): **headless-logic-only** — Uses browser File; RN must build FormData with {uri,name,type}. Server accepts any container/MIME ≤25 MB.

## Risks
- mobile-pwa-today's auth replacement (machine header on WebSocket) is wrong: connect gate rejects /ws without a session cookie; realtime would silently 401 through connect.
- Opaque `Origin: null` from a WebView is hard-rejected by browserRequestProblem (new URL('null') throws) — any WebView-hosted terminal/diff/plugin shell must load from the bb server origin or have RN own the socket.
- Subscribing thread-detail/environment-detail over /ws pushes watch sets to the host daemon (watch-interests.ts); a mobile app that keeps subscriptions alive in background or subscribes broadly will keep daemons watching filesystems.
- No WS resume: every reconnect (frequent on mobile) invalidates all realtime queries; combined with a single unpaginated sidebar-bootstrap payload this can be expensive on large installs.
- Provider sign-in cannot be completed from a phone: bb shows a CLI login command to run in a terminal; onboarding on mobile must assume an already signed-in host.
- Attachment upload requires exactly one multipart field named `file`; RN FormData quirks (extra fields, missing filename) yield 400s (routes/projects.ts:864-877).
- Telemetry app_surface only knows desktop|web; a mobile client without a new value pollutes 'web' funnels.
- `@bb/sdk` root import is a trap under Metro `source` condition (resolves node.ts); enforce `@bb/sdk/browser` via lint.
- No client-side crash reporting exists anywhere; mobile will need its own (server has PostHog product events only).

## Open questions
- Should mobile use `environment: {type:'project-default'}` for thread creation to avoid re-implementing host/worktree/branch picker policy, given no environments-list route exists and reuse options are derived from thread list entries?
- Will the connect gate accept a bearer/header credential on /ws for mobile, or must mobile mint the 1h desktop-session cookie and attach it to fetch, WebSocket, and Image requests (attachment images are plain GET URLs)?
- Should a `mobile` AppSurface be added (server + telemetry + request-context) before mobile ships, per the SDK/CLI parity rule in AGENTS.md?
- Given no WS resume and full invalidation on reconnect, should the server add a since-cursor to /ws (protocol change) or should mobile rely on timeline `afterSequence` deltas plus targeted refetch on foreground?
- Does mobile need `copyAttachments`/fork/handoff flows (location.state seeds on web) in v1?
