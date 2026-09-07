## Plugin system: architecture facts

**Two halves.** Backend `server.ts` runs in the bb server (Node) against `BbPluginApi` (`packages/plugin-sdk/src/backend-contract.ts:829-875`): `settings`, `storage` (kv + better-sqlite3), `http` (`/api/v1/plugins/<id>/http/*`), `rpc` (`POST /api/v1/plugins/<id>/rpc/<method>`), `realtime.publish` (WS `plugin-signal` broadcast, `packages/server-contract/src/api/shared.ts:185-193`), `background.service/schedule`, `cli.register` (`bb <name>`, proxied via `POST /plugins/:id/cli`, `apps/server/src/routes/plugins.ts:245-286`), `agents.configure/registerTool/contributeInstructions/experimental_registerProvider` (`backend-contract.ts:587-672`), `ui.requestInput` + `ui.registerMentionProvider` (`backend-contract.ts:727-742`), `events.on`, `hosts.*` (daemon worker). Optional `host.ts` runs in the host daemon. Frontend `app.tsx` is a `definePluginApp((app)=>...)` module registering `app.slots.*` (`packages/plugin-sdk/src/app-contract.ts:845-890`): homepageSection, settingsSection, navPanel (route `/plugins/:pluginId/:panelPath/*`, `apps/app/src/lib/route-paths.ts:63`; optional `fixedTabs`, `experimental_sidebarAccessory`, `headerContent`), threadPanelAction, experimental_newThreadPanelAction, pendingInteraction, sidebarFooterAction (host chrome + JS `run`), experimental_threadList, experimental_threadHeaderAction, fileOpener, messageDirective (`::id{...}` in assistant markdown), messageAction (host chrome + JS `run`), experimental_providerIcon; plus `app.composer.customize` (actions/banners components, host-rendered plusMenu rows with JS `run`, richText effects; `app-contract.ts:1023-1083`) and `app.contentScripts.register` (trusted DOM scripts, `app-contract.ts:928-946`). There is **no tool-renderer or timeline-renderer slot**; the only tool presentation hook is server-side `experimental_statusLabels` on `registerTool`, delivered on toolCall events (`packages/domain/src/provider-event.ts:356-358`). Every slot's `component` is `ComponentType<...>` from react-dom land (e.g. `PointerEvent<HTMLElement>` in `app-contract.ts:672`).

**How frontends load (web only).** `usePluginFrontendBoot` (`apps/app/src/hooks/usePluginFrontendBoot.ts:13-19`) → `bootPluginFrontends` (`apps/app/src/lib/plugin-frontend.ts:967-979`): installs `globalThis.__bbPluginRuntime` = {react, react-dom, react-dom/client, jsx runtimes, `pluginSdkApp`, 10 portaling Radix families, sonner, vaul, @pierre/diffs} (`plugin-frontend.ts:1-25, 231-259`), fetches `GET /api/v1/plugins`, and for each `status==="running"` plugin with `app.bundle.compatible` does `<link rel=stylesheet>` injection (`plugin-frontend.ts:330-352`) and `import(/* @vite-ignore */ jsUrl)` (`plugin-frontend.ts:917`). Assets are `GET /api/v1/plugins/:id/assets/app.js|app.css?h=<hash>` (`apps/server/src/services/plugins/app-bundle.ts:337-372`, route `apps/server/src/routes/plugins.ts:297-349`). No iframes, no module federation: bundles are plain ESM built by `bb plugin build` (esbuild `platform:"browser"`, `format:"esm"`, `packages/plugin-build/src/build-plugin-app.ts:494-519`) with the shared packages replaced by shims that read `globalThis.__bbPluginRuntime.<slot>` and **throw if absent** (`build-plugin-app.ts:63-85, 148-168`). Plugin CSS is Tailwind compiled under `@scope ([data-bb-plugin="<id>"], ...)` (`build-plugin-app.ts:397-453`) and depends on the host's live theme variables (`packages/plugin-build/src/generated/plugin-theme.generated.ts:1-20`); `PluginSlotMount` provides the `data-bb-plugin` root + error boundary + `PluginContext` (`apps/app/src/components/plugin/PluginSlotMount.tsx:217-249`). Host hook impls (`apps/app/src/lib/plugin-sdk-hooks.ts`): `useRpc` = fetch POST (`:135-177, 213-227`), `useRealtime` = `wsManager.onPluginSignal` (`:229-247`), `useBbNavigate` = react-router (`:275-347`), `useSettings` = `GET /plugins/:id/settings` (`:185-211`); host components `ThreadChat`/`Markdown`/`experimental_NewThreadComposer` (`apps/app/src/lib/plugin-sdk-app-impl.tsx:44-67`). Slot registrations live in a `useSyncExternalStore` store (`apps/app/src/lib/plugin-slots.ts:27-49, 245-277`). Content scripts get a DOM-mutation fence (`apps/app/src/lib/foreign-dom-mutation-guard.ts:1-38`). `packages/plugin-registry` is a shadcn component registry (Radix/Tailwind, `registry.json`, `r/*.json`) — DOM only.

**Auth from a native client.** RPC/CLI/mention-search use `browserRequestProblem` (`apps/server/src/browser-request-guard.ts:150-176`): Origin is checked only if present; POST must be `content-type: application/json`. RN `fetch` sends no Origin, so plugin RPC/CLI work from native. `@bb/sdk` already has `plugins.callRpc` (`packages/sdk/src/areas/plugins.ts:378-384`) and `threads.interactions.respond/cancel` (`packages/sdk/src/areas/threads.ts:723-770`).

**First-party plugin survey (plugins/*).** All 18 ship `bb.app` (`package.json`), all are React-DOM + Tailwind + `@bb/shared-ui`:
- ask-user-question: server `agents.registerTool` + `ui.requestInput`; app `pendingInteraction` id `ask-user-question` (`plugins/ask-user-question/app.tsx:561-566`), payload is JSON validated by `interactionPayloadSchema` (`plugins/ask-user-question/src/contracts.ts:64-80`); form uses `window.addEventListener`, HTMLTextAreaElement.
- secrets: server `cli` + `ui.requestInput`; app `pendingInteraction` id `secret-request` (`plugins/secrets/app.tsx:217`), payload `secretRequestPayloadSchema`.
- side-chat: server rpc `createSideChat`/`sendToMain` (`plugins/side-chat/server.ts:146-174`); app `messageAction` + `threadPanelAction` rendering host `ThreadChat` on a hidden fork thread (`plugins/side-chat/app.tsx:321-355`).
- inline-vis: server rpc; app `messageDirective` `inline-vis` rendering `<iframe sandbox="allow-scripts">` of `/api/v1/threads/:id/worktree/files/<file>` (`plugins/inline-vis/app.tsx:190-215`).
- docs: server http×8, rpc, cli, mention provider, background; app `navPanel` (fixedTabs), `threadPanelAction`, `fileOpener` md/mdx/markdown, `messageDirective` `docs` (`plugins/docs/app.tsx:2221-2251`), tiptap/ProseMirror editor, `document.createElement`.
- tasks: server rpc×3, http×3, cli, events, mention provider; app `navPanel` (+sidebarAccessory, fixedTabs), `threadPanelAction` `task`, `messageDirective` `task` (`plugins/tasks/app.tsx:7-32`); tiptap, localStorage, matchMedia, ResizeObserver.
- github: server rpc, cli, background, settings, mention providers×2; app `navPanel` + `threadPanelAction` `pull` (`plugins/github/app.tsx:2493`), `@pierre/diffs` FileDiff, MutationObserver, localStorage, window.open.
- automations: server rpc, cli, background, events; app `navPanel` (`plugins/automations/app.tsx:875`), the web app hardcodes its routes (`route-paths.ts:44-52`).
- workflows: server `agents.registerTool`×2, `agents.configure`, rpc, cli, background; app `composer.customize` banner `active-runs`, `messageDirective` `workflow-preview`, `threadPanelAction` (`plugins/workflows/src/app.tsx:971`).
- connect: server rpc (status/pair/expose/unexpose/disconnect), cli, background tunnel, `contributeInstructions`; app `settingsSection` `remote-access` (QR pairing, `navigator.clipboard`) + `sidebarFooterAction` (`plugins/connect/app.tsx:1177-1192`).
- custom-instructions / memory / keep-awake: server rpc + cli (+ `hosts.experimental_client` for keep-awake); app `settingsSection` only.
- provider-retry: server events/background/settings/cli only; no app entry — the queued row narrates the wait (its composer banner and the RPC pair behind it were removed).
- provider-acp/claude-code/codex/pi: server `experimental_registerProvider`; app only `experimental_providerIcon` inline SVG (`plugins/provider-codex/app.tsx:23-28`); server also serves branding SVG at `/assets/icon`.
- No first-party plugin uses homepageSection, threadList, threadHeaderAction, newThreadPanelAction, contentScripts (only `examples/plugins/*` do).

**Server-side (works for any client automatically):** agent tools + statusLabels, skills, CLI commands, background services/schedules, thread events, mention providers (search `GET /plugins/mentions/search`, `routes/plugins.ts:212-240`; resolve at send; mention resource `kind:"plugin"` `packages/domain/src/shared-types.ts:249-263`), declarative settings schema (`packages/server-contract/src/api/plugins.ts:318-349`), plugin management (`installedPluginSchema` `:181-219`), pending-interaction plumbing (`packages/domain/src/pending-interactions.ts:329-333, 461-465`; app fallback = "form unavailable, Cancel" `PluginPendingInteractionComposer.tsx:112-126`), unknown message directives render as literal text (`apps/app/src/components/ui/markdown-message-directives.tsx:288-292`), plugin panel tab persistence is JSON (`apps/app/src/lib/fixed-panel-tabs-state.ts:212-246`).

**Feasibility matrix (ranked by value/effort):**
1. **(a) skip frontends + (c)-lite native subset** — low effort, high value. Everything server-side already works; add native renderers keyed on `origin.rendererId` for `ask-user-question` and `secret-request` payloads (JSON schemas above) so threads never block; native mention menu over `/plugins/mentions/search`; native declarative settings; provider icons via `iconUrl` SVG; literal directives; treat side-chat forks as ordinary threads (call `createSideChat` rpc natively).
2. **(b) WebView per panel** — high effort, medium-high value. Requires a new bb-served "plugin host shell" page that installs the full `__bbPluginRuntime` (react-dom, 10 Radix families, sonner, vaul, pierre) plus a bridged `pluginSdkApp` (rpc via same-origin fetch, navigate/composer/openPanel via postMessage, realtime via WS), host theme.css, `<div data-bb-plugin>` scope, cookie/auth sharing, and must be same-origin (Origin check). Precedent: `installTestPluginRuntime`/`renderSlot` harness (`packages/plugin-sdk/src/testing/app.tsx:62-85, 494, 835`). Unlocks docs/tasks/github/automations/workflows navPanels, threadPanelActions, fileOpeners, settingsSections. Not for `ThreadChat`-based panels (side-chat needs the whole timeline engine), composer banners, message/plus-menu/sidebar `run` callbacks, threadList, content scripts.
3. **(c)-full declarative JSON UI API** — high effort (new `experimental_` SDK surface + docs/api_to_audit.md + server + web + native + plugin adoption), value only after adoption.
4. **(d) hidden WebView projecting slots** — not viable: slots are opaque React DOM components; only host-rendered chrome metadata (title/icon/id) is projectable, and `run` callbacks would still need a bridge. Reduces to (b) with more moving parts.

## Key files
- packages/plugin-sdk/src/app-contract.ts
- packages/plugin-sdk/src/app.ts
- packages/plugin-sdk/src/backend-contract.ts
- packages/plugin-sdk/src/internal/plugin-app-collector.ts
- packages/plugin-sdk/src/testing/app.tsx
- packages/plugin-build/src/build-plugin-app.ts
- packages/plugin-build/src/generated/plugin-theme.generated.ts
- packages/plugin-registry/registry.json
- apps/app/src/hooks/usePluginFrontendBoot.ts
- apps/app/src/lib/plugin-frontend.ts
- apps/app/src/lib/plugin-sdk-app-impl.tsx
- apps/app/src/lib/plugin-sdk-hooks.ts
- apps/app/src/lib/plugin-slots.ts
- apps/app/src/lib/plugin-slot-resolvers.ts
- apps/app/src/lib/fixed-panel-tabs-state.ts
- apps/app/src/lib/foreign-dom-mutation-guard.ts
- apps/app/src/components/plugin/PluginSlotMount.tsx
- apps/app/src/components/plugin/PluginPendingInteractionComposer.tsx
- apps/app/src/components/plugin/PluginThreadChat.tsx
- apps/app/src/components/plugin/PluginSettings.tsx
- apps/app/src/components/ui/markdown-message-directives.tsx
- apps/server/src/routes/plugins.ts
- apps/server/src/services/plugins/app-bundle.ts
- apps/server/src/browser-request-guard.ts
- packages/server-contract/src/api/plugins.ts
- packages/server-contract/src/api/shared.ts
- packages/domain/src/pending-interactions.ts
- packages/domain/src/provider-event.ts
- packages/domain/src/shared-types.ts
- packages/sdk/src/areas/plugins.ts
- plugins/ask-user-question/app.tsx
- plugins/ask-user-question/src/contracts.ts
- plugins/secrets/app.tsx
- plugins/side-chat/app.tsx
- plugins/side-chat/server.ts
- plugins/inline-vis/app.tsx
- plugins/tasks/app.tsx
- plugins/docs/app.tsx
- plugins/github/app.tsx
- plugins/workflows/src/app.tsx
- plugins/connect/app.tsx
- plugins/provider-codex/app.tsx
- docs/api_to_audit.md
- docs/plugin-marketplace-plan.md

## Reuse verdicts
- @get-bb/plugin-sdk (root: backend-contract, app-contract, rpc-contract, json-value types): **reusable-as-is** — Type-only surface plus tiny pure helpers (PLUGIN_CLI_OUTPUT_MAX_BYTES, experimental_defineHostEntry). Useful for typing plugin RPC contracts/pending-interaction payloads in RN. Note app-contract types reference react ComponentType and DOM PointerEvent<HTMLElement> (app-contract.ts:672) — types compile but describe DOM components.
- @get-bb/plugin-sdk/app (runtime facade): **not-reusable** — Reads globalThis.__bbPluginRuntime.pluginSdkApp (app.ts:45-70); the contract (PluginSdkApp, app-contract.ts:1451-1521) is react-dom components/hooks tied to react-router, wsManager, composer DOM. Only meaningful if the RN app supplies its own runtime — and plugin bundles still need react-dom/Radix.
- @get-bb/plugin-sdk/internal/plugin-app-collector + composer-customization-validation: **reusable-as-is** — Pure JS validation of registrations; runs anywhere. Only useful if bundles are evaluated in-process, which Hermes cannot do because bundles import react-dom/Radix shims.
- @get-bb/plugin-sdk/internal/host-policy: **reusable-as-is** — Pure zod/policy; server-side concern, no client need.
- @bb/plugin-build: **not-reusable** — Node build tool (node:fs, esbuild, @tailwindcss/node/oxide); N/A for a client. Its RUNTIME_SLOT_BY_SPECIFIER (build-plugin-app.ts:63-85) defines what any WebView host shell must provide.
- @bb/plugin-registry (shadcn component registry): **not-reusable** — Radix/Tailwind DOM component sources (registry.json uiItems, r/*.json); no RN equivalents.
- Plugin frontend bundles (plugins/*/dist/app.js) and plugins/*/app.tsx sources: **not-reusable** — ESM built with esbuild platform:browser; shims throw without globalThis.__bbPluginRuntime (build-plugin-app.ts:155-160); JSX is HTML+Tailwind classNames; docs/tasks use tiptap (ProseMirror DOM), github uses @pierre/diffs + MutationObserver + localStorage, inline-vis uses <iframe>, ask-user-question uses window keydown + HTMLTextAreaElement. Runnable only inside a WebView with a host shell page.
- apps/app/src/lib/plugin-frontend.ts (loader/reconciler): **not-reusable** — Dynamic import(url) of ESM, document.head <link> injection, window pagehide, react-dom/Radix imports (lines 1-25, 330-352, 917, 954).
- apps/app/src/lib/plugin-slots.ts (slot store): **headless-logic-only** — Pure useSyncExternalStore store; nothing to store in RN unless a native slot contract exists.
- apps/app/src/lib/plugin-sdk-hooks.ts callPluginRpc / fetchPluginSdkSettings: **reusable-with-small-changes** — Pure fetch functions (lines 135-177, 185-211) use root-relative URLs; need absolute base URL + auth headers. The React hooks around them depend on react-router, wsManager, composer DOM.
- apps/app/src/components/plugin/* (slot mounts, panels, composer hosts, settings, management UI): **not-reusable** — React DOM + Tailwind + Radix + react-router + jotai + dnd-kit; only the data-shape logic (plugin-status.ts, plugin-slot-resolvers.ts) is headless.
- Server plugin API (/api/v1/plugins*, rpc, cli, mentions/search, settings, assets) + @bb/sdk plugins/interactions areas: **reusable-as-is** — Callable from RN fetch: local auth checks Origin only when present and requires content-type application/json on POST (browser-request-guard.ts:150-176). Bundle URLs are useful only to a WebView.
- Plugin backends (plugins/*/server.ts, host.ts) — agent tools, CLI, services, mention providers, requestInput, providers: **reusable-as-is** — Server/daemon-side; work automatically for any client. Their UI counterparts (pending-interaction forms, panels) do not.

## Risks
- Without native pending-interaction renderers, ask-user-question and secrets prompts show 'form unavailable' and the only action is Cancel (PluginPendingInteractionComposer.tsx:112-126) — agents using the cross-provider question tool block on mobile.
- Native renderers hardcoded per rendererId (ask-user-question, secret-request) couple the app to plugin payload schemas that live in plugin source (plugins/ask-user-question/src/contracts.ts, plugins/secrets/src/contracts.ts); third-party plugins' interactions remain unrenderable.
- A WebView-hosted plugin shell must be served same-origin with the bb server (plugin fetches are root-relative, e.g. plugins/side-chat/app.tsx:71; local auth 403s on foreign Origin) and must ship the exact __bbPluginRuntime slot set or bundles throw at import (build-plugin-app.ts:155-160); SDK-major gating (app-bundle.ts:367) must be honored.
- Plugin CSS depends on host theme variables and fonts (plugin-theme.generated.ts) — a WebView shell must include apps/app/src/components/ui/theme.css and sync theme/dark mode with the native app.
- ThreadChat/Markdown/experimental_NewThreadComposer are host components (plugin-sdk-app-impl.tsx:56-60); side-chat's panel is entirely ThreadChat, so a lightweight shell cannot host it — only the full app can.
- Host-rendered chrome slots (messageAction, sidebarFooterAction, threadPanelAction run, composer plusMenu) are metadata plus plugin JS `run` callbacks; a native app can list them but cannot execute `run` without a JS runtime + bridge.
- plugin-signal WS is broadcast to all clients with no per-channel subscription (server-contract/shared.ts:175-183); multiple WebViews would each need a socket or a native bridge.
- Any new native/declarative plugin surface must ship with experimental_ prefix and a docs/api_to_audit.md entry (AGENTS.md), and needs both web and native implementations plus plugin adoption before it delivers value.
- Provider icons come only from experimental_providerIcon inline SVG components; native must fall back to server-served branding SVG (iconUrl) which uses currentColor and may render black on dark themes (app-contract.ts:820-829 note).
- Message directives from tasks/docs/workflows/inline-vis will render as literal `::task{...}` text in a native markdown renderer unless handled (markdown-message-directives.tsx:288-292).

## Open questions
- Should the native app render pending interactions generically (a new declarative form payload the server understands) or hardcode ask-user-question and secret-request payload schemas for v1?
- Is a bb-served 'plugin host shell' HTML route (single slot mount with bridged pluginSdkApp) worth building in apps/app, and which slots would it target first (navPanel for docs/tasks/github/automations vs threadPanelAction)?
- How will the native app authenticate WebView loads of /api/v1/plugins/:id/assets and same-origin plugin RPC (cookie vs token header injection) when connected via getbb.app connect?
- Should message directives ids (task, docs, workflow-preview, inline-vis) get native card renderers backed by plugin RPC calls, or fall back to literal text / hidden?
- Does product want plugin management (install/enable/settings) in the native app at all, or read-only status plus declarative settings?