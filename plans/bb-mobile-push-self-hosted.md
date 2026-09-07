# Mobile push notifications on self-hosted bb servers

Date: 2026-09-01. Branch: `bb/add-mobile-push-notifications-thr_nuee4d9q4w`.
Decisions settled with the owner on 2026-09-01 (see "Decisions").

## The constraint

The APNs auth key and the FCM service account belong to the app publisher.
Apple binds the APNs key to the Apple team that signs the `app.getbb.mobile`
bundle. Google binds the FCM credential to the Firebase project of the store
app. A self-hoster can never hold these keys for the store build. A
self-hosted bb server therefore cannot call APNs or FCM itself.

The keys must live in a service that the publisher runs. There are two
candidates:

1. Expo's push service. The EAS project already exists
   (`extra.eas.projectId` in `apps/mobile/app.json`). EAS stores the APNs key
   and the FCM credential. Any server can post to `https://exp.host` with an
   Expo push token and no secret.
2. bb connect (`apps/connect`, a Cloudflare worker). It already authenticates
   every bb server and every phone by an account-scoped credential.

The self-hosted bb server needs a network path to one of these two relays.
Nothing else is possible for the store app. A server with no internet route
cannot send pushes in any design.

## How the token flows

1. The app asks iOS for a device token. Apple mints it. It identifies "the bb
   app on this phone."
2. The app sends that token and the EAS project id to Expo. Expo mints an
   Expo push token and stores the mapping.
3. The app hands the same Expo push token to every server profile on the
   phone. Servers only store a copy. They mint nothing.
4. A server posts `{token, title, body, data}` to `exp.host`. Expo signs the
   request with the publisher's APNs key. Apple delivers it.

The token is per phone, not per server. A push cannot name its server; the
phone resolves that on tap.

## What other self-hosted apps do

Every one runs a publisher relay. Nobody hands the store app's keys to
self-hosters. Home Assistant, Matrix, and ntfy use an unauthenticated relay
where the token is the capability. Zulip, Bitwarden, and Nextcloud use a
server-authenticated relay, and Zulip and Nextcloud keep the raw token away
from the server. ntfy, Matrix, and Mattermost's ID-only mode send an id and
let the app fetch the text. Only Android has a no-cloud fallback (Home
Assistant's WebSocket local push).

## Options

### Option A. Server posts to the Expo Push API directly (chosen)

- Keys: APNs and FCM keys stay in EAS. bb connect holds nothing. The bb
  server holds only Expo push tokens.
- Self-hosted: works for every server that can reach `exp.host`. Works in
  Direct mode with no bb connect pairing.
- Security: a token is a capability to send. It cannot read anything. It
  lives in the phone, in Expo, and in each server's database. The damage
  from a leak is spam. The leak paths are a server the user does not
  control, or someone who can already read a server's database or API.
- Shared risk: Expo rate-limits per project. A flood against one leaked
  token affects every bb user. Expo's enhanced push security would stop it,
  but it needs a secret on every sender, which only a publisher-run relay can
  hold.

### Option B. Server sends through bb connect (later, if needed)

The phone registers its token with connect against its machine row. The
server says "notify my account's phones." Connect checks that the server and
the phone share an account, then posts to Expo with the access token from a
worker secret. The server never sees a token, a dashboard revoke stops
pushes, and enhanced push security becomes possible. Requires connect
pairing. Start it only when abuse appears or users want the account
guarantee. The phone-to-server registration route stays the same in both
designs, so the upgrade needs no phone change.

### Rejected

- Option C, connect calling APNs and FCM directly: only if Expo becomes a
  problem.
- Option D, self-hosters with their own keys: only with their own app build.
  `BB_EXPO_PUSH_URL` already lets a fork point at its own relay.
- Web push with VAPID: browsers only.

## What already exists

Commit `b0362ef65` on `origin/bb-mobile-4-push` (2026-08-19, one commit, never
merged, 400 commits behind `main`) implements the full pipeline for Option A:

- `packages/db` table `push_subscriptions {id, expoPushToken, platform,
  deviceLabel, createdAt, lastSeenAt}` and data helpers.
- `packages/server-contract` + `apps/server/src/routes/notifications.ts`:
  `GET/POST /api/v1/notifications/push-subscriptions`, `DELETE …/:id`.
- `apps/server/src/services/notifications/push-sender.ts`: subscribes to the
  hub change stream, coalesces per thread for 2 s, drops the push when the
  thread was read, posts batches of 100 to `exp.host`, deletes rows on
  `DeviceNotRegistered`.
- SDK area `sdk.notifications.pushSubscriptions`, CLI
  `bb notifications push-subscriptions`, config env vars, docs, guide, skill.
- Mobile: registration policy, MMKV store, `PushNotificationsHost`, badge
  sync, per-profile toggle, first-run sheet, tap routing.

A dry merge onto `main` reports 15 conflicts: the Drizzle journal and
snapshot, `packages/db` index files, `apps/cli/src/index.ts`,
`docs/configuration.md`, the bb-cli skill, `packages/config` tests,
`packages/server-contract/src/public-api.ts`, and two mobile files that
`main` moved or deleted (`SettingsScreen.tsx`, `e2e/flows/phase5-links.yaml`).

Facts on `main` today:

- Drizzle head is `0112_steer_on_enter_default`; the new migration is
  `0113_*`, generated with `pnpm --filter @bb/db db:generate`.
- General settings: `appSettings` singleton table
  (`packages/db/src/schema.ts:162`), zod schema and defaults in
  `packages/domain/src/app-settings.ts`, `PUT /settings/general` and
  `GET /system/config` in `apps/server/src/routes/system.ts`, CLI
  `bb settings general <key> <value>` in `apps/cli/src/commands/settings.ts`.
  A new boolean needs a column, a migration, a schema field, and a row in
  the web Settings → General page. No route change.
- Env var pattern: `packages/config/src/env-vars.ts` `defineEnvVar`, defaults
  in `defaults.ts`, launcher list in `packages/bb-app/src/launcher.ts:105`.
- Mobile settings are per screen under
  `apps/mobile/src/screens/settings/` (`DeviceSettingsScreen.tsx`,
  `AppearanceSettingsScreen.tsx`, `ServersScreen.tsx`). Rows come from
  `SettingsRows.tsx` (`SettingsSection`, `SettingsSwitchRow`, `SettingsHint`).
  Routes live in `apps/mobile/app/settings/` and
  `apps/mobile/src/screens/shell/hrefs.ts` (`SettingsSectionRoute`).
- `expo-notifications ~57.0.12` is installed and in the app.json plugins.
  Only `useShellBridge.ts` uses it, for the badge count.
- Hub: `NotificationHub.onChangedMessage(listener)` at
  `apps/server/src/ws/hub.ts:255`. `getLastThreadOutput` and
  `getLastThreadErrorMessage` exist in `services/threads/thread-data.ts`.
- The old list route returned the full token. The public API has no auth
  beyond the origin check.
- EAS: the Apple push key is uploaded and a physical iPhone is available.

## Decisions

| # | Decision | Answer |
|---|---|---|
| 1 | Revival | Cherry-pick `b0362ef65`, resolve conflicts, regenerate the migration |
| 2 | Push contents | Always title + preview (old behavior), no content setting |
| 3 | Triggers | Pending interaction, turn finished, thread error |
| 4 | Plain HTTP in Direct mode | Refuse registration unless the server is loopback; Settings row explains |
| 5 | List route | Redact: id, platform, label, timestamps, last 6 token characters |
| 6/9 | Server on/off | Boolean general setting `pushNotifications` (default true), read at flush time. Drop `BB_PUSH_NOTIFICATIONS`. Keep `BB_EXPO_PUSH_URL` startup-only for forks |
| 7 | Phone UI | New Notifications screen linked from Device settings, one switch per profile |
| 8 | PR shape | Two stacked PRs: server side, then mobile |
| 10 | EAS | Key uploaded, device available; acceptance runs after PR 2 |
| 11 | Proxy | Honor `HTTPS_PROXY` for the Expo call via undici `EnvHttpProxyAgent` |
| 12 | Android | Keep the `android` platform value, no FCM setup, no acceptance |
| 13 | Tap routing | Add `serverUrl` hint from `BB_APP_URL` when set; probe profiles as fallback |
| 14 | First run | Keep the one-time "Get notified…" sheet after the first connection |
| 15 | Docs | Self-hosting section in `multiple-devices.md`; no connect-relay promise |
| 16 | Execution | Two bb threads on GPT-5.6, coordinated and reviewed from this thread |

## Plan

### PR 1. Server side (db, server, contract, SDK, CLI, config, docs)

1. Cherry-pick `b0362ef65` onto a branch from `main`. Resolve conflicts.
   Delete the mobile files from this PR (they move to PR 2).
2. Drop the cherry-picked migration `0104_push_subscriptions` and its
   snapshot. Keep the schema change, add the `push_notifications` boolean
   column to `app_settings`, and generate `0113_*` with Drizzle.
3. General setting `pushNotifications` (default true): domain schema and
   default, db accessor, web Settings → General row, `bb settings general
   pushNotifications`, SDK types. The sender re-reads it at each flush and
   skips sending when false.
4. Remove `BB_PUSH_NOTIFICATIONS` from config. Keep `BB_EXPO_PUSH_URL`
   (startup-only) in `packages/config`, the launcher list, docs, guide, skill.
5. Sender changes:
   - Add `serverUrl` to `PushNotificationData` when `BB_APP_URL` is set.
   - Use undici `EnvHttpProxyAgent` as the dispatcher for the Expo fetch.
   - Log one warning per hour when `exp.host` is unreachable. Never log
     tokens.
6. Contract: the list response drops `expoPushToken` and adds `tokenSuffix`
   (last 6 characters). Registration keeps the strict full-token body. SDK
   and CLI list output follow.
7. Docs: `docs/configuration.md` (env var and setting),
   `docs/platform-support.md` (replace the "later PR" line, iOS only),
   `docs/multiple-devices.md` (new section: what a self-hosted server must
   reach, no keys needed, what a token can and cannot do, the setting and
   the env var), bb-cli guide and skill per `docs/cli-guide-and-skill.md`.
8. Tests: sender tests with a fake `exp.host` (existing) plus the setting
   gate, the proxy dispatcher, and the `serverUrl` hint; route tests for
   redaction; db tests; config tests; CLI command-output tests.
9. No daemon change, so no `HOST_DAEMON_PROTOCOL_VERSION` bump.

### PR 2. Mobile client (stacked on PR 1)

1. Restore `src/data/notifications/` and `src/notifications/` from the
   cherry-pick. Update the subscriptions API to the redacted list shape.
2. Registration policy: refuse when the profile's server URL is plain
   `http://` and not loopback. `describePushStatus` gains that state.
3. New `apps/mobile/app/settings/notifications.tsx` and
   `NotificationsSettingsScreen.tsx`: one `SettingsSwitchRow` per profile
   with the status hint. Add `"notifications"` to `SettingsSectionRoute` and
   a link row on the Device screen.
4. Keep `PushNotificationsHost` (sync on connect, AppState, token roll,
   toggle; removed-profile cleanup; tap routing with the `serverUrl` hint
   first, probing second; cold-start `getLastNotificationResponse`;
   foreground toast), `AppBadgeSync`, and the first-run sheet.
5. Port the deleted `phase5-links.yaml` steps that still apply to the current
   e2e flows, or drop them with a note in the README.
6. README: update the push section and the Release steps.
7. Tests: registration policy (including the plain-HTTP refusal), store,
   target resolution with the hint, badge.

### Acceptance (after PR 2, physical iPhone, EAS development build)

1. `eas credentials` shows the APNs key on the bb project.
2. Direct mode over Tailscale Serve HTTPS: trigger a pending interaction and
   a finished turn. Expect two pushes. Tap each; the thread opens.
3. Direct mode over plain `http://` LAN: the Notifications row refuses with
   the HTTPS hint.
4. bb connect mode: same two triggers, same result. Two profiles on the
   phone: tap lands on the right server without probing when `BB_APP_URL`
   is set.
5. `bb settings general pushNotifications false`: no push. Back to true: push
   resumes without a restart.
6. Egress test: block `exp.host` on the server host. Expect the warning and
   no crash. Unblock; delivery resumes.
7. Remove a profile on the phone: its row disappears from
   `bb notifications push-subscriptions list`. The list shows only suffixes.
8. Proxy test: run the server with `HTTPS_PROXY` set to a local proxy and
   confirm the Expo call goes through it.

### Execution

- Thread 1 (GPT-5.6): PR 1 from this plan. Deliverable: a stacked-ready
  branch, green `pnpm exec turbo run typecheck test --filter=...` for db,
  domain, server-contract, server, sdk, cli, config, bb-app, plus the guide
  regeneration.
- Thread 2 (GPT-5.6): PR 2 on top of PR 1's branch once PR 1 typechecks.
  Deliverable: green mobile typecheck and tests, a simulator run with
  `xcrun simctl push` for the foreground toast and tap routing.
- This thread: briefs, review of both PRs, the acceptance checklist with the
  owner, and landing.

## Phase 2 (only if needed): connect relay

Not scheduled. See Option B above. Triggers to start: token abuse, demand
for the same-account guarantee, or wanting a dashboard revoke to stop
pushes.

## Plugin conversion (decided 2026-09-02)

The owner asked for the server side to be a built-in plugin, and for web and
desktop notifications to follow. The plugin SDK already offers thread events
(`thread.idle` with the last assistant text, `thread.failed` with the error,
archived, deleted), RPC and HTTP routes, CLI commands, declarative settings,
key-value storage, background services, and the full SDK. One gap: no plugin
event for a new pending interaction. bb connect is precedent for a built-in
plugin that holds credentials and makes outbound calls.

Design:

- New plugin event `interaction.pending` with payload
  `{ thread: ThreadResponse; interaction: PendingInteraction }`, emitted from
  `PendingInteractionLifecycle.registerPendingInteraction` next to the
  `interactions-changed` hub notification. Entry in `docs/api_to_audit.md`,
  bullet on the `thread-events` Guide card, inventory refresh.
- New built-in plugin `plugins/push-notifications` (server only, enabled by
  default). Triggers: `interaction.pending`, `thread.idle` (root threads
  only), `thread.failed`. Same coalescing and cancellation as before, with
  the thread re-read through `bb.sdk.threads.get` and the interaction
  re-checked through `bb.sdk.threads.interactions.list` at flush time.
- Subscriptions in plugin key-value storage. RPC methods
  `pushSubscriptions.list|add|remove` (the phone calls them through
  `sdk.plugins.rpc`; agents through the same SDK call). CLI
  `bb push-notifications list|add|remove|status`.
- Settings: declarative `expoPushUrl` string with the exp.host default. The
  plugin's own enable switch is the on/off control. The core
  `pushNotifications` general setting and `BB_EXPO_PUSH_URL` are removed.
- Core removals: `push_subscriptions` table and migration 0113, the domain
  and server-contract push schemas, the notifications route and services,
  the SDK area, and the CLI command. The Expo transport is the first of
  several; web push (VAPID, per server) and in-app desktop/web OS
  notifications come later inside the same plugin.
- Mobile: registration switches to the plugin RPC. Nothing else changes.

Trade-off accepted: agents use `sdk.plugins.rpc` instead of a typed SDK area.
