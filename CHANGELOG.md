# Changelog

## 0.42.0

This release adds Account Pooler for Claude and Codex, push notifications across devices, and a new plugin catalog.

### New features

- Use `/clear` in an idle thread to reset agent context while keeping the workspace and history.
- Show, hide, and reorder sidebar destinations. Reorder new-tab Actions too.
- Browse plugins by category, with screenshots, author pages, and a BB Official collection. The marketplace is also on getbb.app.
- Manage installed plugins in Settings. Plugin settings now autosave with inline validation.
- Read missed notifications in the notification center and expand long messages.
- Expand completed **Thought for** entries to read provider-shared thinking.
- Approvals and plan reviews open as a compact, actionable strip.
- Search the project picker and customize worktree branch prefixes.
- Copy images with message text and see attachment upload progress.

### Built-in plugin updates

- **Account Pooler.** Sign into multiple Claude and Codex accounts in one place. A proxy automatically rotates through your accounts as they hit usage limits. Experimental.
- **Push notifications.** Choose mobile, web, and desktop delivery independently. Web needs permission and an open tab; desktop needs an open app window.
- **Provider Usage.** Enable this new plugin to see limits and reset times across machines in the sidebar footer.
- **Theme Preview.** Install this optional plugin to compare themes across bb screens and components.
- **Side chat.** Fixes for pending questions, queued messages, and compact layouts.

### Agent providers

- Enable **Claude in Chrome** for browser tools.
- Opt into releasing idle Claude queries after 30 seconds. The next turn resumes the conversation; background work stays active.
- Cursor shows the correct reasoning choices. OMP supports manual compaction.
- Fixes for Pi file attachments, Claude usage checks on macOS, and Codex rate-limit reporting.

### CLI

- `bb thread clear` resets context in an idle thread.
- `bb thread fork` now reuses the source environment. Replace `--workspace` with `--environment` or `--new-environment worktree|personal`; forks stay on the same host.
- Manage pooled accounts with `bb pool account`, check `bb pool status`, and control routing with `bb pool routing <claude|codex> [--off]`.
- Test notifications with `bb push-notifications test <web|desktop>`.
- Set branch prefixes with `bb settings general managedBranchPrefix <prefix>`.
- `bb plugin new` scaffolds a store overview.
- Use `bb environment branches`; `bb thread show --merge-base-branches` has been removed.

### Performance

- Enrolled machines download a smaller host-only package and skip identical reinstalls.
- Codex resumes avoid loading full history. Plugin overlays rerender less often.
- The optional `sidebarProgressiveDisclosure` experiment shortens long thread lists while keeping threads that need attention visible.

### Notable fixes

- Stopping a thread pauses its queue. Failed messages wait for an explicit retry.
- Queued follow-ups survive offline hosts and reconnects; grouped messages dispatch together.
- User questions survive daemon reconnects.
- Turns containing steers can be edited, and follow-ups arrive reliably during startup.
- Long conversations retain their leading history.
- Codex archive undo stays in sync with bb.
- Desktop browser OAuth popups work. Escape returns to the app.
- Full browser storage no longer crashes the app.
- Plugin settings preserve newer edits during saves, reloads report the correct version, and tool schemas support newer Zod 4 minors.
- Fixes for intermittent Linux AppImage startup failures and host daemon startup and shutdown.

### Plugin API changes

- `threads.clearContext()` resets context within a thread.
- `threads.fork()` takes `environment` and defaults to reusing the source environment.
- `interaction.pending` reports questions and approvals; `bb.server.experimental_appUrl` exposes the app URL.
- Plugin settings support numeric fields and validation through `experimental_schema`.
- `app.slots.experimental_appOverlay` adds persistent app-wide UI.
- `app.experimental_sidebarFooter.register()` adds footer actions and disclosures.
- `bb.providers.experimental_contributeEnv()` supplies provider environment variables.
- `bb.http.experimental_websocket()` registers plugin WebSocket routes.

### Thanks

Thank you to the fourteen contributors and co-authors outside the core team:

- [@alanagoyal](https://github.com/alanagoyal)
- [@andrewkchan](https://github.com/andrewkchan)
- [@bradhallett](https://github.com/bradhallett)
- [@davidondrej](https://github.com/davidondrej)
- [@dillonzq](https://github.com/dillonzq)
- [@IlyaM](https://github.com/IlyaM)
- [@kravtsovd](https://github.com/kravtsovd)
- [@MateoCerquetella](https://github.com/MateoCerquetella)
- [@MayankBansal12](https://github.com/MayankBansal12)
- [@nlorio-notion](https://github.com/nlorio-notion)
- [@salemsayed](https://github.com/salemsayed)
- [@smsunarto](https://github.com/smsunarto)
- [@swairshah](https://github.com/swairshah)
- [@vburojevic](https://github.com/vburojevic)

Thank you also to everyone who reported an issue addressed in this release: **[@aaronphifer](https://github.com/aaronphifer)**, **[@amirghst](https://github.com/amirghst)**, **[@bradhallett](https://github.com/bradhallett)**, **[@dillonzq](https://github.com/dillonzq)**, **[@Guitaraholic](https://github.com/Guitaraholic)**, **[@GusevV1987](https://github.com/GusevV1987)**, **[@iamhenry](https://github.com/iamhenry)**, **[@IlyaM](https://github.com/IlyaM)**, **[@kravtsovd](https://github.com/kravtsovd)**, **[@lzfxxx](https://github.com/lzfxxx)**, **[@markasoftware-tc](https://github.com/markasoftware-tc)**, **[@MayankBansal12](https://github.com/MayankBansal12)**, **[@technicalpickles](https://github.com/technicalpickles)**, **[@Techno911](https://github.com/Techno911)**, **[@vixalien](https://github.com/vixalien)**, and **[@yusuf8834](https://github.com/yusuf8834)**.

### Mobile app

[Join the iOS TestFlight](https://testflight.apple.com/join/T9MayTMb).

- Receive push notifications while the app is closed. Tap to open the thread on its server.
- Use the new dark iOS app icon.
- Toast swipes and sidebar dismissal are more reliable.
- Panels respect device safe areas, pickers fit short screens, and the keyboard no longer flashes white.

## 0.41.0

This release adds a dispatch queue. You can schedule a send for later and limit how much work runs at the same time. The mobile app is now the bb web app in a native shell, and the new Plugin Guide maps every public plugin API.

### New features

- Send a message later. The bundled **Send later** plugin holds the message and dispatches it when it is due.
- Limit how many threads run at the same time. The bundled **Concurrency limit** plugin defaults to the processor count of your machine.
- Choose Queue or Steer for the Enter key in Settings > General. Each option describes what Enter and Command+Enter do. New installs use Steer.
- Search your threads from the quick palette. The palette also opens Settings pages.
- Reopen a closed tab with a keyboard shortcut.
- Snap split panes to an equal grid.
- Copy a link to a thread.
- Search the parent thread picker. bb ranks parent threads that have children first.
- Sort Browse Plugins by install count. This is the new default order.
- Use a transparent or a frameless window on Linux.
- Add a `.bb-env-teardown.sh` script to your repository. bb runs it before it removes a managed worktree.

### Mobile app

The mobile app is now a WebView shell around the bb web app. One implementation serves the phone and the desktop, so new features arrive on both at the same time.

- Compact layouts use persistent shelves. The page stays visible behind the shelf.
- The compact home page and the recents list are new.
- Tool tabs open as full-page surfaces.
- Navigation responds immediately.
- Swipe to dismiss the sidebar again.

### Built-in plugin updates

- **Plugin Guide.** Enable this new plugin from Extensions > Installed Plugins. It maps every public plugin API surface over the real bb UI. Use **Copy for agent** to paste a surface reference into the composer.
- **File Editor.** The Monaco editor uses your bb code theme. You can resize its file tree.
- **Tasks.** Markdown tables render correctly, and a paste keeps the table content.
- **Automations.** A degraded automation recovers instead of failing to load.
- **Workflows.** The panel surface is cleaner, and worker threads archive when retention deletes their run.

### Agent providers

- Claude Code offers Fable 5.1.
- The model picker shows the models that Pi gives you access to.
- bb releases a restorable provider session after 30 idle minutes. This is no longer an experiment.
- bb retires a provider bridge after its final thread ends.
- bb retries a provider overload failure with the same conversation. It no longer sends a synthetic message.

### CLI

- `bb thread spawn --help` describes `--base-branch` correctly. Every named base is an exact Git ref.
- `bb environment branches` keeps local and remote branch choices discoverable with query and limit controls.
- `bb plugin new` creates a scaffold with a test that runs and a correct SDK example.
- Command help and search results honor each command's help metadata.

### Performance

- Conversation outlines load much faster on large threads.
- A cold load makes fewer duplicate network requests.
- bb caches provider discovery and provider logos.
- Plugin builds skip metafiles that nothing reads.

### Notable fixes

- A group of queued follow-ups stays together.
- A steer queues correctly while a turn starts.
- A thread keeps its execution model through the first dispatch.
- Terminal OSC 8 links work, and a wrapped selection copies correctly.
- macOS terminals no longer leak pty file descriptors.
- Codex subagents relink after a session resume.
- Codex spend controls report the correct rate limits.
- Pi accepts a prompt that contains only an image.
- Cursor plugin skills appear in the composer.
- bb keeps a shared port while its host is offline.
- The sidebar shows Offline when host capacity is unknown.
- A large directory tree lists without a stack overflow.
- Archived thread names resolve in sidebar mentions.
- The Linux AppImage mounts and unmounts its runtime correctly.
- Native module ABI failures no longer recur.

### Plugin API changes

- `bb.experimental_hooks.on("message.dispatch", handler)` gives one checkpoint for every send. Your handler can proceed, wait, or reject.
- `bb.experimental_hooks.recheck(hook)` asks bb to pose the same question again.
- New events report the queue: `message.queued`, `message.dispatched`, and `turn.failed`.
- `sendAt` schedules a send, and `threads.retry()` dispatches a turn again.
- `app.slots.experimental_sidebarNavigation` replaces the sidebar navigation with your own.
- A plugin migration cannot reuse a migration index.

### Thanks

Twelve people outside the core team added code to this release. Thank you:

- [@smsunarto](https://github.com/smsunarto)
- [@wy3z](https://github.com/wy3z)
- [@Danielalnajjar](https://github.com/Danielalnajjar)
- [@fdx-peter](https://github.com/fdx-peter)
- [@fgrehm](https://github.com/fgrehm)
- [@hemaaanth](https://github.com/hemaaanth)
- [@jonolee-kr](https://github.com/jonolee-kr)
- [@peterfotinis](https://github.com/peterfotinis)
- [@salemsayed](https://github.com/salemsayed)
- [@sujeito-operator](https://github.com/sujeito-operator)
- [@t1mdurden](https://github.com/t1mdurden)
- [@yazydzhi](https://github.com/yazydzhi)

Thank you also to everyone who reported an issue that this release fixes: **[@ariofrio](https://github.com/ariofrio)**, **[@bradhallett](https://github.com/bradhallett)**, **[@kongenpei](https://github.com/kongenpei)**, **[@markasoftware-tc](https://github.com/markasoftware-tc)**, **[@MGrin](https://github.com/MGrin)**, **[@MisterMunchkin](https://github.com/MisterMunchkin)**, **[@MPIsaac-Per](https://github.com/MPIsaac-Per)**, **[@nick8cyber](https://github.com/nick8cyber)**, **[@omar-quesada](https://github.com/omar-quesada)**, **[@pixexid](https://github.com/pixexid)**, **[@ryanbbrown](https://github.com/ryanbbrown)**, **[@Techno911](https://github.com/Techno911)**, **[@yurilaguardia](https://github.com/yurilaguardia)**, and **[@yusuf8834](https://github.com/yusuf8834)**.

## 0.40.0

This release adds the File Editor and a quick command palette. It also makes bb faster across all devices.

### New features

- Press Mod+Shift+P to open the quick command palette. Plugins can add commands to it.
- Archive a thread from its sidebar row.
- See plugin problems in the sidebar or with `bb status`.
- Check for plugin updates from the Plugins page. bb also checks every six hours.
- Use `bb plugin new` to create a complete example plugin.
- Use find and copy-link controls in the desktop browser.
- Match thread titles with spaces in the `@` mention menu.
- Split the thread panel into several tabs. bb restores the layout later.
- Use dark mode on the bb website.

### Built-in plugin updates

- **File Editor.** Enable it from Extensions > Installed Plugins. Open, edit, and save text files inside bb.
- **File Viewer.** Preview PDF files. Open an HTML preview as a full page in your browser.
- **Tasks.** Delete folders from Manage > Folders. Presets now support `ultra`, and `bb tasks detach` removes a thread from a task.
- **Docs.** Open thread storage files. Preview and save files on the host that you selected.
- **Plugin API Tester.** Enable this new developer plugin to test panel contributions.

### Agent providers

All built-in agent providers now use the provider API. You can use the same API to build your own provider with a first-class bb timeline.

### CLI

- Use `--plan` with `bb thread tell` or `bb thread spawn` to enter Plan mode.
- Use `bb thread log --all` to read the full thread history.
- Move a local plugin with `bb plugin install path:<new directory>`. bb keeps its data and settings.
- Get a clear error when `bb plugin reload` fails.
- Set every general app setting with `bb settings general`.
- Start common CLI commands much faster. `bb --version` now starts in about 27 milliseconds.
- Write automation prompts of any practical length.

### Performance

- A thread now opens with about half as many requests.
- Smaller bundles reduce the initial load time for the app and plugins.
- Long threads use less server work and load timeline pages faster.
- Large command results load only after you expand them.
- Search uses a faster full-text index and returns shorter results.
- Large files, lists, and diffs render only the visible rows.
- Safari can recalculate plugin styles up to 40 times faster.
- Large prompt drafts respond faster to a paste or a key press.
- The app restores recent panel data after a reload. This change removes several blank states.
- The `timelineWindowing` experiment renders only visible timeline rows.

### Experimental iOS app

[Join our Discord](https://discord.gg/kvBU6tJhcJ) to join the TestFlight.

### Notable fixes

- A thread now holds a new message while it waits for your answer. bb delivers the message after your answer.
- Steer messages no longer create duplicate turns or duplicate detail rows.
- Threads keep their scroll position when older messages load.
- Forks show the conversation that they inherit.
- Side chat keeps the selected message as context for its first turn.
- Hosts reconnect more reliably after sleep or a lost server link.
- bb connect renews active sessions and retries rejected tunnel connections.
- The desktop app installs a downloaded macOS update after a relaunch.
- The desktop app no longer stops after a terminal start failure.
- Plugin service failures restart that service instead of the full server.
- Plugin commands, icons, file views, and update checks work correctly again.
- Split panels keep each tab with its panel.

### Plugin API changes

- Plugins can add commands to the quick palette.
- Shared host libraries reduce the size of built-in plugin bundles by 55%.
- `storage.database()` now returns one shared handle for each plugin load.
- `sdk.threads.storageLocation()` now returns the thread storage root.

This release also adds several experimental APIs for code views, links, and pickers. These APIs can change.

See [the API audit list](https://github.com/get-bb/bb/blob/main/docs/api_to_audit.md) for all new experimental members.

### Thanks

Seventeen people outside the core team added code to this release. Thank you:

- [@jshph](https://github.com/jshph)
- [@ebg1223](https://github.com/ebg1223)
- [@lnittman](https://github.com/lnittman)
- [@kongenpei](https://github.com/kongenpei)
- [@hemaaanth](https://github.com/hemaaanth)
- [@georgecollier-nqu](https://github.com/georgecollier-nqu)
- [@patleeman](https://github.com/patleeman)
- [@Roystbeef](https://github.com/Roystbeef)
- [@bradhallett](https://github.com/bradhallett)
- [@davidondrej](https://github.com/davidondrej)
- [@MateoCerquetella](https://github.com/MateoCerquetella)
- [@Juns-g](https://github.com/Juns-g)
- [@jsilets](https://github.com/jsilets)
- [@sujeito-operator](https://github.com/sujeito-operator)
- [@builtui](https://github.com/builtui)
- [@ryanbbrown](https://github.com/ryanbbrown)
- [@Uttar](https://github.com/Uttar)

Thank you also to everyone who reported an issue that this release fixes: **[@9amhealth-gregschwartz](https://github.com/9amhealth-gregschwartz)**, **[@aemrebarut](https://github.com/aemrebarut)**, **[@aiyi404](https://github.com/aiyi404)**, **[@ariofrio](https://github.com/ariofrio)**, **[@iamhenry](https://github.com/iamhenry)**, **[@jjcm](https://github.com/jjcm)**, **[@Joesirven](https://github.com/Joesirven)**, **[@markasoftware-tc](https://github.com/markasoftware-tc)**, **[@mattwyckhouse](https://github.com/mattwyckhouse)**, **[@MGrin](https://github.com/MGrin)**, **[@PennybagsCX](https://github.com/PennybagsCX)**, **[@pixexid](https://github.com/pixexid)**, **[@ruudk](https://github.com/ruudk)**, **[@Samuka007](https://github.com/Samuka007)**, **[@sholub-dev](https://github.com/sholub-dev)**, **[@smsunarto](https://github.com/smsunarto)**, **[@swairshah](https://github.com/swairshah)**, **[@toasterman234](https://github.com/toasterman234)**, **[@uje-m](https://github.com/uje-m)**, and **[@yurilaguardia](https://github.com/yurilaguardia)**.

## 0.39.0

Faster large threads, child threads across projects, and a long list of fixes.

### New features

- A child thread can now live in a different project from its parent. Run `bb thread spawn --project <other> --parent-self`. The sidebar nests the child under its parent and marks the other project.
- bb connect now allows 20 servers and 20 machines for each account.
- Cursor Grok 4.6 is in the primary model picker.
- An ACP file write now shows as a file-change approval, not as a command approval.
- `bb thread list` shows thread titles and project names.
- The Tasks plugin remembers the List or Board choice for each project.
- `bb automation create --script-file` and `update --script-file` read the file on the thread's host or `--host`, and print the stored copy path.
- Keep Awake has its own plugin page under Extensions → Plugins and a `bb keep-awake` command.

### Performance

- Large streaming threads no longer stall for a second on each update. One CSS pattern made the browser restyle the whole page on every DOM insert.
- Each keystroke in the prompt box no longer re-renders the timeline.
- Side chat opens faster.
- Model and reasoning pickers load faster, and the Codex model list recovers after a child failure.
- Timeline parent lookups, background-task queries, and incremental vacuum are much faster on large databases.
- The prompt banner shows at most 200 changed files, and collapsed sections mount their content on the first expand.
- When bb destroys a managed worktree, it stops every process that still runs inside it, then removes the directory.
- The first tap on Submit works on iPhone.

### Fixes and polish

- Automations: a failed run now settles instead of running again at once. A recurring automation retries after 30 s, then 60 s, and pauses after the third failure in a row. Only one execution runs for each automation at a time. A script timeout stops the whole process group. bb settles orphaned runs at startup.
- A steer no longer disappears from a side chat timeline while a long command streams.
- Grok 4.6 threads no longer fail on the workflow tool schema.
- The plugin composer offers **Don't work in a project**.
- The composer history no longer loops, and the sidebar section drag no longer loops into React.
- Copy works on plain-HTTP origins.
- Pi extension-triggered turns complete, and a Pi compaction refusal shows as skipped, not failed.
- Post-turn compaction stays pending while the thread is idle instead of showing as interrupted.
- The provider tabs stay stable while models load. When a provider fails to load, its tab stays visible, the picker shows the error, and bb blocks a submit to that provider.
- The `github` plugin re-probes `gh auth` and no longer latches needs-configuration. GitHub sync no longer races on abort.
- The Add machine dialog explains an unreachable loopback server.
- Attachment names outside Latin-1 upload correctly, and home-relative chat links open the right file.
- Thread mentions resolve in a reused worktree, and background command activity no longer stays orphaned.
- The diff toolbar fits a narrow panel, duration counters use tabular numerals, and the collapsed activity glyph aligns.
- Mobile fixes: file preview switch overflow, the background agent banner, and the user question form in the footer.
- HTML file previews update live and open at the linked line by default.
- App shortcuts stay alive next to a retained closed drawer, and the background-command banner keeps the command name.
- The new-thread panel matches thread panels, and the project trigger stays stable while a submit runs.
- Voice input shows when the running composer expands.
- The Codex usage snapshot no longer lands in an unknown turn.
- Plugin marketplaces refresh every 2 hours.
- `bb plugin install <path>` no longer fails with HTTP 422, and the **New plugin** example no longer causes a render loop.
- The Docs file opener no longer breaks thread tab sync.
- Native add-on install scripts run under npm 12.
- A stable release now republishes the nightly channel.

### Plugin API changes

- Every plugin page now gets the same right panel as a thread: New tab, Browser, and Terminal. Plugin terminal tabs stay local to the page.
- Every plugin SDK `openPanel` returns a boolean.
- Plugin HTTP routes accept a cross-realm `Response`.
- The plugin SDK declaration bundles are deterministic.
- Rate-limit retries now live in the `provider-retry` plugin. `bb thread retry` is replaced by `bb provider-retry retry`.

**Experimental APIs.** These `experimental_` members are new in this release. Their shape will change. Do not build on them yet.

- `navPanel.experimental_fixedTabs` declares ordered, non-closable tabs for a plugin page. The Tasks and Docs plugins use it.
- `bb.agents.experimental_registerProvider`, `@get-bb/plugin-sdk/provider-bridge`, and `app.slots.experimental_providerIcon` are the infrastructure for agent providers as plugins. Codex, Claude Code, Pi, and ACP now run through this path internally.
- `bb.host` entries, `bb.hosts.experimental_client`, `experimental_defineHostEntry`, `experimental_retainWorker`, and `experimental_createHostEntryHarness` let a plugin run code on an enrolled host. Keep Awake is the first plugin on this path.
- `PluginThreadListProps.experimental_Original` and `PluginFileOpenerProps.experimental_Original` give a replacement component bb's own list or preview.

### Thanks

Nine changes came from outside the core team. Thank you:

- **[@lnittman](https://github.com/lnittman)** made automation runs settle, back off, and recover at startup.
- **[@Roystbeef](https://github.com/Roystbeef)** stopped the timeline from re-rendering on each keystroke.
- **[@jshph](https://github.com/jshph)** fixed the lost first tap on the mobile Submit button.
- **[@builtui](https://github.com/builtui)** made Tasks remember the List or Board choice per project.
- **[@ryanbbrown](https://github.com/ryanbbrown)** fixed Pi extension-triggered turn completion.
- **[@Willhong](https://github.com/Willhong)** made copy work on insecure origins.
- **[@ratulsarna](https://github.com/ratulsarna)** added projectless threads to the plugin composer.
- **[@mattwyckhouse](https://github.com/mattwyckhouse)** fixed the workflow tool schema for Grok 4.6.
- **[@Flame119052](https://github.com/Flame119052)** stopped the composer history update loop.

Thank you also to everyone who reported an issue that this release fixes: **[@arunsathiya](https://github.com/arunsathiya)**, **[@bottlecrow](https://github.com/bottlecrow)**, **[@jeyrb](https://github.com/jeyrb)**, **[@Joesirven](https://github.com/Joesirven)**, **[@jyc](https://github.com/jyc)**, **[@mattwyckhouse](https://github.com/mattwyckhouse)**, **[@MGrin](https://github.com/MGrin)**, **[@ryanbbrown](https://github.com/ryanbbrown)**, **[@wy3z](https://github.com/wy3z)**, and **[@yurilaguardia](https://github.com/yurilaguardia)**.

## 0.38.0

This release adds the Extensions Page, community plugins, shareable plugin marketplaces, and a Linux desktop app.

### Extensions Page

The new Extensions Page gives plugins and skills a home in the bb sidebar.

- Browse and install plugins and skills.
- Use the new plugin creation wizard to choose a starting point and ask an agent to build a plugin.

### Plugin marketplaces

The new marketplace format lets anyone publish a collection of plugins from a Git repository.

- Add a shared marketplace from Settings or with `bb marketplace add`.
- A marketplace can list plugins from Git repositories or npm packages.
- One repository can contain many plugins through `.bb/plugins.json`.
- bb shows the exact source before it installs a marketplace plugin.

### Community plugins

bb now includes the [BB Community marketplace](https://github.com/get-bb/marketplace). Plugins from this reviewed marketplace appear in the Extensions Page for all bb users.

- Ask an agent to submit your plugin. The agent checks it and opens a pull request against the marketplace repository.
- We review each submission before we add it to the default marketplace.

### Plugin development

- The plugin SDK types are now on npm in [`@get-bb/plugin-sdk`](https://www.npmjs.com/package/@get-bb/plugin-sdk).
- A plugin theme can include matching code themes for diffs and file previews.

### Linux desktop app (Alpha)

The Linux desktop app is now available as an Alpha x64 AppImage. Stable and nightly releases include Linux builds and update feeds.

### New features

- Sent-message editing is now on by default.
- Double-click a thread name to edit it in place.
- You can now disable split dimming in Appearance settings.
- New shortcuts cycle models, providers, and reasoning levels in both directions.
- A thread can keep model and reasoning changes with Codex, Claude Code, Pi, and ACP providers.
- Generic ACP agents can fork a provider session when the agent supports it.

### Performance

- Database work is faster and causes fewer app stalls.
- Several iOS improvements make drawers, the right panel, and terminal focus faster and more reliable.
- The installed-plugin page stays responsive with a long list.
- File previews scroll to the requested line, and large untracked files cannot stall status or diff work.

### Fixes and polish

- The new-thread composer and the right panel now use one layout across core and plugin pages.
- A child thread cannot exceed its parent's permission mode. Parent threads also show permission requests from their children.
- The terminal handles Fish shell startup and reconnects more reliably.
- Long streamed messages remain complete when a turn finishes.
- Provider exits no longer leave a turn pending before it starts.
- Claude rate-limit retries and provider exits no longer race with turn completion.
- Machine setup gives clearer results, and a machine keeps its display name after a reconnect.
- The in-panel browser recovers after its renderer exits.
- Plugin content scripts cannot move React-owned elements and blank the app.
- Plugin path installs warn when a managed worktree can disappear.
- `bb connect` no longer causes an unnecessary local-network permission prompt.
- Custom ACP agents can start from the user's shell `PATH`.
- A steer now cancels the live ACP prompt before the next prompt starts.
- Pi can turn reasoning off on models that support it. Lowercase Pi tool calls now render correctly.
- Codex keeps command output during a rename race and respects `CODEX_HOME` for usage data.
- The plugin CLI retries its first connection before it reports that bb is unavailable.
- The Tasks plugin can dispatch work outside a Git repository.

### Thanks

Nineteen changes came from outside the core team. Thank you:

- **[@smsunarto](https://github.com/smsunarto)** added ACP session forks and model controls. They also fixed Fish terminal startup, machine names, and smaller UI problems.
- **[@salemsayed](https://github.com/salemsayed)** added the Linux AppImage target.
- **[@sholub-dev](https://github.com/sholub-dev)** stopped child threads from exceeding a parent's permission mode.
- **[@PennybagsCX](https://github.com/PennybagsCX)** added the managed-worktree warning for local plugin installs.
- **[@AndrewSB](https://github.com/AndrewSB)** fixed watcher pipe failures and Codex usage lookup with a custom `CODEX_HOME`.
- **[@DevVig](https://github.com/DevVig)** and **[@jerrison](https://github.com/jerrison)** fixed prompts that stayed pending after a provider exited.
- **[@fgrehm](https://github.com/fgrehm)** let Pi turn reasoning off when a model supports it.
- **[@MGrin](https://github.com/MGrin)** made the plugin CLI retry its connection probe.
- **[@Willhong](https://github.com/Willhong)** found known ACP agents through the user's shell `PATH`.
- **[@MPIsaac-Per](https://github.com/MPIsaac-Per)** fixed the Pi extension lifecycle in the native bridge.
- **[@galligan](https://github.com/galligan)** made a new plugin scaffold install and build correctly.
- **[@charpeni](https://github.com/charpeni)** pinned GitHub Actions to fixed revisions.

## 0.37.0

A much faster app on your phone, message editing, manual context compaction, shared skills, and a long list of fixes.

### Mobile is much faster

Every tap used to make bb measure the whole page before it could respond. On a phone, that froze the app for seconds at a time. This release removes that work.

- Taps answer at once. The sidebar, the right panel, and the timeline all open without a stall.
- The sidebar keeps its scroll position when you close it and open it again.
- A long thread stays smooth while an agent streams into it.
- A remote session over bb connect no longer lags behind your typing.
- The prompt box no longer collapses while you scroll.

### Edit a message you already sent

Turn on **Edit messages** in Settings → Experiments. You can then edit any message you already sent. Nothing changes until you submit the edit. bb then rewinds the conversation to that point and runs the turn again, and your workspace keeps its changes. Codex, Claude Code, and Pi support it. Agents can do the same with `bb thread edit-message`.

### Compact a long thread

Type `/compact` in the composer to compact a thread that has grown too long. Codex, Claude Code, Pi, and OpenCode support it. Cursor and other custom ACP agents do not. Agents can do the same with `bb thread compact`.

### Skills

- bb now looks for skills in the places each agent already reads, so your existing skills appear without a copy.
- Cursor project skills in `.cursor/skills` are found, including a link to a shared folder such as `.agents/skills`.
- You can point every agent at one shared skill folder instead of a copy for each provider.
- A custom ACP agent can declare its own skill folders.

### An archive you can undo

An accidental archive no longer destroys your worktree. bb waits five minutes before it removes the worktree. The archive toast offers **Undo**, and **Unarchive** on the thread brings back the same environment. A thread you delete still cleans up at once.

### Threads and turns

- Threads no longer freeze at "waiting" until you restart the app.
- Background tasks, workflows, and agents survive a settings change or a memory write. They used to stop.
- A very large finished turn opens instead of restarting the server.
- The first turn of a new thread no longer dies in silence.
- Claude Code asks for your approval before it leaves Plan mode.
- Codex reopens an archived session and tries again instead of failing the turn.
- A thread that moves to another folder keeps its history. Side chats and forks still work.
- A thread title retries instead of staying empty.

### Models and providers

- ACP agents such as OpenCode and Kimi now show context window usage.
- An agent with no reasoning levels no longer offers a false one.
- A custom model entry works for any ACP agent, and one bad entry no longer breaks the rest.
- Cursor starts the right CLI even when another `agent` command comes first on your `PATH`.
- bb finds the Claude CLI where you installed it, and it explains the problem when it cannot.
- A required Codex update is now hard to miss, with an **Update Codex** button.
- A Pi thread no longer sticks on "Working…" because an extension printed a message.
- Provider chatter no longer shows up as unknown events in the timeline.
- Voice transcription retries on the transcription model, so a hiccup no longer loses your words.

### Faster elsewhere

- A desktop sidebar with many threads uses much less memory.
- bb no longer stalls on a cold start with a large history.
- A very large thread list loads instead of failing.
- Plugin pages load faster.
- The Keyboard settings page stays responsive while you record a shortcut.

### Plugins and automations

- A plugin turns on as soon as you install it, including a reinstall.
- You can paste a plain repository URL to install a plugin from Git.
- An automation script can call the `bb` CLI.
- The GitHub plugin loads pull requests for a repository with Issues turned off, finds pull requests on a renamed fork branch, and no longer counts a superseded check as a failure.
- The GitHub plugin fits a phone screen.

### Fixes and polish

- The slash command menu puts an exact match first.
- A stale terminal tab closes instead of coming back.
- A new terminal no longer steals focus from a new thread.
- A long message expands in full when you select **Show more**.
- A split thread view no longer goes blank.
- An agent can call the `bb` CLI from a sandboxed shell.
- Add Project reuses the project you already have for that folder.
- File previews refresh in a large workspace with many changes.
- The sidebar badge no longer offers an update for a CLI you never installed.
- The macOS Dock icon, the iOS home-screen icon, and notification badges follow dark mode.
- Sidebar shortcut hints stay visible, and a child thread name no longer shows through the row above it.
- The iPad landscape sidebar clears the safe area, and Enter on a Magic Keyboard sends the prompt.
- The browser panel lines up with the page when you zoom the window.
- Queued message actions and worktree new-thread buttons have tooltips.
- The New project tooltip no longer appears after you dismiss the picker.
- An error message names the real cause instead of a bare `fetch failed`.
- Log timestamps show the correct local time.

### Thanks

Twenty of the changes in this release came from outside the core team. Thank you:

- **[@tymonTe](https://github.com/tymonTe)** found the bug that froze every thread on a host, traced it to a single event, and shipped the fix.
- **[@sholub-dev](https://github.com/sholub-dev)** shipped four changes. Background tasks now survive a settings change. Agents can reach the `bb` CLI from a sandboxed shell. Errors now name their real cause.
- **[@patleeman](https://github.com/patleeman)** kept a thread's history when it moves to another folder, made Codex reopen an archived session, and stopped the false update badge.
- **[@smsunarto](https://github.com/smsunarto)** fixed the browser panel at window zoom, aligned the built-in plugin icons, and documented scoped plugin package names.
- **[@vburojevic](https://github.com/vburojevic)** fixed the error that broke ACP thread timelines. They also made the app icons and notification badges follow dark mode.
- **[@ratulsarna](https://github.com/ratulsarna)** fixed the crash that blanked a split thread view.
- **[@ryanbbrown](https://github.com/ryanbbrown)** added the rename and archive shortcuts.
- **[@wjin17](https://github.com/wjin17)** removed the hidden refresh that made a remote session lag on a phone.
- **[@DevVig](https://github.com/DevVig)** made Cursor start the right CLI.
- **[@raincodes64](https://github.com/raincodes64)** fixed the Pi thread that stuck on "Working…".
- **[@salemsayed](https://github.com/salemsayed)** made Enter on a Magic Keyboard send the prompt in the iPad app.
- **[@charpeni](https://github.com/charpeni)** added the worktree new-thread tooltips.

Thank you also to everyone who reported an issue that this release fixes: **[@amadad](https://github.com/amadad)**, **[@andreasmcdermott](https://github.com/andreasmcdermott)**, **[@arunsathiya](https://github.com/arunsathiya)**, **[@bighitbiker3](https://github.com/bighitbiker3)**, **[@DarrenTsung](https://github.com/DarrenTsung)**, **[@davekilleen](https://github.com/davekilleen)**, **[@fabianlindfors](https://github.com/fabianlindfors)**, **[@fabricioereche](https://github.com/fabricioereche)**, **[@Joesirven](https://github.com/Joesirven)**, **[@jshph](https://github.com/jshph)**, **[@o98k-ok](https://github.com/o98k-ok)**, **[@rohit-simile](https://github.com/rohit-simile)**, **[@sudoHackIn](https://github.com/sudoHackIn)**, **[@tekumara](https://github.com/tekumara)**, and **[@vaayne](https://github.com/vaayne)**.

## 0.36.0

A faster web app, a more reliable terminal, steadier model catalogs, and a long list of fixes.

### The server now default binds to loopback

The server used to listen on every network interface, which exposed its unauthenticated API to any host that could reach the machine. It now binds `127.0.0.1`. Use `--server-bind-host 0.0.0.0` or `BB_SERVER_BIND_HOST` to opt back in, only behind a trusted network boundary.

- **Action needed before you upgrade** if a browser or an enrolled machine reaches bb at a direct address such as `http://<LAN-IP>:38886` or `http://<machine>.<tailnet>.ts.net:38886`. Move the route first, then upgrade. This release also raises the host daemon protocol, so every enrolled daemon must update itself — and a daemon that lost its route cannot.
- Move to bb connect, or put bb behind Tailscale Serve, then remove and re-add each machine in Settings → Machines so its installer records the new route. Setup steps: https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md
- The desktop app, the `bb` CLI, agents, plugins, and the host daemon on the same machine reach the server over loopback. They need no change.

### Machines and threads

- An enrolled host daemon no longer collides with another daemon over its local API port.
- Background tasks survive a daemon reconnect.
- Provider subscription rate limits now retry instead of failing the turn.
- New threads pick up the connected provider defaults. A thread that names no model now resolves one from the provider catalog on the target host, instead of a hard-coded default. The thread fails to start when that host cannot list models.
- Provider usage limits normalize correctly.

### Pi and ACP

- A broken extension no longer empties the Pi model list.
- A bare Pi model name resolves through the sole authenticated provider.
- An aggregator model ID keeps its provider prefix.
- The bundled runtime loads your own Pi configuration.
- ACP plugin tools work in packaged Electron builds.
- An ACP agent may send a null model or config-option string without breaking the session.

### Models

- Codex re-reads its model list after a CLI update, and it finds project skills again.
- Voice transcription moves to GPT Transcribe. Helper inference moves to GPT-5.6 Luna.

### Performance

- The web app boot payload is 60% smaller.
- The built-in terminal is more reliable, replays faster over a remote connection, and the terminal panel loads faster.

### Plugins and extensions

- Official plugins now live with the rest of the plugins in one place.
- Plugin installs report progress, the build toolchain downloads on demand, and git plugin dependencies install before bundling.
- Plugin SDK type declarations stay current, so agents read the declarations instead of the bundles.
- Browse is the default Extensions tab.
- Interactive plugin tools stay alive past the Connect timeout.
- The GitHub plugin syncs pull requests for repositories with Issues disabled, finds pull requests on fork branches, renders GFM tables in descriptions, and refreshes status when a turn completes.

### Fixes and polish

- New keyboard shortcuts cycle the model and the reasoning level.
- A `.worktreeinclude` file controls what a new worktree copies in.
- Sandbox network permission prompts are grantable.
- App shortcuts and Escape work in the chat input, and sidebar search resets after you open a thread.
- Cmd+W no longer crashes the About window.
- Git status is correct for a newly initialized repository, and a workspace path claim is scoped to its project.
- Long filenames fit in the Add Project dialog, tab overflow controls are back, and right panel resize is less sensitive.
- File links work in side chat timelines.
- The mobile PWA shell tracks the iOS keyboard, and mobile voice recording controls work again.
- bb connect relays DELETE request bodies.
- First-run onboarding is behind an experiment while it settles.
- New `pnpm dev:status` command for source development.

### Thanks

Much of this release came from outside the core team. Thank you:

- **[@ben-vargas](https://github.com/ben-vargas)** reported the wildcard bind and shipped the loopback default, the `BB_SERVER_BIND_HOST` setting, and its migration guide.
- **[@Diffuzmetall](https://github.com/Diffuzmetall)** made the built-in terminal more reliable and much faster to replay over a remote connection.
- **[@kschrader](https://github.com/kschrader)** fixed GitHub pull request sync for a repository with Issues disabled.
- **[@toasterman234](https://github.com/toasterman234)** helped cut the web app boot payload by 60%.

## 0.35.0

Plugins ship in this release, enabled by default. Much of bb is already built with them — and an agent inside bb can now write one for you.

### Plugins

- **Plugins leave experiments and are on by default.** Browse and install them in Settings → Plugins, from the store or from a git URL, an npm package, or a local path.
- **bb can extend itself.** A built-in plugin-authoring skill and the `bb plugin` commands let an agent in a thread scaffold, build, install, and reload a plugin without leaving the conversation. Ask bb for something it does not do, and it can write the plugin that does it.
- A plugin can add agent tools and skills, a `bb` CLI subcommand, sidebar pages and panels, homepage and settings sections, thread header controls, message actions, @-mention providers, background services and scheduled jobs, HTTP and RPC endpoints with realtime push, and its own SQLite storage. New this release: a plugin can render bb's full new-thread composer, and it can **replace the sidebar thread list** outright.
- **Much of bb is already a plugin.** Automations, Side chat, bb connect, Custom instructions, Inline visualizations, and Secrets ship built-in and enabled. Workflows and Ask User Question ship built-in and off by default. GitHub, Docs, Memory, and Tasks install from the store.
- Side chat is now entirely the plugin. Existing side chats migrate over and gain their own permission mode and worktree.
- Plugin pages sit in flat sidebar rows you can reorder or hide, and **Automations** is now separate from **Extensions**, which manages Skills and Plugins.

### A permission limit for every machine

- Each machine now carries a **permission limit** — the highest permission mode any thread on it may run with. A sandbox VM can stay at Full Access while a personal laptop stays lower. Every machine ships at Full Access, so nothing changes until an owner lowers one.
- Only an owner can change a limit, from the new per-machine page. Agents can read the limit but can never raise it. The same page collects that machine's projects, provider versions, update status, rename, and remove.

### Performance

Long thread timelines no longer stall while scrolling, streaming stays stable and unclipped inside a long turn, and threads load faster over bb connect.

### Nightly builds

- New automated nightly channel. Install `bb-app@nightly`, or the separate **bb Nightly** desktop app, which sits beside stable bb and updates from its own feed. A nightly build never moves a stable release pointer.

### Fixes and polish

- The iOS standalone PWA fills the screen again, instead of leaving a dead band at the bottom and pushing content under the status bar.
- Browser tab shortcuts are preserved on web: `Mod+number` stays with the browser, and bb uses `Control+number` on macOS and `Ctrl+Shift+number` on Windows and Linux. Desktop is unchanged.
- A host daemon that fails to shut down now force-exits after 15 seconds so the service manager can restart it. This frees machines that stranded on an old protocol version after a self-update.
- The desktop app asks before it attaches to a bb that is already running, and it can stop that copy for you. `npx bb-app stop` gives agents the same ability.
- Settings → Updates is redesigned around a quieter hierarchy, and updates keep running when you navigate off the page.
- The New thread surface sits flush with the window edges.
- The mobile landing page header no longer overflows.
- Sticky launcher headers, the thread detail header separator, and keyboard shortcut pills line up.

## 0.34.0

This release refreshes the model catalogs behind Pi and Claude, gives every provider a way to ask you a multiple-choice question, and lets workflows run without holding up the composer.

### Models

- The Pi provider moves to Pi 0.82. Model resolution, authentication, and catalog refresh now share one runtime, so the picker reflects each model's real reasoning levels — including `max` — and newly published models appear without waiting for a bb release.
- Opus 5 (1M) is available in the curated Claude Code model list.
- bb's curated Claude models are always offered, and the picker preloads so it opens with the list already populated.
- The Claude Code bridge no longer silently drops requests.
- **Node.js 22.19 is now the minimum.** 22.19, 24, and 26 are the tested lines. Node 20 is no longer supported.

### Asking and answering

- New cross-provider Ask User Question plugin (builtin, off by default): agents on Codex, Pi, and Cursor can now ask you a real multiple-choice question with option previews instead of guessing or asking in prose. Claude threads keep using their native tool.
- Threads show the pending-question glyph while their runtime is active, so it is clearer when an agent is waiting on you.

### Workflows and plugins

- Claude workflows run without blocking the composer, and every concurrently running workflow is shown there.
- Hidden workflow completion notifications can be steered.
- New experiment-gated Tools Hub brings Skills, Plugins, and Automations into one place with consistent layouts, detail provenance, and safe registry installs.
- Plugins gained thread panel navigation, lifecycle-managed content scripts, compact plugin-owned icons, and banners that render above queued messages.

### Fixes and polish

- The split workspace layout is scoped to one tab, and split-view maps moved into sidebar status slots.
- The mobile submit tap now lands ahead of keyboard dismissal.
- The served bb-app artifact refreshes after a restart.
- Sidebar rows no longer stay greyed out after a section drag.
- Ordered lists keep their starting number when rendered.
- Skills show as bolt icons in the composer typeahead, and the automations panel regained its page frame.
- Docs YAML frontmatter is only treated as frontmatter when it parses as YAML, so a document opening with a thematic break keeps its first section.
- The project machine picker gates on connected machines rather than every enrollment, so one long-offline machine no longer replaces the native folder picker.
- Thread title generation prompt refined.

## 0.33.0

This release brings updates into one quiet place, simplifies approval settings, and improves reliability across threads and connected machines.

### Clearer updates and approvals

- Permission modes are now clearer approval presets: Accept Edits, Approve for me, and Full Access. Codex and Claude use their native automatic-review behavior while keeping workspace sandboxing in place.
- A quiet Updates badge replaces stacked notifications. Settings → Updates now brings together bb, desktop, connected-machine, Codex, and Claude Code updates, with clearer progress and retry actions.
- Connected machines recover from failed updates faster and can be retried from Settings or with `bb machine retry-update`.

### Experiments

- Try the new Side Chat experiment, rebuilt on bb's plugin system. Side chats are lightweight hidden forks that inherit the source thread's execution settings, can be opened as full threads, and can send useful results back to the main conversation.
- Quiet Workflows workers no longer fail just because they have not produced output; they wait until the overall run timeout, cancellation, or a real failure.

### Fixes and polish

- `bb thread tell` now steers an active turn by default, while `--mode queue` remains available for non-urgent follow-ups.
- Plan and Goal activity are now tracked independently, so either can be stopped without disturbing the other.
- Threads recover cleanly when a previously selected Claude model is no longer available to the signed-in account.
- Active turns are less likely to be interrupted when a connected machine's daemon encounters a lock or update problem.
- Daemons now shut down cleanly after a startup failure instead of leaving a broken process behind.
- Adding a machine now works correctly when bb Connect is not paired.
- Assistant-authored thread mentions render as navigable thread-title pills.
- The model and reasoning picker stays open so both settings can be changed together.
- Removed misleading Codex timeline errors and polished keyboard hints and queued messages.
- Source installs now repair native modules correctly when running on Node.js 26.

## 0.0.31

This release brings split views to everyone and redesigns queued messages in the composer.

### Features

- Split views are now available: arrange up to eight chats side by side, drag threads in from the sidebar, and move between panes with keyboard shortcuts.
- Queued messages in the composer got a redesign: a compact drawer that scales to long queues, with fullscreen editing.

### Improvements

- New compact composer on mobile.
- Sidebar sections are unified and drag-reorderable, with drag-to-pin; archived threads moved into Settings.
- Usage limits now show which account email each provider is signed in with, and Cursor usage limits are now supported.

### Experiments

- New Tasks plugin: Linear-style task tracking with agent dispatch — assign agents to tasks, follow their progress in comments, and attach files and GitHub PRs.
- Official plugins are now bundled with the app and update alongside it.
- New Workflows plugin renders live multi-agent workflow runs in chat, across providers.
- Docs gained table editing, easier file management, and a pull/push-based CLI.

### Fixes and polish

- Fixed Claude model fallbacks not being surfaced immediately.
- Fixed `bb secret request` destinations in multi-machine setups.
- Fixed desktop light/dark switching when following the system theme.
- Fixed scrolling of long agent questions and sidebar safe-area coverage on mobile.
- Fixed a performance issue with animations.
- Improved bb Connect reliability.
- Worktree setup now runs with your resolved shell PATH.

## 0.0.30

This release introduces multi-machine workflows and bb Connect, adds more ways to customize how bb works, and gives you clearer visibility into what agents are doing.

### Work across threads and machines

- Multi-machine support lets you add computers to bb and choose which machine runs each task.
- bb Connect lets you securely access bb from other devices and share previews or local servers from any enrolled machine.

### New features

- Custom instructions now have a dedicated Settings editor and are automatically included in future agent turns.
- Agents can securely request API keys and other credentials without exposing their values in the conversation or transcript.

### Faster navigation and more control

- Customize, disable, or reset keyboard shortcuts from Settings → Keyboard.
- Shortcut hints appear contextually and can be delayed or hidden entirely.
- Sidebar organization and sorting now live in one streamlined display menu, including a new By machine view when multi-machine mode is enabled.
- Thread groups are now called Sections consistently across the app, CLI, and SDK; existing group assignments and sidebar preferences migrate automatically.
- Provider settings can disable native Codex or Claude Code subagents, along with Claude Code's Workflow tool.

### Clearer agent activity

- Codex subagents now appear as nested delegations, and Claude Code child threads remain visibly active while their subagents run.
- Background command activity is shown directly in the sidebar.
- Skills and slash-command autocomplete are more consistent across local and remote sessions.

### Experiments

- Split views let you arrange up to four chats in one workspace. Drag threads from the sidebar, resize and rearrange panes, or use keyboard shortcuts to move between them.
- The new plugin ecosystem includes the BB Official catalog, compatibility-aware updates, richer chat and panel experiences, plugin themes, and consistent icons throughout bb.
- Install Docs for filesystem-backed documents with folders, images, Markdown editing, and HTML previews in an editable side panel.
- Install Memory to carry durable global or project-specific context across Codex and Claude Code.

### Fixes and polish

- Fixed microphone input in signed macOS desktop builds.
- Fixed app and Settings navigation resetting as you move between pages and threads.
- Fixed subagent token usage inflating the parent thread's context report.
- Local images now render in assistant Markdown, queued prompts preserve formatting, and file previews refresh reliably.
- Improved narrow and short thread layouts, including the composer, Docs sidebar, split indicators, and inactive-pane contrast.
- Sped up production startup when running bb from source.
- Refined plugin icons, theme behavior, menu alignment, and sidebar drag interactions throughout the app.

## 0.0.29

This release expands agent and model support, introduces a redesigned Settings experience, and includes workflow improvements and reliability fixes across bb.

### More agents, models, and skills

- Added support for Grok Build and Hermes Agent.
- Codex now supports 5.6-Sol, Terra, and Luna.
- Skills and `/` autocomplete now work across Pi and ACP providers, including OpenCode, omp, Grok, Hermes, Cursor, and custom ACP agents.
- Side chats can now use a different model, reasoning level, or service tier while remaining safely read-only.

### Redesigned Settings

- Settings now uses dedicated pages with sidebar navigation.
- Choose which microphone bb uses for voice input.
- Manually check for updates from Settings → Updates.
- On macOS, enable Caffeinate to keep the machine awake while bb is running.
- Discord and GitHub links now live under Settings → Community.

### Workflow improvements

- Right-click local file links to open them in a specific editor, choose a preview, or copy the file name or path.
- Queued messages now render mention pills correctly.
- `bb thread archive` now also archives child threads and side chats.
- `bb thread wait` now waits up to 20 minutes by default, better matching real agent workloads.
- Agent shells more reliably use the correct workspace-managed `bb` CLI.

### Fixes and polish

- Fixed the app becoming unresponsive after creating, renaming, or removing a section from a sidebar menu.
- Fixed manually marked unread threads remaining unread after reopening.
- Fixed sidebar alignment in macOS fullscreen mode.
- Fixed clipped focus rings in the composer toolbar.
- Simplified thread-row cursors and removed the terminal-count badge from the right-panel toggle.
- Renamed the sidebar feedback action to “Report a bug.”

### Experiments

New experiment to let you connect to bb from other computers.
