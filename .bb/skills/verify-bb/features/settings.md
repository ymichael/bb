# Settings, keyboard, appearance controls, and usage

Status: **2026-09-05: 6 passed, 7 partial/blocked**. See [the audit](../MAINTENANCE.md) and [per-recipe ledger](../validation-2026-09-05.json).

## Setup and entry points

Fresh browser and isolated server. Record original settings and restore every mutation. Use Settings navigation; inspect CLI help for supported values.

Follow the main skill’s isolated launch, doctor, evidence, and cleanup rules.
CLI examples below omit the `node apps/cli/dist/index.js` prefix; use that source CLI
against the same dev instance. Resolve IDs with list/show and inspect the named
command’s `--help` before mutation. Use fresh browser snapshots for controls.

## Source

- `apps/app/src/views/SettingsView.tsx`
- `apps/app/src/components/settings/settings-sections.ts`
- `apps/app/src/components/settings/KeyboardSettingsSection.tsx`
- `packages/domain/src/app-settings.ts`
- `packages/domain/src/experiments.ts`
- `apps/cli/src/commands/settings.ts`
- `apps/cli/src/commands/theme.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| General preferences | Toggle Navigate to threads on creation, Markdown formatting, follow-up Queue/Steer, Rewrite localhost links, and Streamer mode individually; reload and exercise their effect. | Each preference changes the named behavior, persists with its actual owner, and restores. Client-local preferences are not assumed to be in server config. |
| Managed branch prefix | Set a valid prefix and create a disposable managed worktree; try an invalid Git prefix. | New branch uses the configured prefix; invalid input is rejected without saving. |
| Provider order and default | Reorder providers and set a default; open a new composer and inspect provider list/models on the selected host. | Ordering/default affects the correct context and does not advertise unavailable models. |
| Keyboard overrides | Record a shortcut, disable it, restore it, test conflicting bindings and held-modifier hints; compare settings keyboard list/set/reset/hints. | Only the intended action fires; text input remains usable; overrides and reset survive reload. |
| Theme and palette | Run appearance; additionally cycle every built-in palette, install a synthetic custom theme, and use theme list/dir/set/show/reset. | Theme catalog, active palette, and loaded styles agree; invalid theme selection fails cleanly. |
| Favicon and split dimming | Change/reset favicon through UI and theme favicon; toggle Fade inactive splits with two panes. | Favicon updates without changing palette; only inactive splits dim. |
| File openers and local editor | Configure file/directory defaults, extension-specific openers, and local editor integration; open a fixture through each. | Chosen handler and line/path are correct; reset/default fallbacks remain usable. |
| Voice configuration | Load microphones, select one, configure the available AI service, and transcribe a harmless fixture. | Choice is applied to recording/transcription; missing browser permission or service is clearly reported. |
| Usage and AI services | Inspect Usage limits, settings usage, and settings ai-services; compare provider-reported windows and service selections. | Unavailable data remains unavailable rather than zero; configured services are resolved by their owning plugin. |
| Experiments | Exercise changelogPreview, editMessages, mobileApp, sidebarProgressiveDisclosure, and timelineWindowing on/off in isolated data. | Only the named feature gate changes; disabled routes/actions fail or disappear as designed; state restores. |
| Debug events | Toggle Show unhandled provider events and render a trusted unsupported-event fixture. | The diagnostic row visibility follows the toggle without changing persisted event data. |
| Community and update surfaces | Open Community links, version/update view, changelog, and CLI skills status. | Destinations and installed/latest status are correct; viewing does not perform an update. |
| Configuration reload | Change an owned test configuration value and invoke settings reload. | The running app observes supported reloadable values and reports invalid configuration without losing working state. |

## Evidence and cleanup

Record a result for each row separately, including the chosen entry point,
initial state, action, resulting state, and relevant persisted value. Repeat
mutations through the available agent interface to establish parity. Preserve
failed attempts and prerequisites; source documentation is not a passing test.
Restore preferences and remove only the fixtures and sessions created by this
recipe. External writes require a disposable test target and task authorization.
