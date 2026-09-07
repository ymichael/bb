# CLI, input, agents, and AI services

### bb.cli — an agent-facing `bb` subcommand

One top-level command per plugin; a second `register` in one factory
execution is rejected.
Users and agents run `bb <name> …` like any core command; the bb CLI
proxies it to the server, where `run` executes. Core collisions log an
activation warning and appear in `bb plugin list` as `bb plugin run <id>`.

```ts
bb.cli.register({
  name: "weather", // lowercase [a-z0-9-]+; core collisions use bb plugin run <id>
  summary: "Weather lookups",
  commands: [
    // help/skill metadata only; parsing argv is yours
    {
      name: "today",
      summary: "Today's weather",
      usage: "bb weather today <city>",
    },
  ],
  async run(argv, ctx) {
    // argv EXCLUDES the command name: `bb weather today sf` → argv = ["today", "sf"]
    // ctx: { cwd?, threadId?, projectId?, signal }
    return { exitCode: 0, stdout: "sunny" }; // { exitCode, stdout?, stderr? }
  },
});
```

Agents discover plugin commands through the server-generated
`plugin-commands` skill, which lists each command's `summary` and the
`commands` usage lines — fill both in. Combined stdout and stderr must fit
`PLUGIN_CLI_OUTPUT_MAX_BYTES` from `@get-bb/plugin-sdk` (1,048,576 UTF-8 bytes).
The host rejects a larger result atomically as `plugin_cli_output_too_large`;
it never clips it. Page growing collections, cap verbose fields, and use
file/streaming commands for large content. Caveat: under the workspace
sandbox (Accept Edits / Approve for me), Claude's macOS sandbox permits
loopback, so `bb` CLI calls (including plugin commands) work sandboxed;
Linux and other provider sandboxes may still block loopback, in which case
those calls need escalation approval.

**Multi-machine rule: `run` executes on the server, so a path argument names
a file on the INVOKING machine, not on `run`'s filesystem.** Never open a
`ctx.cwd`-relative or user-supplied path with `node:fs` — on an enrolled
remote machine that silently reads or writes the wrong host's disk. Instead
resolve the invoking host (`ctx.threadId` → `bb.sdk.threads.get` →
`environmentId` → `bb.sdk.environments.get(...).hostId`, with an explicit
`--machine`-style flag as the no-thread escape hatch) and do all such file I/O
through `bb.sdk.files` with that `hostId`. An omitted SDK `hostId` targets the
primary host, which can be an enrolled remote machine. Reference
implementations: the docs plugin's pull/push sync and the
tasks plugin's attachment commands. `node:fs` remains correct for genuinely
server-local data such as files under the plugin's own data directory.

### bb.ui.requestInput — replace the composer with a blocking plugin form

Use `bb.ui.requestInput({ threadId, rendererId, title, payload, timeoutMs? },
{ signal? })` when plugin backend code must wait for sensitive or structured
user input. The promise resolves to `{ outcome: "submitted", value }` or
`{ outcome: "cancelled", reason }`. Payloads and responses are JSON values
capped at 64 KiB; response values are delivered only to the waiting plugin
invocation and are never persisted. Pair `rendererId` with a frontend
`pendingInteraction` slot. Pass a CLI handler's `ctx.signal` so disconnecting
the caller cancels the request.

### bb.agents — native tools and conditional session configuration

To give agents standing knowledge (conventions, workflows), ship a
`skills/` directory. For schema'd capabilities, register a native tool.
For a short, per-resolution instruction block (e.g. "the user is viewing
bb remotely — share tunnel URLs"), use `contributeInstructions`:

```ts
import { z } from "zod"; // runtime import — declare zod as a plugin dependency
bb.agents.registerTool({
  name: "docs_search", // [a-zA-Z0-9_-]+, unique ACROSS plugins
  description: "Search the bundled docs.",
  instructions: "Prefer docs_search over guessing conventions.", // optional, appended to thread instructions
  // Optional row presentation (grammar v3). Without it, BB shows its normal
  // tool name and the plugin's branding glyph. Errors/interruptions keep
  // that standard rendering so the failing tool remains identifiable.
  presentation: {
    label: {
      pending: "Searching bundled docs",
      completed: "Searched bundled docs",
    },
  },
  parameters: z.object({ query: z.string().min(1) }),
  async execute({ query }, { threadId, projectId, signal }) {
    return excerpts.join("\n"); // or { content: [{ type: "text", text }], isError? }
  },
});

// All tools and manifest skills are static registrations. configure() only
// selects this plugin's own ids when BB resolves a thread/session config.
bb.agents.configure((context) => ({
  tools: context.provider.id === "codex" ? ["docs_search"] : [],
  skills: context.project.kind === "standard" ? ["repo-conventions"] : [],
  instructions: `Docs selection resolved for ${context.project.name}.`,
}));

// Dynamic section evaluated at thread.start / turn.submit (sync, fast).
// Return null to contribute nothing for that resolution. Duplicate factory
// registrations are rejected. Output is capped at 4096
// characters; a throw is logged and contributes nothing. Side-chat
// threads never receive plugin instructions.
bb.agents.contributeInstructions(({ threadId, projectId }) => {
  if (!shouldAdviseRemoteUrls()) return null;
  return "The user is viewing bb remotely — share tunnel URLs, not localhost.";
});
```

`parameters` is a zod schema (zod 4; validated per call — bad model args
become a tool error, not a plugin crash) or a plain JSON-schema object
(execute then receives raw `unknown`). Tool-set changes apply on the NEXT
session start, not mid-session. Name collisions: within one factory execution
duplicate registrations are rejected; across plugins the earlier plugin wins
and yours is dropped with the reason in your status detail.

`presentation` is optional: `label` supplies static, concise
titles for the pending and completed states (each limited to 80 characters;
a longer label rejects the registration), `icon` a host glyph name or one of
this plugin's declared icons as `{ glyph: "<pluginId>/<name>" }` (see
`bb.branding.experimental_icons`; another plugin's id or an undeclared name
rejects the registration), `suppress` collapses low-value rows by default,
and `tint` accents the row per theme. The server resolves one full presentation per tool and the
provider bridge stamps it on every call's timeline row (the row's glyph is
checked at ingest against this plugin's declared icons, whichever plugin
provides the thread); it is not a frontend
bundle hook. A state with no label — error, interrupted, or awaiting
approval — falls back to BB's standard `Running tool …` / `Ran tool …`
wording, as does omitting the field entirely.

`contributeInstructions` is synchronous. It runs on `thread.start` and
`turn.submit`, so keep it fast. Prefer `skills/` for standing knowledge. Use
this callback only when the text must reflect live plugin state.

Ordering is standard BB instructions, selected tools' static snippets,
`contributeInstructions` output, `configure` dynamic instructions, data-dir
user instructions, then workspace instructions. Tool snippets are rejected at
registration above 4096 characters; each legacy/dynamic callback contribution
is truncated to 4096 characters.

`configure` is also synchronous and may be registered only once per factory
execution. Its context has required, plain-data `thread`, `project`,
`environment`, `host`, and `provider` objects. The `provider` object includes
`id`, `model`, and declared capabilities. The `origin` object has `kind` and
`pluginId`; genuinely absent values are `null`, not omitted. A side chat has
`origin: { kind: "fork", pluginId: "side-chat" }`. `tools` names and `skills`
frontmatter names may select only this plugin's static registrations. A
`tools` entry may instead be
`{ name, parameters }` to override the parameter schema advertised to the
provider for that resolution only — `parameters` must be a JSON-serializable
JSON-schema object with root `type: "object"`, at most 128 KiB serialized, and
should only narrow what the registered schema accepts, since execution-side
validation still runs the registered parameters. Unknown or duplicate ids,
malformed output, an invalid override, more than 256 ids in either array, or a
throwing callback fail closed for that plugin only. Dynamic `instructions` are
truncated to 4096 characters.

Resolution happens for `thread.start` and `turn.submit`. A selected tool set
takes effect only when the provider session is next started/resumed; BB never
hot-mutates a running provider session. Instructions follow the same rule: a
live provider session keeps the instructions it was constructed with, and
changed instructions apply when the session is next constructed.
Skill catalog changes follow the daemon's established runtime policy. A busy
environment keeps its current staged catalog until a safe relaunch. Side chats
also evaluate `configure`; inspect `origin` to identify them. Returned tools,
skills, and dynamic instructions use the same boundaries. The legacy
`contributeInstructions` also runs for side chats, but its legacy context has
only `threadId` and `projectId`. Use `configure` when the contribution must
inspect the side-chat origin.

### bb.experimental_aiServices — helper inference and voice transcription

bb's own AI services — the server-side helper completions behind thread
titles and commit messages, and voice transcription — are served by plugins.
Register a service in `server.ts` and implement the shared contract in the
plugin's `bb.host` entry; the user selects it with `BB_INFERENCE` /
`BB_TRANSCRIPTION` set to `<id>/<model>` (`bb settings ai-services` lists
the options). The server reserves `openai` and every direct inference provider
id in its current provider registry. This includes `anthropic`, `google`,
`openrouter`, and their regional or gateway variants. Registration rejects
every reserved id. An id from another loaded plugin also fails your plugin
load:

```ts
// server.ts
bb.experimental_aiServices.register({
  id: "acme",
  displayName: "Acme AI",
  kinds: ["inference", "voice"],
});
```

```ts
// host.ts
import { experimental_aiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";

export default experimental_defineHostEntry({
  contract: experimental_aiServicesHostContract,
  handlers: {
    "ai.inference.complete": async (input) => {
      const value = await completeStructured(input);
      return { ok: true, model: input.model, value };
    },
    "ai.voice.transcribe": async (input) => {
      // input.audioBase64, input.mimeType, input.filename, input.prompt
      return { ok: true, model: input.model, text: await transcribe(input) };
    },
  },
});
```

Report failures in the result, not by throwing: `{ ok: false, code, message }`
with `code` one of `timeout`, `rate_limited`, `service_unavailable`,
`auth_required`, `request_failed`, `invalid_response`. Generic inference
retries the first three codes and then uses `BB_INFERENCE_FALLBACK`. Voice
retries the configured `BB_TRANSCRIPTION` model. Exhausted voice timeouts map
to `transcription_timeout`. Exhausted rate-limit or availability failures map
to `transcription_unavailable`. Every call carries `serviceId`, so one host
entry may serve several registered ids. The registration needs a `bb.host`
entry; without one the plugin fails to load. A host artifact may export a provider bridge
(`experimental_providerBridge`) and default-export the host entry at the same
time.

Inference input includes `serviceId`, `model`, `reasoningEffort: "none"`,
`prompt`, `outputSchema`, and `timeoutMs`. Plugin-served voice input has a
5 MiB limit. The server rejects a larger file before a host call. Voice input
includes `serviceId`, `model`, `audioBase64`, `mimeType`, `filename`, `prompt`,
and `timeoutMs`. The inference success value must be a JSON object. Voice
`prompt` can be `null`.
