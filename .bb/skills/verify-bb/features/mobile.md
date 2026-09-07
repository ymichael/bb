# Native mobile shell

Status: **2026-09-05: 12 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Use an iOS Simulator/device and Android emulator/device with a development
build from `apps/mobile/package.json`; consult current Expo configuration for
bundle identifiers and scripts. Point it only at the fresh source server or
local cloud fixture. Record OS/build, profile, server URL and source commit.
Push delivery needs a real registered test device and applicable platform
credentials; Chromium touch emulation is insufficient.

The active native routes are a WebView shell plus device settings and pairing.
Core conversation/project/settings features run in that WebView: repeat their
core recipes there. Older README descriptions of standalone native thread
screens are not evidence that those routes still exist.

## Source

- `apps/mobile/src/screens/shell/RootNavigator.tsx`
- `apps/mobile/src/screens/settings/DeviceSettingsScreen.tsx`
- `apps/mobile/src/screens/settings/ServersScreen.tsx`
- `apps/mobile/app/+native-intent.tsx`
- `apps/mobile/package.json`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| First launch | Launch with an empty test profile store, then add a valid direct server URL and label. | First run opens Add server; a valid profile opens the intended server WebView and persists after relaunch. |
| Saved servers | Add a second fixture profile, switch active server, sign in again where offered, cancel removal and remove the fixture. | Profile selection, labels and authorization stay distinct; removing one does not clear another. |
| Connect QR/code and deep links | Use Connect enrollment and OS app links with a local cloud test machine; try expired/reused codes. | Correct server profile is created or refreshed; invalid links have a recoverable error. |
| WebView lifecycle | Navigate and compose in the WebView, background/foreground, rotate and reload. | Session/route/draft behavior follows the core app contract without duplicate dispatch or broken safe-area layout. |
| Connection state | Stop the test server or network, inspect the banner, then reconnect. | Offline/reconnecting state is truthful and the same profile recovers without switching servers. |
| Device settings | Open This device, inspect version, toggle haptics, reload page, and cancel/confirm Clear website data for the test profile. | Device preferences persist; reload targets its page and clearing has only the documented data scope. |
| Native appearance | Choose System/Light/Dark and change OS mode while native settings and WebView are visible. | Native header/surfaces and supported web bridge appearance stay coherent after relaunch. |
| Push settings and status | Toggle notifications per profile, deny then grant OS permission and inspect registration status. | Each profile’s effective delivery state is accurate and no token appears in evidence. |
| Push tap and badge | Deliver a test background/closed-app notification, tap it, then read the thread. | Correct profile/thread opens and badges reconcile with actual unread state. |
| OS intents and quick actions | Invoke registered app quick actions and supported incoming native intents using synthetic content. | Intent resolves to the expected app/profile route or explicit unsupported fallback; content is not sent unintentionally. |
| Keyboard and compact controls | Open composer, pickers, file attachments and representative drawers with the software keyboard visible. | Safe areas, focus, dismissal and scrolling work on each tested OS; iOS drawer checks use responsive-accessibility.md. |
| Diagnostics and route errors | Open developer WebView spike and E2E reset only in their gated test build; navigate an unknown native route. | Dev-only reset/diagnostics honor their gates; invalid routes render the implemented fallback. |

## Evidence and cleanup

Record each row and platform separately with the actual entry point, observed
state, persisted side effect, and evidence. Missing hardware/service access is
a prerequisite gap, not a pass. Stop only owned sessions/processes, restore
preferences, and remove only synthetic resources after evidence is preserved.
