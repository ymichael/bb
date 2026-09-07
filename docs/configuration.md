# Configuration

The packaged `npx bb-app` flow stores persistent package settings under
`~/.bb/config.json`, provider environment values under `~/.bb/env.json`, and
client SSH target mappings under `~/.bb/client.json`.

Use `bb-app config` for non-secret bb settings:

```bash
npx bb-app config set BB_APP_URL https://<machine>.<tailnet>.ts.net
npx bb-app config set BB_INFERENCE codex/gpt-5.6-luna
npx bb-app config set BB_INFERENCE_FALLBACK codex/gpt-5.4-mini
npx bb-app config set BB_TRANSCRIPTION codex/gpt-transcribe
npx bb-app config list
npx bb-app config unset BB_APP_URL
npx bb-app config refresh
```

Use `bb-app env` for provider credentials and provider-specific environment:

```bash
npx bb-app env set OPENAI_API_KEY <key>
npx bb-app env list
npx bb-app env unset OPENAI_API_KEY
```

## Repository worktree hooks

Commit `.bb-env-setup.sh` when a managed worktree needs repository setup.
Commit `.bb-env-teardown.sh` when bb must release external resources before it
removes that worktree. See [Worktrees, setup scripts, and teardown
scripts](worktrees.md) for the lifecycle, environment, timeout, and failure
contracts.

`bb-app config list` shows non-secret values. `bb-app env list` redacts every
value and only shows whether a key is set.

The Add machine installer may also store a `machineCredential` and its
`connectMachineId` beside `serverUrl` in `config.json`. The credential is a
secret managed by bb connect: do not copy, edit, or commit it. Both fields are
intentionally omitted from `bb-app config list`. At runtime they are passed to
the standalone host daemon and its bundled `bb` CLI as
`BB_CONNECT_MACHINE_CREDENTIAL` and `BB_CONNECT_MACHINE_ID`. These are
installer-managed transport details, not user configuration knobs; re-add the
machine instead of setting them by hand.

Use `bb-app client ssh-target` to let a local helper open files from a remote
bb server in local editors. The SSH target is the value that works after
`ssh`, such as `devbox`, `user@devbox`, or a `Host` entry from `~/.ssh/config`:

```bash
npx bb-app client ssh-target set https://bb.example.test devbox --host-id host_abc
npx bb-app client ssh-target list
npx bb-app client ssh-target remove https://bb.example.test --host-id host_abc
```

Use `--host-id` when the server has more than one machine; copy the ID from
`bb machine list`. Omit it to preserve the single-machine auto-selection for
`set`, or to remove every mapping for that server with `remove`.

## Precedence

Configuration is resolved in this order:

1. Explicit launcher flags, such as `--data-dir`, `--server-port`, or
   `--server-bind-host`.
2. Persistent `bb-app config`, `bb-app env`, and client values.
3. Ambient shell environment.
4. Built-in defaults.

For the packaged app, prefer `bb-app config`, `bb-app env`, and launcher flags
over shell variables. The environment remains the internal and deployment
substrate, and source-development commands still load `.env` files.

For source development, `pnpm dev` automatically injects
`BB_DEV_CONNECT_BASE_URL=http://bb.localhost:<worktree-cloud-port>`. The
Connect plugin accepts this loopback origin only when `NODE_ENV=development`
and uses it only as the unpaired default. Explicit `bb connect --server ...`
or `--base-url ...` targets take precedence, and packaged/production bb keeps
the `https://getbb.app` default. This value is launcher-managed, not a
`bb-app config` setting.

After `bb-app config` writes `~/.bb/config.json` or `bb-app env` writes
`~/.bb/env.json`, it asks the running local server to reload. If bb is not
running, the new values apply on the next start. If you edit either file by
hand, run `npx bb-app config refresh` to apply the files to a running server.

The live reload applies config keys such as `BB_APP_URL`, `BB_INFERENCE`,
`BB_INFERENCE_FALLBACK`, and `BB_TRANSCRIPTION`, plus env values explicitly
consumed at runtime such as `OPENAI_API_KEY`. If one of those config keys is
stored with `bb-app env` instead, it is startup-only; use `bb-app config` when
you need a live change.

`BB_LOG_LEVEL` is the startup-only `bb-app config` key. The complete current
set of startup-only server or launcher env entries is:

- `BB_APP_SURFACE`, `BB_APP_URL`, `BB_DATA_DIR`, `BB_DEV_APP_PORT`, and
  `BB_EXTERNAL_URL`
- `BB_HOST_DAEMON_PORT`, `BB_INFERENCE`,
  `BB_INFERENCE_FALLBACK`, and `BB_INHERITED_SKILLS_ROOTS`
- `BB_LOG_LEVEL`, `BB_MANAGED_DEV_BUILTIN_PLUGIN_HOT_RELOAD`,
  `BB_MARKETPLACE_URL`, `BB_POSTHOG_API_KEY`, and `BB_TELEMETRY`
- `BB_SERVER_BIND_HOST`, `BB_SERVER_PORT`, `BB_TRANSCRIPTION`, and all
  `BB_FF_*` feature flags

Setting or unsetting one still runs the reload for any other pending changes,
but the running processes keep their current values. Apply it with a full
launcher restart (`bb-app stop && bb-app start`) or by restarting the desktop
app. In particular, changing or unsetting `BB_SERVER_BIND_HOST` does not close
an existing `0.0.0.0` listener until that restart.

`bb-app config refresh` also notes any startup-only keys currently present in
`config.json` or `env.json`; those values apply on the next full restart.

When targeting a non-default running instance, pass the same `--data-dir` and
`--server-port` to `bb-app config` or `bb-app env` commands so they write the
right file and refresh the right server.

## Stopping A Running bb

A running `bb-app start` writes `<dataDir>/bb-app-runtime.json` and removes the
file when it exits. The file records the launcher process id, the server URL,
the version, the start time, and how bb was started. Do not edit it.

Two things read that file:

- `npx bb-app stop` stops the bb that owns the data directory. Pass the same
  `--data-dir` you started with when it is not the default `~/.bb/`.
- The macOS desktop app asks before it uses a bb it did not start, and offers to
  stop that copy for you.

Both confirm that the recorded process really is a bb launcher before they
signal it, so a stale file left by a crash cannot stop an unrelated process.

## Common Keys

| Key                     | Command                                            | When to set             | Used for                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BB_APP_URL`            | `bb-app config`                                    | Optional for remote use | Human-facing app URL used for generated links and allowed browser origins. Leave empty for local-only use.                                                                                                                                                                                                                                                                                                     |
| `BB_INFERENCE`          | `bb-app config`                                    | Optional                | Primary server-side helper model in `<service>/<model>` format, where `<service>` is an AI service a loaded plugin registers (`bb settings ai-services` lists them; `codex` comes with the codex plugin and uses the codex CLI's credentials with no reasoning) or a pi-ai provider the server calls directly with its API key. Defaults to `codex/gpt-5.6-luna`.                                              |
| `BB_INFERENCE_FALLBACK` | `bb-app config`                                    | Optional                | Helper model used after a transient primary timeout, rate limit, or service-unavailable failure. Defaults to `codex/gpt-5.4-mini`.                                                                                                                                                                                                                                                                             |
| `BB_TRANSCRIPTION`      | `bb-app config`                                    | Optional                | Voice transcription model in `<service>/<model>` format: a plugin-registered AI service (`codex` with the codex plugin; audio up to 5MB) or `openai/<model>` with `OPENAI_API_KEY`. Defaults to `codex/gpt-transcribe`.                                                                                                                                                                                        |
| `BB_MARKETPLACE_URL`    | `bb-app env`, or environment                       | Startup-only testing    | Manifest URL of the reserved `bb-community` plugin marketplace. It defaults to `https://getbb.app/marketplace/v2/marketplace.json`. If the default v2 request returns 404, the server requests v1. Set another URL to test catalog refreshes. The server requests that URL without fallback. It changes only `bb-community`. Add other marketplaces with `bb marketplace add`. Restart the app after a change. |
| `BB_SERVER_URL`         | `bb-app config`                                    | Remote CLI/host use     | Server URL for standalone `bb` CLI and `host-daemon` commands on the current machine. The CLI defaults to `http://127.0.0.1:38886` when unset.                                                                                                                                                                                                                                                                 |
| `BB_SERVER_BIND_HOST`   | `bb-app env`, environment, or `--server-bind-host` | Startup-only            | Server listener host. Defaults to `127.0.0.1`; accepts only `127.0.0.1` or `0.0.0.0`. A full launcher or desktop app restart is required; until then, a previous `0.0.0.0` listener remains exposed. This is not a `bb-app config` key.                                                                                                                                                                        |
| `BB_SERVER_PORT`        | `bb-app env`, environment, or `--server-port`      | Startup-only            | HTTP listener port. Defaults to `38886`. A full launcher or desktop app restart is required after a persistent set or unset.                                                                                                                                                                                                                                                                                   |
| `BB_HOST_DAEMON_PORT`   | `bb-app env`, environment, or `--host-daemon-port` | Startup-only            | Local host-daemon API port. Defaults to `38887`. A full launcher or desktop app restart is required after a persistent set or unset.                                                                                                                                                                                                                                                                           |
| `BB_LOG_LEVEL`          | `bb-app config`                                    | Startup-only debugging  | Log level: `trace`, `debug`, `info`, `warn`, `error`, or `fatal`. A full launcher or desktop app restart is required.                                                                                                                                                                                                                                                                                          |
| `OPENAI_API_KEY`        | `bb-app env`                                       | OpenAI opt-in routes    | Required only when selecting explicit OpenAI provider routes such as `openai/gpt-4o-mini` or `openai/gpt-transcribe`.                                                                                                                                                                                                                                                                                          |

By default, helper inference and voice transcription use Codex credentials from
the host daemon. Run `codex login` on the host for the default path. Set
provider env keys only when opting into a non-Codex provider route.

With a ChatGPT subscription login, `codex/` voice transcription posts to a
`chatgpt.com` endpoint that sits behind Cloudflare bot protection. On some
networks Cloudflare challenges that request; bb retries, then reports
"Voice transcription is temporarily unavailable" and logs the Cloudflare
challenge on the server. If that happens often, route transcription through an
API key instead: `codex login --with-api-key`, or set `BB_TRANSCRIPTION` to
`openai/gpt-transcribe` with `OPENAI_API_KEY`.

The microphone picker in Settings → Voice Input is client-local. It stores the
selected browser `MediaDevices` device id in localStorage as
`bb.voiceInput.audioInputDeviceId`; it does not change `bb-app config` or the
server-side transcription model.

The built-in Push notifications plugin uses `expoPushUrl` for its relay URL.
The default is `https://exp.host/--/api/v2/push/send`. Change it with
`bb plugin config push-notifications set expoPushUrl <url>`. The plugin reads
the value when it sends a message. Independent `mobileEnabled`, `webEnabled`,
and `desktopEnabled` booleans default to true. Change each with
`bb plugin config push-notifications set webEnabled false` (or the other
channel key). Web and desktop clients receive system notifications while a bb
tab or window remains open; browsers require HTTPS or localhost and per-device
notification permission. Settings → Push notifications offers permission and
test controls. `bb push-notifications test <web|desktop>` broadcasts a test to
connected, permitted clients; it does not confirm OS display.

The builtin Keep Awake plugin has one autosaving configuration page with an
enable switch and an all-or-selected host picker. On selected macOS hosts it
runs `/usr/bin/caffeinate -i -w <worker-pid>` while enabled, preventing system
idle sleep while bb is running. It only blocks idle sleep: closing a laptop lid
or choosing Sleep manually still sleeps the Mac. Configure it from an agent or
terminal with:

```sh
bb keep-awake status [--json]
bb keep-awake enable [--json]
bb keep-awake disable [--json]
bb keep-awake hosts all
bb keep-awake hosts <host-id>...
```

The builtin Concurrency limit plugin has an autosaving page under Extensions
→ Plugins. Its overall limit is unlimited by default. Each host defaults to
Auto: one thread per available processor. A blank host field restores
Auto, and 0 pauses new work for that scope. Configure it from an agent or
terminal with:

```sh
bb concurrency-limit status [--json]
bb concurrency-limit global [unlimited|<limit>] [--json]
bb concurrency-limit host <host-id> [auto|<limit>] [--json]
```

The "Show unhandled provider events" toggle in Settings → General exposes raw
provider events that bb does not yet understand. It defaults to off in packaged
builds because these diagnostic payloads are noisy. Development builds continue
to show them regardless of the toggle. Set the persisted preference from an
agent or terminal with
`bb settings general showUnhandledProviderEvents <true|false>`.

The "Default thread followup behavior" picker in Settings → General changes the
active-thread composer shortcuts when no typeahead suggestion is active. A
queued message waits and then runs when the agent stops. A steer message goes
to the agent during the current run. The picker defaults to "Steer" for a new
install: Enter steers and Command+Enter queues. "Queue" swaps them: Enter
queues and Command+Enter steers. An earlier install with saved settings or work
keeps "Queue" because a one-time migration stamps the old default onto it. Set
it with
`bb settings general steerActiveThreadOnEnter <true|false>`, where `true` is
"Steer".

The "Streamer mode" toggle in Settings → General hides every `customModels`
entry from `~/.bb/config.json` in all model lists: the web and mobile pickers,
`bb provider models`, and `sdk.providers.models`. Turn it on before a screen
share so a private or early-access model id does not appear. It defaults to
off. The entries stay in `config.json`, and a thread that names a hidden model
explicitly still runs with it. Default model resolution for a new thread also
keeps the full list, so a provider whose only models are custom still starts.
A composer whose stored selection is a hidden model treats it as unavailable
and falls back to the provider default; the next send records that default, so
select the custom model again after you turn streamer mode off. Set it with
`bb settings general streamerMode <true|false>`.

The "Worktree branch prefix" field in Settings → General sets the text bb puts
in front of every branch name it creates for a managed worktree or a new
checkout branch. It defaults to `bb/`, which produces
`bb/fix-login-flow-thr_ab12cd34ef`. Change it to `sawyer/` to group your branches
under your own namespace, or clear the field to create
`fix-login-flow-thr_ab12cd34ef` with no prefix. bb rejects a prefix that cannot
start a valid git branch name, such as one with a space or a leading `-`, and
the prefix is at most 64 characters. The prefix applies to branches bb creates
after you change it; it does not rename an existing branch or worktree. Set it
with `bb settings general managedBranchPrefix <prefix>`.

Settings → Providers lists every registered agent provider in picker order.
Move a provider up or down to change the order and choose the default for new
threads. Both are persisted preferences: `providerOrder` is the list of ids
that lead the picker (ids not listed follow in plugin install order, and an id
that names no registered provider is ignored) and `defaultProviderId` is the
provider new threads use when neither the caller nor the project chose one
(`null` means the first available provider in picker order). Set them with
`bb settings general providerOrder '["claude-code","codex"]'` and
`bb settings general defaultProviderId claude-code` (or `null`).

Each provider's own options live on its plugin: Codex memory and native
subagents under the Codex provider plugin, Claude Code memory, native
subagents, the Workflow tool, and opt-in idle process release under the Claude
Code provider plugin. Idle process release closes a quiescent Claude process
after 30 seconds while keeping its bb thread resumable; it defaults off during
its bake period and applies on the next start, resume, or turn command. Read and
set provider options like any plugin setting, for example
`bb plugin config provider-claude-code set idleQueryReleaseEnabled true`.

Claude Code starts without its Claude in Chrome browser tools when bb runs it,
even when the interactive `claude` CLI has Chrome enabled by default. Turn the
tools on for bb threads with
`bb plugin config provider-claude-code set chromeEnabled true`. bb then starts
Claude Code with `--chrome`. The host needs the Claude in Chrome extension and a
claude.ai login; API-key sessions keep Chrome off. A change restarts the thread's
Claude process before its next turn and keeps the conversation.

Outside an open typeahead menu, Shift+Enter inserts a newline. On
coarse-pointer touch devices, the software-keyboard Return path inserts a
newline and the submit button sends.
iPadOS WebKit additionally preserves the Enter and Command+Enter shortcuts
above for a connected Magic Keyboard.

## Keyboard Shortcuts

`Mod+Shift+P` opens the quick palette: type to filter, then run a command with
Enter. It lists only commands that apply on the current surface, shows each
one's shortcut, and offers recently run commands first. The numbered
accelerator families and the relative cycle commands stay rebindable but
unlisted. Plugins can add their own rows, listed under "Plugins".

Settings → Keyboard edits app command shortcuts. Overrides are stored in the
server database, applied live to every connected window, and kept across
restarts. Resetting a shortcut removes its override so future bb releases can
continue to update the default. Clearing a shortcut explicitly disables that
command. Command context and native-only availability remain server-owned and
are not editable. Actions supported by both clients use the same resolved
bindings in the browser and desktop app; browsers may still reserve some chords
before bb receives them.

`Mod` means Command on macOS and Control on Windows/Linux. Numbered thread and
pane shortcuts follow Slack's browser-safe convention: web uses
`Control+1…9` on macOS and `Ctrl+Shift+1…9` on Windows/Linux, while desktop
uses `Mod+1…9`. The web aliases leave native browser `Mod+1…9` tab switching
untouched. Previous and next thread use `Mod+Shift+[/]` on desktop and
`Control+Shift+[/]` on the web.

The "Show keyboard hints when holding CMD / Control" preference defaults
to on. Set it with
`bb settings keyboard hints <true|false>`. Turning it off hides the
delayed shortcut badges without disabling any shortcuts.

| Area      | Command                                   | Default                           | Availability             |
| --------- | ----------------------------------------- | --------------------------------- | ------------------------ |
| Palette   | Quick palette                             | `Mod+Shift+P`                     | All clients              |
| Threads   | New thread                                | `Mod+N` / `Mod+Shift+O`           | Desktop / web            |
| Threads   | Search threads                            | `Mod+K`                           | All clients              |
| Threads   | Rename focused thread                     | Unassigned                        | Thread view              |
| Threads   | Archive focused thread                    | Unassigned                        | Thread view              |
| Threads   | Previous / next thread                    | Surface defaults above            | Desktop / web            |
| Threads   | Open visible thread 1–9                   | Platform defaults above           | Web / desktop            |
| Layout    | Previous / next chat pane                 | Unassigned                        | While split              |
| Layout    | Focus chat pane 1–8                       | Platform defaults above           | Split (web / desktop)    |
| Layout    | Maximize / restore chat pane              | `Mod+Shift+E`                     | While split              |
| Layout    | Close focused chat pane                   | `Mod+Shift+X`                     | While split              |
| Window    | New window                                | `Mod+Shift+N`                     | Desktop                  |
| Window    | Settings                                  | `Mod+,`                           | All clients              |
| Layout    | Toggle sidebar                            | `Mod+\`                           | All clients              |
| Panel     | New tab / close tab / toggle              | `Mod+T` / `Mod+W` / `Mod+J`       | All clients              |
| Workspace | Quick open file / toggle diff             | `Mod+P` / `Mod+D`                 | All clients              |
| Workspace | Open terminal                             | `Mod+Shift+Enter` / `Mod+Shift+T` | Web / desktop            |
| Workspace | Open in preferred app                     | `Mod+O`                           | All clients              |
| Composer  | Focus composer                            | `Mod+Shift+C`                     | All clients              |
| Composer  | Toggle model picker                       | `Mod+Shift+M`                     | All clients              |
| Composer  | Cycle model forward / backward            | `Alt+M` / `Alt+Shift+M`           | All clients              |
| Composer  | Cycle provider forward / backward         | `Alt+P` / `Alt+Shift+P`           | All clients              |
| Composer  | Cycle reasoning effort forward / backward | `Alt+T` / `Alt+Shift+T`           | All clients              |
| Browser   | Focus location / reload / find in page    | `Mod+L` / `Mod+R` / `Mod+F`       | Desktop embedded browser |
| Questions | Choose visible answer 1–9                 | `1` … `9`                         | While a question is open |

Cycle commands wrap in both directions. Reasoning cycles only through the
current model's supported efforts in canonical low-to-high rank order, not the
provider response order. The cycle shortcuts act only from the active composer
or an open picker; unrelated editable controls retain their Option-composed
character input. A configured app shortcut takes precedence in editable
controls; when no matching command handles a chord, the control retains its
native behavior.

The desktop application menu uses the same resolved bindings for New Thread,
New Window, New Tab, Close, and Settings. There is no separate menu shortcut
configuration.

`BB_SERVER_URL` does not change where full `npx bb-app` startup binds locally.
It is for commands that need to target an already-running server, such as the
bundled `bb` CLI or a standalone host daemon. The CLI can omit it when targeting
the default local packaged server at `http://127.0.0.1:38886`; set it for remote
or non-default servers.

## Client SSH Targets

`~/.bb/client.json` is local to the machine showing the UI. The CLI resolves the
remote server's host ID and stores a mapping from that server/work-host to an SSH
target known to the local machine. The remote server does not read this file.

Example:

```json
{
  "servers": {
    "https://bb.example.test": {
      "hosts": {
        "host_abc": {
          "sshAuthority": "devbox"
        }
      }
    }
  }
}
```

When a remote bb page asks the local helper to open a work-host path, the helper
uses this mapping to launch remote-capable editors and terminals over SSH.
Browsers or devices without a helper can still use bb; local editor actions are
simply unavailable.

## Custom ACP Agents

Known ACP agents appear when their CLI is installed on the host. bb exposes
`acp-opencode` when `opencode` is on PATH and can be launched as `opencode acp`,
`acp-omp` when `omp` (oh-my-pi) is on PATH, `acp-grok` when Grok Build's `grok`
CLI is on PATH and can be launched as `grok agent stdio`, and
`acp-hermes-agent` when Hermes' `hermes` CLI is on PATH. `acp-cursor` is always
listed.

Add your own agent through the ACP providers plugin's `customAgents` setting,
which holds a JSON array. In the app it is the multi-line editor on the
plugin's settings page (Settings → Plugins → ACP providers); from the CLI:

```bash
bb plugin config provider-acp set customAgents '[
  {"id": "amp", "displayName": "Amp", "command": "amp", "args": ["acp"]}
]'
```

Each entry needs `id` (lowercase letters, digits and dashes), `displayName`,
and `command`. bb derives the provider id `acp-<id>`; it never changes once a
thread has used it. An id bb always lists (`cursor`) is reserved; an id bb
lists only where the agent is installed (`opencode`, `omp`, `grok`,
`hermes-agent`) is not, so an entry with that id REPLACES the shipped agent.
A replacing entry keeps the shipped agent's `nativeSkillRoots` unless it sets
its own, and bb still lists the roots that agent's host config names (its
config directory, compat trees, configured paths, plugins) either way.
Optional fields: `args`, `env`, `cwd`, `modelCli` (CLI model listing and
selection), `reasoningCli` (launch-time reasoning flags), `nativeReasoning`
(ACP `session/set_config_option` reasoning), `nativeSkillRoots` (native skills
in the composer, as `{"user": [...], "project": [...]}` relative paths; an
entry is a path or `{"path": ..., "recursive": true, "ancestors": true}` for
an agent that nests skills or reads them from every ancestor directory),
`permissionCli` (permission-mode launch flags), `supportsManualCompaction`
(only if the agent accepts an explicit compaction request — bb hides
`/compact` otherwise), and `dialect` (the vendor side channels bb reads for
the agent: `cursor`, `opencode`, `omp`, or `grok`).

The change applies immediately: the plugin re-registers its providers when the
setting changes, with no restart and no `config refresh`.

A configured agent's command is local code execution and only works with a
co-located daemon.

### The deprecated `customAcpAgents` config array

Before ACP agents were plugin-owned, custom agents lived in `customAcpAgents`
in `~/.bb/config.json`. bb still **reads** that array so an existing agent keeps
working, logs a deprecation warning for each one, and never writes to it.
Support ends in 0.41 — move each entry into the `customAgents` setting above.
The two shapes are identical except that the setting has no `logo` field: a
plugin-registered provider's icon is a host glyph or an asset the plugin ships,
so a configured agent shows the generic tool glyph, and bb drops the field when
it reads the old array. A setting entry wins over a config entry with the same
`id`.

## Custom Models

Register extra picker models by editing top-level `customModels` in
`~/.bb/config.json`. Use this for a model the provider accepts but does not
list, such as a non-public preview id. This list has no set/unset CLI surface:
edit the JSON, then run `npx bb-app config refresh` or restart bb. `bb-app config list` prints the entries.

```json
{
  "customModels": [
    { "providerId": "claude-code", "model": "claude-example-preview" },
    {
      "providerId": "acp-my-agent",
      "model": "my-proxy/my-model",
      "displayName": "My Proxy Model"
    }
  ]
}
```

`providerId` accepts a built-in provider id (`codex`, `claude-code`, `pi`,
`acp-cursor`) or any `acp-*` provider id: an installed-only plugin provider
such as `acp-opencode`, or a custom ACP agent's derived `acp-<id>`. `displayName` is
optional; bb derives the label from the model id when it is omitted. bb skips
an invalid entry with a warning and keeps the rest of the config.

Each entry appears in `bb provider models <providerId>` and in the model
picker after the provider's own catalog. The provider catalog wins on a model
id collision. The "Streamer mode" General setting
(`bb settings general streamerMode true`) hides every entry from these lists
until you turn it off again.

A `customModels` entry only makes the id selectable; the provider must still
accept it. Built-in providers such as `claude-code` and `codex` accept
unlisted ids. An ACP agent receives the id over the protocol at session start
and can reject it. OpenCode rejects a model that is not in its own catalog,
so do not pin OpenCode models here: add the model to the OpenCode config and
bb discovers it automatically.

An OpenCode "agent" (build, plan, or a custom primary agent) is a session
mode, not a model, so it does not belong in `customModels`. bb does not select
OpenCode agents; set the default agent in the OpenCode config instead.

## Agent Instructions

bb can inject user-level and workspace-level agent instructions into every
provider-backed thread's system prompt, alongside the skills convention.

For user-level defaults across projects, create `AGENTS.md` in the bb data dir:

```
<dataDir>/AGENTS.md
```

For repo-specific guidance, create `.bb/AGENTS.md` at the workspace root:

```
<workspace>/.bb/AGENTS.md
```

The file contents are appended to bb's standard agent instructions when a
provider session starts, so the guidance applies regardless of which provider
runs. When both files exist, `<dataDir>/AGENTS.md` is appended first and
`<workspace>/.bb/AGENTS.md` second. An empty or whitespace-only file is treated
as absent.

No agent loads `.bb/AGENTS.md` natively, and provider-native instruction files
(`CLAUDE.md` for Claude Code, a repo-root `AGENTS.md` for Codex) remain
provider-specific. bb reads the files above itself and injects them, so use them
for guidance you want every bb thread to receive regardless of provider.

## Skills

User-level bb skills live under `<dataDir>/skills/<name>/SKILL.md`; for the
packaged app this is usually `~/.bb/skills`. Project skills live under
`<workspace>/.bb/skills/<name>/SKILL.md` and override same-named user or built-in
skills. Running plugins contribute a third tier: every `skills/<name>/SKILL.md`
in an installed plugin (relocatable via the manifest's `bb.skills` field) is
auto-imported while the plugin is loaded — overridden by project and user
skills by name, overriding built-ins.

bb indexes each provider's native skill roots for that provider's `/` command
menu. Each provider plugin declares where its agent keeps skills and slash
commands, and resolves on the host what only that machine and workspace know
(a moved config directory, installed vendor plugins, config-file entries); bb
itself knows no agent's layout. The Skills page and `bb skill list` show
native skills for every provider whose plugin declares or resolves roots. The
table lists what the shipped plugins declare and resolve.

| Provider     | User roots                                                                                               | Project roots                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Codex        | `~/.agents/skills`, `$CODEX_HOME/skills`                                                                 | `.agents/skills` from the repository root to the current directory, plus `.codex/skills`                     |
| Claude Code  | `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills`, plus enabled plugin skills                            | `.claude/skills` from the repository root to the current directory, plus enabled plugin skills               |
| Pi           | `~/.pi/agent/skills`, `~/.agents/skills`                                                                 | `.pi/skills` and `.agents/skills` from the repository root to the current directory                          |
| Cursor       | `~/.cursor/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`                            | The same four roots in the workspace                                                                         |
| OpenCode     | `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`                                      | `.opencode/skills`, `.claude/skills`, and `.agents/skills` from the repository root to the current directory |
| omp          | The active `~/.omp/.../agent` roots and supported Pi, Agents, Claude, Codex, and OpenCode roots          | `.omp/skills` and the supported compatibility roots from the repository root to the current directory        |
| Grok Build   | `$GROK_HOME/skills` or `~/.grok/skills`, plus `~/.agents/skills`, `~/.claude/skills`, `~/.cursor/skills` | The same four roots from the repository root to the current directory                                        |
| Hermes Agent | `$HERMES_HOME/skills` or `~/.hermes/skills`                                                              | None                                                                                                         |

OpenCode also uses `$OPENCODE_CONFIG_DIR/skills` when that variable exists.
Pi and omp use `$PI_CODING_AGENT_DIR` when that variable exists. omp also uses
`$OMP_PROFILE` or `$PI_PROFILE` to select its active profile root. Cursor and
Hermes can organize skills in category directories. bb scans those roots
recursively. Pi settings and packages can add skill paths. omp reads
`skills.customDirectories` from its YAML configuration. Hermes reads
`skills.external_dirs` from `config.yaml`.

Grok reads recursive paths from `[skills].paths` in `config.toml`. It also reads
enabled Grok and Claude-compatible plugin skills. Its Cursor and Claude
compatibility roots follow the related config and environment switches.

## Multi-machine

Settings → Machines can enroll,
rename, and remove machines; project settings can add a path or clone source on
each machine; and thread creation can target any enrolled machine with a usable
source. The CLI equivalents are `bb machine list`, `bb project create
--machine <id-or-name> ...`, `bb project source add --machine <id-or-name>
...`, and `bb thread spawn --machine <id-or-name> ...`.

Multi-machine execution is independent of browser access. Tailscale and bb
connect let another browser reach the bb server; multi-machine support lets
that server dispatch work to non-primary host daemons. The Settings → Machines
installer can use a paired bb connect account to route the daemon and its CLI
back to the server. Machine credentials remain locally managed as described at
the top of this document.

Each machine has a permission ceiling (`maxPermissionMode`, default `full`).
The server resolves every thread on that machine down to the ceiling, so a
paired sandbox machine can keep Full Access while a personal machine stays at
Approve for me or Accept Edits. A provider that supports no mode under the
ceiling is refused on that machine. Only an owner session sets it, on the machine
page (Settings → Machines → the machine, which also carries that machine's
projects, provider CLIs, update state, and rename/remove); it is deliberately
absent from the SDK and the `bb` CLI,
and machine credentials are rejected at both the bb connect gate and the
server. The boundary it defends is machine-to-machine: a process already
running on the server machine has the data directory and the server itself, so
it is trusted as the owner here exactly as it is for renaming or removing a
machine. The current value is readable through the host API and
`bb machine list --json`.

Machine installation and daemon protocol repair use the owning server as the
distribution source: `/install/version` reports the server package/protocol and
`/install/bb-app.tgz` serves its exact host-only package with a SHA-256 digest
and strong ETag. That package contains the daemon, its workers and native
dependencies, and the bundled `bb` CLI; it omits the server and web app. The
installer verifies the digest and skips the download and npm install when its
recorded installed digest receives `304 Not Modified`. It falls back to the npm
registry only when the package route returns 404. It installs the package under
the machine's bb data directory rather than npm's system-wide prefix, so
enrollment needs neither `sudo` nor a global npm configuration.
Installed services enable `--auto-update`; remove that flag from the launchd
plist or systemd user unit and reload the service to opt out. Updates only move
to a newer server protocol, retry failures with a persisted exponential backoff
from 5 seconds to 5 minutes, and never downgrade a daemon. Settings → Machines
and `bb machine retry-update <id-or-name>` can bypass the current backoff after
a transient failure.

## Thread splits

Thread splits enable up to eight panes in the app's multi-pane thread view and
its sidebar, menu, and keyboard split controls. Edge placement creates panes
through the eighth pane; at the eight-pane limit, opening a new thread with an
edge placement replaces the focused pane. Every pane header can temporarily
maximize that pane without unmounting or resizing the underlying split tree;
the same control restores the exact arrangement. Maximization follows focus and
newly opened panes, closing the maximized pane restores the surviving layout,
and both the split tree and maximized pane restore after reload. Compact
viewports show the ordinary single-page surface while preserving that desktop
layout state.
It also enables explicit split placement through
`bb thread open <thread-id> --split right|down|left|top|replace` and the matching
SDK request, plus pane presentation controls through
`bb thread pane maximize|restore|toggle|spotlight|clear-spotlight [thread-id]` and
`sdk.threads.paneAction({ threadId, action })`. Pane actions apply only when the
target thread is already open in a multi-pane app window; the response reports
how many connected clients received the broadcast. `spotlight` focuses the
target pane and persistently dims the others; `clear-spotlight` focuses it and
persistently restores undimmed splits.

## Account Pooler [Experimental]

The builtin Account Pooler plugin is disabled on fresh installations. It stores
non-secret Claude and Codex account metadata in plugin KV, quota observations
in the plugin SQLite database, and each account token plus per-machine hub
tokens in 0600 files under
`<data-dir>/plugins/account-pool/secrets/accounts/`.
Enable it and add at least one account:

```sh
bb plugin enable account-pool
bb pool account add --provider claude --login
printf '%s\n' "$CLAUDE_AUTH_CODE" | bb pool account login-complete --session <id> --code-stdin
bb pool account add --provider codex --login
bb pool account login-poll --session <id>
bb pool account add --provider claude --import
bb pool account add --provider codex --import
printf '%s\n' "$ANTHROPIC_API_KEY" | bb pool account add --provider claude --api-key-stdin [--label <text>] [--priority <n>]
```

The Claude login start command creates a ten-minute in-memory PKCE session,
prints a browser authorization URL and session ID, then exits. After sign-in,
pipe the code shown on Anthropic's manual callback page to
`account login-complete` with that session ID. The browser can be on a different
machine from the bb server, and the code stays out of process arguments. The
Codex login command prints a ChatGPT device verification URL, one-time code,
session ID, and an `account login-poll` command that waits until authorization
completes or expires. The Account Pooler plugin settings page exposes both flows
with **Sign in to Claude** and **Sign in to Codex**, plus Claude import,
API-key, enable/disable, and removal controls.

The CLI import paths read the Claude Code or Codex login on the bb server host.
`--api-key-stdin` reads exactly one non-empty key from piped standard input and
is the default API-key path for agents. The compatibility form `--api-key
<key>` remains available, but exposes the secret in process arguments, shell
history, and agent transcripts. The hub starts immediately, so a newly added
or enabled account is available without a plugin reload.

When the plugin has an enabled account whose secret file is readable and
valid, it automatically contributes the provider's hub route and a
machine-specific secret token to Claude Code or Codex sessions on every host.
Claude Code also receives `ENABLE_TOOL_SEARCH=true`.
Codex receives `CODEX_OPENAI_BASE_URL` and the secret
`CODEX_POOL_AUTH_TOKEN`; bb applies both when launching `codex app-server`
without writing to `~/.codex/config.toml`.
Claude Code disables tool search behind a custom base URL by default; the hub
forwards `tool_reference` blocks unchanged, so the override keeps it on.
Tokens are never printed
by the CLI. Plugin startup and `bb pool status` remove token files for machines
that are no longer enrolled. Status lists token mint and last-use timestamps
plus recently routed threads whose machines do not have a usable local Claude
login. Rotate one machine's token with
`bb pool token rotate --machine <id-or-name>`; the prior token remains valid
for ten minutes so in-flight requests can drain. Bypass or restore routing for
one thread with `bb pool bypass <thread-id>` or
`bb pool bypass <thread-id> --off`. Account listing, enable, disable, and
removal are available through `bb pool account list|enable|disable|remove`.
Provider routing is independently persisted and defaults on. Use
`bb pool routing <claude|codex> --off` to stop contributing pool environment
and health for one provider, and omit `--off` to enable it again.
OAuth accounts refresh quota from Anthropic's usage endpoint when added or
enabled and every five minutes while idle. `account list` adds columns for the
family buckets Anthropic reports; JSON status exposes their utilization,
reset, status, observation time, and `header` or `usage` source under
`familyWeekly`. Requests route around an account spent for their model family
without disabling that account for other families. Imported and newly signed-in
accounts retain their Anthropic account UUID, and the hub aligns a present
`metadata.user_id` account component with the selected account.

Accounts run sequentially per provider: lower priority numbers first, with ties
following the order accounts were added. New conversations use the current
account until it reaches the switch threshold or fails; the pool then advances
to the next eligible account and wraps at the end. It keeps using that fallback
even when an earlier account recovers. Existing conversations stay pinned while
their account remains eligible. Short temporary rate limits wait on the same
account once; longer holds return Retry-After for pinned conversations while new
conversations can advance. A model-family limit detours only requests for that
family without moving the session's main pin or the provider cursor. The cursor
and session pins survive hub restarts. Session pins expire after 30 idle minutes,
and the pool retains the 4,096 most recently used pins.

Use the up/down arrows in Account Pooler settings, or
`bb pool account reorder <claude|codex> <id>...`, to set the complete order for
one provider. Include disabled accounts too. Reordering changes the next failover
sequence without moving the current account. `bb pool account priority <id> <n>`
sets an individual priority; the same operations are available through the
`account.reorder` and `account.setPriority` plugin RPCs.

Three plugin-owned configuration values control routing. `switchThreshold` is
the shared or requested model-family quota fraction at which an account stops
receiving matching traffic and defaults to `0.98`.
`anthropicUpstreamBaseUrl` defaults to `https://api.anthropic.com` and
`codexUpstreamBaseUrl` defaults to
`https://chatgpt.com/backend-api/codex`. Codex uses the hub's HTTP Responses
and models routes and prefers its WebSocket Responses route; the hub keeps the
downstream WebSocket session semantics while forwarding upstream over HTTPS
SSE. Both URL values exist only for tests and QA with a controlled fake
upstream. Inspect or update the full plugin KV-backed configuration with:

```sh
bb pool config
bb pool config set switchThreshold 0.98
bb pool config set anthropicUpstreamBaseUrl http://127.0.0.1:9000
bb pool config set codexUpstreamBaseUrl http://127.0.0.1:9001
```

Upgrading from an Account Pooler build that stored these values through
`bb.settings` resets the threshold and both QA-only upstream overrides to
their defaults. Those old values are not migrated.

## bb connect

`bb connect --code <code> --server https://<handle>.getbb.app` pairs this bb
server for browser access at `<handle>.getbb.app` (claim a handle and copy the
command at https://getbb.app). Remote access is owned by the builtin
**connect plugin** (`plugins/connect/`): pairing redeems the code and stores
the durable credential in the plugin's kv storage (in `bb.db`), and the
plugin's background service holds the connect tunnel — dialing the gate,
proxying relayed requests to the server's own loopback (which serves the SPA

- `/api` + `/ws`), and reconnecting with capped backoff. The tunnel therefore
  lives as long as the bb server runs (with the plugin enabled) and
  re-establishes on restart; there is no foreground client. Pair from a machine
  without an installed bb via `npx -p bb-app@latest bb connect …`.
  `bb connect status` shows the connect state and every share's host and URL;
  `bb connect off` disconnects and clears the pairing. After pairing,
  `bb connect expose <port>` run from a thread shares that thread environment's
  enrolled host. Server-host URLs remain
  `https://<server-label>--<port>.getbb.app`; other machines use
  `https://<machine-label>--<port>.getbb.app` and proxy directly through the
  owning daemon. Outside a thread the command defaults to the server host;
  `--host <name-or-id>` overrides host resolution. Access requires the owner's
  getbb.app session (not a public link). `bb connect unexpose <port>` and
  `bb connect shares` use the same host resolution and accept the same
  `--host` override. Their JSON rows include `hostId`, `hostName`, `port`, and
  `url`; `shares --json` also includes the resolved `host`. A machine without
  a live Connect enrollment fails fast with instructions to remove and re-add
  it in Settings → Machines. Disabling the plugin
  (`bb plugin disable connect`) cuts off all remote access;
  `bb plugin enable connect` restores it.

The tunnel client lives in `plugins/connect/`; the CLI command is proxied to
the plugin, and Settings → Connect drives the plugin's rpc (including shared
ports).

### Pairing the bb mobile app

The bb mobile app reaches a paired bb through the same connect route. It
enrolls as a connect **machine** — its own credential on the getbb.app account,
separate from the server's pairing secret and individually revocable — so
pairing starts from the bb, not from the phone. Both pairing surfaces sit
behind the `mobileApp` experiment (Settings → Experiments → **Mobile app**, or
`bb settings experiment mobileApp true`) until the app is generally available;
the connect plugin reads the experiment from `/system/config` on every call,
so a toggle applies without a plugin reload:

- Settings → Remote access → **Add mobile device** mints a one-time code and
  shows it as a QR code plus copyable text with a countdown.
- `bb connect machine-code` prints the same code, server URL, connect apex,
  and expiry; `bb connect machine-code --json` returns
  `{code, serverUrl, apex, expiresAt}` (the QR encodes that JSON).

Scan or type the code in the mobile app. The code lasts 10 minutes and works
once. The phone then appears in the getbb.app dashboard machine list, where you
can revoke it; every enrollment takes one of the account's machine slots
(desktop apps, remote execution machines, and phones all count), so a
machine-limit error asks you to revoke an unused device first. Both surfaces
need the experiment on, the bb paired (`bb connect --code …`), and the connect
plugin enabled; with the experiment off the panel hides the section and
`bb connect machine-code` exits 1 with a pointer to the toggle.

## Experiments

Experimental surfaces are changed in Settings → Experiments or with
`bb settings experiment <key> <true|false>`. Most start off; `editMessages`
starts on and its toggle is the opt-out.
The default-off `changelogPreview` experiment shows the latest release notes
as a compact, dismissible card on Settings → Updates.
The `editMessages` experiment is on by default and enables replacing an
eligible, accepted root user message in a Codex, Claude Code, or Pi thread,
including failed or incomplete turns. Turn it off to hide the editor. Grouped
multi-message requests are not yet editable. Opening the editor does not change
history; if the thread is running, submission stops the current turn and waits
for it to settle before atomically replacing that message and every later turn
while keeping workspace changes.

The `mobileApp` experiment turns on pairing for the bb mobile app: the
**Add mobile device** card under Settings → Remote access and the
`bb connect machine-code` command (see "Pairing the bb mobile app" above). It
is off by default while the app is in early access.

BB releases restorable provider sessions after 30 idle minutes. The daemon
checks for these sessions every five minutes. Active turns, commands, agents,
workflows, and monitors keep their sessions loaded.

The `sidebarProgressiveDisclosure` experiment is off by default. In **By
project** and **By machine**, it shows the first five groups in the current sort
order, keeps attention groups visible, and reveals ten more per **Show more**
click. Revealed groups stay visible through activity and sort-order changes.
**Manually** is unchanged. Toggle it with `bb settings experiment
sidebarProgressiveDisclosure <true|false>`.

The `timelineWindowing` experiment is off by default. When enabled, long
timelines and large expanded timeline details retain stable height-preserving
wrappers while mounting only rows near their active scrollport. Toggle it with
`bb settings experiment timelineWindowing <true|false>`.

## Thread Timeline Window

A thread-timeline window is bounded by segment (user-message) count _and_ by
event count. Segment count alone is a weak bound on work, because an agentic
turn can be thousands of events: a thread with 21 user messages and 21k events
used to reproject its entire history on every timeline request. That projection
is synchronous, so it blocked the server's event loop — which also delayed
`/internal/session/events`, the endpoint the host daemon awaits before every
dynamic tool call and before registering every interactive request. One slow
thread therefore slowed agent work on _every_ thread on the host.

A window is capped at `BB_FF_TIMELINE_WINDOW_EVENT_BUDGET` events (default 1500) and returns however many whole turns fit. Older turns load automatically
as you scroll toward the top of the loaded window; a manual "Load older
messages" button remains on surfaces that render no scroll body, and after a
failed page so a broken fetch is retried on request rather than in a loop.
Nothing becomes unreachable — pagination still walks the full history, and the
head-state banners (goal, pending todos, running workflows, background
commands) are resolved by thread-scoped lookups rather than by scanning the
window, so a narrow window cannot drop them mid-session.

A turn larger than the whole budget is cut at the budget while it is _running_,
so watching an agent work through a very long turn costs the budget per update
rather than the whole turn; scrolling up loads the earlier part. Once the turn
finishes it is rendered whole again, because a finished turn collapses into one
summary row that two pages cannot each own — so the budget bounds a running turn
and a long thread, but not a single finished oversized turn.

Raising the budget far above the default restores the previous
unbounded-in-practice behavior; it is an operator escape hatch set at server
start, not a product setting.

Timeline builds slower than 150ms log `Thread timeline build blocked the event
loop` with a per-stage breakdown, and event-loop stalls over 500ms log `Event
loop stalled`. Both log at `info`, so they are visible in `~/.bb/logs/` without
raising `BB_LOG_LEVEL`.

## Plugins

Plugins are on by default. Builtin plugins, including connect, ship with bb;
user-installed plugins come from `bb plugin install` or the bundled official
store.

Plugin state lives under the data dir:

```
<dataDir>/plugins/<id>/data.db     Per-plugin SQLite database
<dataDir>/plugins/<id>/secrets/    Secret settings and the plugin HTTP token
<dataDir>/plugins/<id>/logs/       bb.log output (plugin.log, JSONL, rotated
                                   at 5MB; read with `bb plugin logs <id>`)
<dataDir>/plugins/git/, npm/       Managed installs for git:/npm: sources
<dataDir>/marketplaces/staging/    Throwaway checkouts a git: marketplace
                                   refresh reads its manifest from, deleted
                                   as soon as the catalog is stored
<dataDir>/skills-generated/        Server-generated skills (the
                                   plugin-commands skill listing plugin CLI
                                   commands, injected into agent threads)
```

BB's official plugins (GitHub, Docs, Memory, and Tasks) ship bundled
inside the app and install from the local bundled copy — no network, no remote catalog.
Discover them with `bb plugin search` or Extensions → Plugins → Browse; users
cannot add, remove, or configure the bundled official plugin set. Installed official
plugins are pinned to the bundled copy and update with BB app releases. Local
path installs remain available directly through `bb plugin install ./path` or
`path:...`, and direct `npm:`/`git:` installs stay supported.

Marketplace catalogs and their validated icon bytes live in the bb database,
not on disk. `bb marketplace add|list|refresh|remove` and Settings → Plugin
marketplaces manage them; the reserved `bb-community` marketplace comes from
`BB_MARKETPLACE_URL` and cannot be added or removed. Adding a marketplace
installs nothing, and removing one keeps its installed plugins as direct
installs.

### Multi-plugin repositories

A repository can hold several plugins. Each plugin directory keeps its own
`package.json` and `bb` manifest; an optional `.bb/plugins.json` collection
manifest at the repository root indexes them:

```json
{
  "$schema": "https://getbb.app/schemas/plugins.schema.json",
  "schemaVersion": 1,
  "name": "acme-plugins",
  "plugins": [
    { "name": "notes", "source": "./plugins/notes" },
    { "name": "status", "source": "./plugins/status" }
  ]
}
```

The file is strict: `schemaVersion` must be `1`, names match
`^[a-z0-9][a-z0-9-]*$`, unknown fields and duplicate names are rejected, and
each `source` is a repository-relative directory starting with `./` — absolute
paths, `..`, empty segments, and the repository root itself are refused. An
invalid file is rejected whole. The manifest is an index only; it never
overrides a plugin's identity, branding, entry points, or engine ranges.

Install one plugin of the repository with
`bb plugin install git:<url>[@<ref|semver-range>] --plugin <name>` (resolves a collection
entry) or `--subdirectory <relative-path>` (the primitive, which needs no
collection manifest). Both flags work for `path:` sources and are mutually
exclusive. Installs from the same repository and commit share one cached
checkout, and the selected subdirectory is recorded with the install, so
`bb plugin outdated`, `update`, rollback, and `remove` act per plugin. A
repository that has a collection manifest and is not a plugin itself refuses
an unselected install and lists its entry names.

### Plugin updates

Bundled builtin and official plugins update with BB app releases. For direct
`git:`/`npm:` installs, update application is manual: `bb plugin outdated` or
the "Check for updates" key on the Plugins page checks tracking sources, and
`bb plugin update <id>` / `bb plugin update --all` or the "Update x.y.z" pill
applies compatible candidates. The server also checks every installed plugin
every 6 hours (the first check runs when any plugin has no recorded check or
the oldest one is older than 6 hours), at most four plugins at a time, and a
manual check joins a sweep already in flight; a check only records what is
available and never installs or runs plugin code. There is no automatic plugin update
application or update audit feed. Reinstalling an already-installed managed plugin is
refused — use `bb plugin update`. Before activation bb snapshots the plugin
database, host-managed settings/storage/schedules, secrets, and registration.
A failed activation restores that snapshot and records the latest failure on
the plugin so it can be surfaced as needing attention.

### Provider retry plugin

The builtin Provider retry plugin is enabled on fresh installations. When a turn
fails on a structured Codex or Claude Code subscription-window limit that
reports a reset time, it queues that turn after the window opens. It also
retries structured provider overloads with exponential backoff and jitter.
Prior output or tool activity does not block recovery. If the provider accepted
the failed input, core sends an agent-only continuation; if it rejected the
input before starting, core re-sends the original message as agent-only. Disable
the plugin under Extensions → Plugins or with
`bb plugin disable provider-retry`.

It never blocks a send. A remembered rate limit is a stale picture of the
provider's state, so the plugin never refuses a dispatch on one — if you raised
your plan or the window opened early, the next send simply works. The cost is
that several threads on one exhausted subscription each fail once before each
schedules its own retry; the retries are jittered so they do not all wake in the
same instant. Overload retries start after 5–10 seconds, double their delay
after each failure, and share the five-total-attempt cap with limit retries.
The `maximumWait` setting defaults to `6 hours`; resets beyond that horizon are
not scheduled. Choose `24 hours` or `No limit` under the plugin settings, or
configure it from the CLI:

```bash
bb plugin config provider-retry set maximumWait "24 hours"
```

A pending retry is a queued row on the thread, not an in-process timer, so it
survives a restart and shows its reason and time on the queue card above the
composer — the one surface that narrates the wait. Inspect them with
`bb provider-retry status`, cancel one on that card or with
`bb provider-retry cancel <thread-id>`, or run
`bb provider-retry retry <thread-id>` to send it now instead of waiting. Limits
that do not reset on a clock — credit and spend-control exhaustion — schedule
nothing, because waiting does not fix them.

### Workflows plugin

The builtin Workflows plugin is disabled on fresh installations. Enable it
under Extensions → Plugins or with `bb plugin enable workflows`. Its six
settings are bounded integers, edited with numeric inputs under Extensions →
Plugins or with `bb plugin config workflows set <key> <value>`:

| Key                    |    Default |       Allowed range | Behavior                                               |
| ---------------------- | ---------: | ------------------: | ------------------------------------------------------ |
| `maxActiveRuns`        |        `4` |            `1`–`32` | Concurrent runs across the plugin; changes apply live. |
| `maxConcurrentAgents`  |        `8` |            `1`–`64` | Concurrent agent calls within one run.                 |
| `maxAgentCalls`        |      `100` |          `1`–`1000` | Total agent calls within one run.                      |
| `totalRunTimeoutMs`    | `86400000` | `60000`–`604800000` | Maximum total run duration in milliseconds.            |
| `retentionDays`        |        `7` |          `1`–`3650` | Days to retain completed workflow data.                |
| `maxNotificationBytes` |    `16384` |     `1024`–`262144` | Maximum UTF-8 size of a completion notification.       |

The five settings other than `maxActiveRuns` are snapshotted into each new run.
Settings changes do not require a plugin reload.

`bb plugin install npm:<package>[@<version|tag|range>]` requires `npm` on PATH
(packages are installed with `--ignore-scripts`). Git plugins also use npm with
lifecycle scripts disabled, so they may depend on third-party packages; bb
then builds both their server and frontend bundles. `node_modules` is
retained, because a dependency can load data files that bundling cannot
inline. A committed `dist/` is always replaced by the bundles bb builds.
Dependency resolution and bundling run on install and update-apply only —
never on an update check, which reads the manifest and stops. An omitted npm
spec tracks the newest compatible stable release, ranges track within the
range, dist-tags track the tag, and exact versions are pinned. A bare HTTP(S)
Git repository URL or `git:<url>[@<ref|semver-range>]` requires `git`; an
omitted ref tracks the repository's default branch, explicit branches track
their head, and tags and commits are pinned. A semver range
(`git:<url>@^1.2.0`, or `@semver:<range>` to state the intent explicitly)
tracks the repository's `[<tag-prefix>]vX.Y.Z` release tags: bb installs the
highest release the range allows, excludes prereleases unless the range names
one, records the tag and the commit it pointed at, and refuses that tag later
if it moved. `--tag-prefix <prefix>` ranges over one plugin's tags in a
multi-plugin repository. A bare range that is also a literal branch or tag
name fails the install and asks for `@semver:` or `@ref:`. Local
path installs register the directory in place and never delete it. Builtin
plugins use `builtin:<name>` and ship with bb unless removed. Managed
(`git:`/`npm:`) installs
refuse plugins whose optional `engines.bb` or `engines.bbPluginSdk` ranges
do not match the running bb/SDK, or whose `dist/*.meta.json` plugin identity
does not match the package manifest; installing a non-builtin source whose
derived id collides with a builtin name (automations, connect,
custom-instructions, inline-vis, secrets, workflows) is also refused.

`engines.bbPluginSdk` is a floor, not a ceiling. bb reads the lowest version
the range allows and runs the plugin on any SDK at or above it within the same
major, so a caret range such as `^0.4.1` keeps working after the SDK moves to
`0.4.3` or a later `0.x`. Only a plugin that asks for a newer SDK than this bb
provides, or one pinned to a different major, is incompatible. Declare the
oldest SDK you need (`>=0.4.3`); a breaking plugin API change bumps the major.

The same tracking intent drives updates: `bb plugin outdated` checks for
compatible candidates (and reports blocked incompatible newer releases);
`bb plugin update <id>` / `bb plugin update --all` applies them. Pinned source
intent is never widened by update; remove and reinstall to choose a different
source intent. Dev builds (bb `0.0.0`) do not enforce `engines.bb` and annotate
that on check results.
Update confirmation matches install (full-trust code; `--yes` skips; non-TTY
refuses without it). Plugins are full-trust code running inside the bb server
process: they can read all local bb data, including other plugins' secrets.

## Startup Flags

Use launcher flags for per-run startup details:

```bash
npx bb-app --data-dir ~/.bb-test --server-port 48886 --host-daemon-port 48887
```

The server listens on `127.0.0.1` by default. Set
`--server-bind-host 0.0.0.0` (or `BB_SERVER_BIND_HOST=0.0.0.0`) only when a
trusted network boundary must reach the listener directly. The public API is
unauthenticated and permits command execution and file reads, so never expose a
wildcard-bound server to an untrusted network. The only accepted bind hosts are
`127.0.0.1` and `0.0.0.0`; this startup-only setting is not available through
`bb-app config`.

The startup `Server listening` and `app` lines show the actual listener address.
With wildcard binding they show `http://0.0.0.0:<port>`, while bb's health check
and colocated host daemon continue to connect through `127.0.0.1`. That local
connection does not narrow the listener. `0.0.0.0` exposes IPv4 interfaces only;
bb does not currently offer an IPv6 wildcard bind option.

The data directory is the root directory for all bb-managed state: the SQLite
database, logs, host identity, thread storage, custom themes (`theme/`,
including optional Pierre / VS Code `pierre-dark.json` and `pierre-light.json`),
and
plugins. It defaults to `~/.bb/` for the packaged app. The `pnpm dev` source launcher derives an isolated data
directory under `~/.bb-dev/<checkout-instance>/` from the checkout path. The
checkout instance id is the sanitized path to the checkout, relative to your
home directory, plus a short hash suffix. Use `--data-dir` to point packaged-app
instances at different data directories for fully isolated environments.

If the default ports are already in use, set explicit ports before starting:

```bash
npx bb-app --server-port 48886 --host-daemon-port 48887
```

The Settings → Machines installer assigns every enrolled standalone host daemon
a stable local API port so it can coexist with the desktop app and with daemons
enrolled to other servers. Atomic reservations under
`~/.bb-machines/host-daemon-ports/` cover both default and custom
`BB_DATA_DIR` locations. Its generated command accepts `--host-daemon-port
<port>` when an explicit port is required.

## Source Development

For source development only, `pnpm dev`, `pnpm start:worktree`,
`pnpm start:worktree-remote`, and `pnpm start` load the repo-root dotenv
cascade. Add a repo-root `.env` only when you need to override the defaults
described above.

The standard [dotenv-cli](https://github.com/entropitor/dotenv-cli) cascade
applies to source development. `pnpm dev` loads `.env`, `.env.local`,
`.env.development`, and `.env.development.local`, then overrides the instance
selectors (`BB_DATA_DIR`, server URL/port, host-daemon local API port, and Vite
port) with deterministic values derived from the checkout path. The SQLite
database path is always derived from `BB_DATA_DIR`. Both the main server and
Vite app bind to loopback by default; an explicit `BB_DEV_APP_HOST` still
overrides the Vite listener. Remote HTTP dev via `BB_DEV_APP_HOST` also requires
`BB_SERVER_BIND_HOST=0.0.0.0` for realtime updates; the Tailscale Serve HTTPS
path avoids this because WebSocket traffic goes through the Vite proxy.
`pnpm start:worktree` loads the same development dotenv cascade and uses the
same checkout-specific data directory, server port, and host-daemon port. It
builds production artifacts and serves the frontend bundle from the main
server, so there is no separate Vite listener or hot reload. Telemetry remains
disabled for this source-development command. Its worktree data directory,
ports, inherited skills, listener host, absent Vite port, and telemetry policy
take precedence over conflicting values saved in that instance's `config.json`
or `env.json`.
`pnpm start:worktree-remote` applies the same policy while binding the main
server to `0.0.0.0` for direct access on a trusted network. The API is
unauthenticated and permits command execution and file reads, so protect the
port with a trusted network boundary such as Tailscale and a host firewall.
`pnpm start` loads `.env`, `.env.local`, `.env.production`, and
`.env.production.local`.

Production startup from source uses the same launcher policy as the packaged
app while reading build outputs directly from `apps/app`, `apps/server`, and
`apps/host-daemon`. `pnpm start:host-daemon` continues to run the packaged
`packages/bb-app/dist/bb-app.js host-daemon` entrypoint. Source-only scripts do
not own production ports or data-dir defaults.

Source checkout commands such as `pnpm bb`, `pnpm bb:dev`, and `pnpm reset`
are thin wrappers around `@bb/scripts`. Those wrappers force `NODE_ENV` to the
intended mode so ambient shell state does not silently retarget bb.

Use `pnpm reset` or `pnpm reset:dev` to clear a data directory. These only
remove bb-managed state, not provider credentials.

`BB_PROVIDER_BRIDGE_RECORD_DIR=<dir>` in the host daemon's environment turns
on bridge record mode: every provider bridge writes the lines that cross its
runtime and provider wires as NDJSON under `<dir>/<providerId>/<threadId>/`.
It is a development and diagnostics knob, off by default, and never reaches a
provider child. See [provider-bridge-protocol.md](provider-bridge-protocol.md),
"Record mode", and [debugging-and-qa.md](debugging-and-qa.md). Raw recordings
can contain secrets; redact them with `scripts/provider-recordings/redact.mjs`
before you share them.

## Browser Automation runtime

Agents use `bb browser-automation` through its bundled skill. Screenshot results
contain temporary JPEG paths and the browser host ID; remote captures can be
fetched with `bb file read <path> --host <host-id> --json`. Read or copy images
before closing the session, which deletes its temporary files.

The Browser Automation plugin supports desktop attachment and headless Chrome on enrolled hosts. Cloud browsers are deferred. The plugin pins one exact `dev-browser` npm release (currently 1.0.0-rc.3) with per-platform binary digests in `plugins/browser-automation/runtime-pin.ts`; the pin, the verification steps, and the bump procedure are documented in `plugins/browser-automation/README.md`.

On each selected browser host, the plugin's host worker installs that release automatically on first use under `<plugin host dataDir>/runtime/npm/`, using the host's `npm` with scripts disabled, verifying the registry signature and SLSA provenance, downloading the matching GitHub release binary, and checking its digest before launch. Later sessions reuse the verified install without network access. Headless mode discovers installed Chrome/Chromium or uses `<plugin host dataDir>/runtime/chrome`. These files belong to the plugin host storage directory; they are not paths on the server or invoking agent host, and the user's global npm installation is never modified. No runtime sandbox-disabling setting is provided.

For isolated development smoke tests only, `DEV_BROWSER_SMOKE_BINARY` selects the absolute binary path for the runtime smoke, `DEV_BROWSER_SMOKE_CHROME` selects the absolute Chrome path, and `DEV_BROWSER_SMOKE_NO_SANDBOX=1` enables the fixture's no-sandbox wrapper where the test host requires it. The `smoke:install` task performs a real install of the pinned release into a disposable directory. These variables do not change normal plugin runtime behavior.
