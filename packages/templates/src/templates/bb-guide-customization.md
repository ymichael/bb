---
kind: instruction
title: bb Guide — Customization
summary: Command reference for customizing the bb app color palette, keyboard shortcuts, and mobile push notifications.
intent: Explain the CLI theme surface, server-backed app customization, and push-notification device registration.
editingNotes: Keep flags accurate against the CLI implementation. Theme details live in the bb-cli skill's references/theming.md.
---
Customization commands

Theming — the app-wide color palette

`bb theme` controls a set of CSS-variable overrides, persisted server-side and
applied live to every open window. This is the palette only; light/dark mode is a
separate per-client setting the palette layers on top of. Custom themes live on
disk, one folder per theme, at <bb-data-dir>/theme/<name>/theme.css (the packaged
app uses ~/.bb/theme/…). The folder name is the theme id.

  bb theme list                  Built-in and custom themes; shows the active one
  bb theme dir                   Print the custom-theme directory (where to author)
  bb theme set <id> [--favicon-color <color>]
                                 Activate a theme, preserving the favicon color
                                 unless the flag supplies the complete selection
  bb theme show [--css]          Print the active palette; --css dumps the CSS
  bb theme reset                 Back to the default theme; preserve favicon color
  bb theme favicon set <color>   Set favicon color; preserve the active theme
  bb theme favicon reset         Reset favicon color; preserve the active theme

To author a custom theme, run `bb theme dir`, write <that-dir>/<name>/theme.css,
then `bb theme set <name>`. Optional `pierre-dark.json` / `pierre-light.json`
(or a `theme.json` `codeTheme` field) ship the matching code colors. Built-in
palettes use the matching Shiki pair. The full design-token reference is in
the bb-cli skill (references/theming.md).

Favicon colors are `default`, `red`, `orange`, `yellow`, `green`, `teal`,
`blue`, `purple`, and `pink`. Theme and favicon-only commands carry the other
appearance value forward explicitly.

Add --json to any theme command for machine-readable output.

Packaged launcher settings

`bb-app config` and `bb-app env` reload runtime settings in a running server,
but the CLI identifies server and launcher settings that are startup-only,
including binding/ports, data and the dev-app port, telemetry, inherited skill
roots, and `BB_FF_*` flags. `BB_LOG_LEVEL` is also startup-only. Use
`bb-app config`, not `bb-app env`, to change `BB_APP_URL`, `BB_INFERENCE`,
`BB_INFERENCE_FALLBACK`, or `BB_TRANSCRIPTION` live. After a startup-only
change, run `bb-app stop && bb-app start` or restart the desktop app. Until
then, changing or unsetting `BB_SERVER_BIND_HOST` does not close a previous
`0.0.0.0` listener.

With `--server-bind-host 0.0.0.0`, the startup listener and `app` rows show
`http://0.0.0.0:<port>`. Health checks and the colocated daemon still connect
through loopback; this does not narrow the IPv4 wildcard listener. Containers
must also publish the port to the host.

Server helper completions use `BB_INFERENCE` first, then
`BB_INFERENCE_FALLBACK` after a transient timeout, rate limit, or
service-unavailable failure. Their defaults are `codex/gpt-5.6-luna` and
`codex/gpt-5.4-mini`, respectively.

  bb-app config set BB_INFERENCE <provider/model>
  bb-app config set BB_INFERENCE_FALLBACK <provider/model>

Server-backed General settings

Settings → General includes app-wide preferences stored server-side so every
window and restart sees the same value. Keep Awake is instead owned by its
builtin plugin: use its autosaving page under Extensions → Plugins or run
`bb keep-awake enable` or `bb keep-awake disable`. Choose every host with `bb
keep-awake hosts all`, or name individual host ids after `bb keep-awake hosts`.
On macOS it prevents system idle sleep while bb is running; closing the lid or
choosing Sleep still sleeps the Mac.

Concurrency limit is also owned by its builtin plugin. Its autosaving page
under Extensions → Plugins leaves the overall limit unlimited by default and
uses an automatic per-host limit of one thread per available processor. Use
`bb concurrency-limit global [unlimited|<limit>]` and `bb
concurrency-limit host <host-id> [auto|<limit>]`; 0 pauses new work.

Settings → Keyboard also includes `showKeyboardHints`, which defaults to true.
Turn it off to hide the delayed shortcut badges shown while holding Command or
Control on macOS, or Control on Windows/Linux. Shortcut commands continue to
work.

Settings → General includes `showUnhandledProviderEvents`, which defaults to
false in packaged builds. Turn it on to show raw provider events bb does not yet
understand; development builds always show these diagnostic rows.

Settings → General also includes `steerActiveThreadOnEnter`, which defaults to
true for a new install. An earlier install with saved settings or work keeps
false. Outside an open typeahead menu, enabling it makes Enter steer a running
thread and Command+Enter queue a follow-up; when disabled, those actions are
reversed. Shift+Enter inserts a newline. On coarse-pointer touch devices, the
software-keyboard Return path inserts a newline. iPadOS WebKit preserves these
Enter shortcuts for a connected Magic Keyboard.

Settings → General also includes `streamerMode`, which defaults to false. Turn
it on to hide every `customModels` entry from `~/.bb/config.json` in all model
lists (pickers, `bb provider models`, and the SDK) during a screen share. The
entries stay in the config file.

Settings → General also includes `managedBranchPrefix`, which defaults to
`bb/`. bb puts it in front of every branch name it creates for a worktree, so
the default gives `bb/fix-login-flow-thr_ab12cd34ef`. Set `sawyer/wt-` to get
`sawyer/wt-fix-login-flow-thr_ab12cd34ef`, or clear it for no prefix. bb rejects
a prefix that cannot start a valid git branch name. The new prefix applies to
branches bb creates after the change.

  bb settings show
  bb settings ai-services
  bb settings general <key> <value>
  bb settings experiment <key> <value>
  bb settings usage [--machine <id-or-name>]
  bb settings version [--force]
  bb settings reload

`bb settings ai-services` shows the helper-inference and voice-transcription
settings (`BB_INFERENCE`, `BB_INFERENCE_FALLBACK`, `BB_TRANSCRIPTION`, set with
`bb-app config`) and the plugin-registered AI services they may name as
`<service>/<model>`.

`bb settings general` accepts any key from `generalSettings` in
`bb settings show`. Boolean preferences take `true`, `false`, `on`, or `off`,
and `null` clears a preference that can be unset.

The default-off `changelogPreview` experiment shows the latest release notes
as a compact, dismissible card on Settings → Updates.
The default-on `editMessages` experiment enables editing eligible, accepted
root user messages in Codex, Claude Code, and Pi threads, including failed or
incomplete turns; turn it off to hide the editor. Opening the editor is
client-local; submitting stops and settles a running thread, then replaces the
selected turn and all later conversation history while retaining workspace side
effects. Grouped multi-message requests are not yet editable.

BB releases restorable provider sessions after 30 idle minutes. The daemon
checks for these sessions every five minutes. Active turns, commands, agents,
workflows, and monitors keep their sessions loaded.

The default-off `sidebarProgressiveDisclosure` experiment shows the first five
groups in the current sort order in **By project** and **By machine**, keeps
attention groups visible, and reveals ten more per **Show more** click. Revealed
groups stay visible through activity and sort-order changes.
**Manually** is unchanged. Enable it with `bb settings experiment
sidebarProgressiveDisclosure true`.

The default-off `timelineWindowing` experiment mounts only nearby rows in long
timelines and large expanded timeline details. Enable it with
`bb settings experiment timelineWindowing true`.

Thread timeline windows are bounded by event count as well as user-message
count (`BB_FF_TIMELINE_WINDOW_EVENT_BUDGET`, default 1500), so a long thread
stops reprojecting its whole history — and blocking the server event loop — on
every update. A turn still running is cut at the budget too, so a very long
turn costs the budget per update instead of growing without limit. Older
activity loads automatically as you scroll toward the top.

Server-backed keyboard shortcuts

Settings → Keyboard records per-command shortcut overrides. They are persisted
server-side, applied live to every connected window, and survive restarts.
Reset removes an override and returns to bb's current default; Clear explicitly
disables a command. `Mod` means Command on macOS and Control on Windows/Linux.
Bindings for non-native actions apply in browser and desktop clients. Command
contexts and native-only availability remain server-owned, and desktop menu
accelerators for New Thread, New Window, New Tab, Close, and Settings use the
same resolved bindings. The complete default table is in docs/configuration.md.

  bb settings keyboard list
  bb settings keyboard hints <true|false>
  bb settings keyboard set <command> <shortcut|disabled>
  bb settings keyboard reset [command]

Push notifications

The built-in Push notifications plugin sends mobile updates through Expo and
system notifications to connected web and desktop clients. Web tabs or desktop
windows must stay open; browser permission is requested in the plugin settings.

  bb push-notifications list
  bb push-notifications add --token <expo-push-token>
      --platform <ios|android> --label <device-name>
  bb push-notifications remove <id>
  bb push-notifications status
  bb push-notifications test <web|desktop>
  bb plugin config push-notifications set <mobileEnabled|webEnabled|desktopEnabled> <true|false>

`add` is an upsert by token: a known token refreshes its label and last-seen
time and keeps its id. Expo tokens that are no longer registered are removed
automatically after a failed delivery. Use `bb plugin disable
push-notifications` to stop delivery. Change the relay URL with `bb plugin
config push-notifications set expoPushUrl <url>`. Add `--json` to `list` or
`status` for machine-readable output. The list returns token suffixes only.
The three channel switches default to true and apply immediately across this
server. `test` broadcasts to all connected clients of the selected type with
permission; OS notification settings still control whether a banner appears.

Host files and voice transcription

  bb file read|write|list|paths|mkdir|move|remove ...
  bb voice transcribe <audio-file> [--prompt <context>]

Voice transcription uses the `BB_TRANSCRIPTION` model, which defaults to
`codex/gpt-transcribe`. Override it with
`bb-app config set BB_TRANSCRIPTION <provider/model>`.

`bb file` supports `--host` for remote machines and `--root` on mutating
commands to confine access beneath an absolute directory. Use `--json` for
metadata and machine-readable results.

Client-local UI preferences

Some Settings values live only in the current browser/client. The Voice Input
microphone picker stores the selected browser MediaDevices device id in
localStorage as `bb.voiceInput.audioInputDeviceId`; it does not have a `bb`
command and does not change the server-side transcription model.
