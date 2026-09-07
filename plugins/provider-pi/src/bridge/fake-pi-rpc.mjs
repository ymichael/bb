#!/usr/bin/env node

/**
 * Scripted `pi --mode rpc` for hermetic pi-bridge tests: the subset of pi's
 * RPC dialect the bridge drives, with the REAL bb extension loaded the way
 * pi loads it. Commands in on stdin, responses and raw AgentSessionEvent
 * lines out on stdout, exactly pi's framing (LF-delimited JSON; U+2028 and
 * U+2029 stay raw inside strings, as pi writes them).
 *
 * - `--version` prints FAKE_PI_VERSION (default 0.84.0) and exits;
 *   FAKE_PI_VERSION=crash exits 1 with a version only on stderr.
 * - `--model <provider>/<id>` and `--thinking <level>` pin the session at
 *   spawn (an unknown model falls back to the default, as pi's CLI does
 *   with a diagnostic); `set_model` / `set_thinking_level` are answered but
 *   the bridge must never send them (they persist into the user's settings
 *   in real pi) — FAKE_PI_COMMAND_LOG records every command type.
 * - FAKE_PI_TOOLS_DUMP records every registered tool (name, description,
 *   parameters as JSON Schema) for the schema-conversion test.
 * - `--extension <path>` loads the module through a resolve hook that maps
 *   `@earendil-works/pi-coding-agent` and `typebox` onto this package's
 *   copies (pi's loader aliases them the same way), hands it a minimal
 *   extension API (registerTool, on, get/setActiveTools), and emits
 *   `session_start`, `agent_start`, `agent_end` to it in pi's order — the
 *   extension's `ready`, tool calls, `agent-end-leaf`, and fork replies all
 *   travel the real fd 3 / fd 4 channel.
 * - `--session <file>` is the `sessionFile` get_state reports; the file is
 *   created with pi's session header (the first entry real pi writes), so
 *   the bridge's fork precondition holds and a tip fork of the session
 *   reads a valid source the way it would from pi. `--no-session` runs
 *   without one.
 * - `get_state` / `get_available_models` / `get_session_stats`.
 * - `prompt`: the response is the preflight (sent before any event), then a
 *   scripted run: agent_start, turn_start, streamed assistant text, turn_end,
 *   agent_end. `/tool <name> <json>` runs the named extension tool first
 *   (tool_execution_start/end). A prompt while a run is live is queued and
 *   surfaces through `queue_update`, the way pi's follow-up queue does; it
 *   runs after the live run ends. `/hold` opens a run that never ends until
 *   `abort`; `/fail-run` ends the run with an assistant error.
 * - `abort`: ends a live run with stopReason "aborted".
 * - `--version` prints FAKE_PI_VERSION (default 0.84.0) and exits.
 * - `compact`: compaction_start/end {reason: "manual"}; before any turn ran
 *   it refuses like pi does for a too-small session (compaction_end with
 *   `errorMessage`, then a failed response).
 * - stdin EOF exits the process; SIGTERM exits. FAKE_PI_PROCESS_LOG gets
 *   `spawn:<pid>:<ppid>` and `exit:<pid>:<ppid>` lines (the lifecycle tests
 *   read it); FAKE_PI_HANG_ON_CLOSE=1 makes the fake ignore stdin EOF and
 *   SIGTERM so the bridge's SIGKILL escalation can be observed.
 * - Fault knobs for the bridge's own tests: FAKE_PI_SPAWN_COUNTER_FILE counts
 *   spawns across processes and FAKE_PI_MISMATCH_FIRST_SPAWN=1 makes only the
 *   first spawn ignore `--model` (a transient model mismatch);
 *   FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE=1 exits after recording the spawn but
 *   before importing the extension or reading a command;
 *   FAKE_PI_NO_SESSION_START=1 never emits session_start to the extension (so
 *   no `ready`); FAKE_PI_DROP_STEER_AT_END=1 ends a run with a queued steer
 *   still queued; FAKE_PI_STREAMING_AFTER_END=1 reports isStreaming after a
 *   run ended (a continuation pi is still finishing);
 *   FAKE_PI_BATCH_STEER_REPLY=1 writes a steer's `prompt` response and the
 *   resumed run's first event in one stdout write (one read on the bridge's
 *   side). The prompt `/die` exits the process mid-run without answering.
 * - `prompt` with `streamingBehavior: "steer"` during a `/hold` run is queued
 *   (`queue_update.steering`), consumed when the run resumes, and the run's
 *   reply names it.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
// `pi --version`, answered the way the real CLI does (the bridge's install
// gate runs it through the same launch); FAKE_PI_VERSION picks the version.
// FAKE_PI_VERSION=crash: the way a broken install answers — a stack trace
// on stderr that happens to name a supported version, exit 1, nothing on
// stdout. FAKE_PI_PROCESS_LOG records each `--version` spawn as `version:`.
if (args.includes("--version")) {
  if (process.env.FAKE_PI_PROCESS_LOG) {
    try {
      appendFileSync(process.env.FAKE_PI_PROCESS_LOG, `version:${process.pid}:${process.ppid}\n`);
    } catch {
      // The test's directory is already gone; nothing to record.
    }
  }
  if (process.env.FAKE_PI_VERSION === "crash") {
    process.stderr.write("Error: pi 0.84.0 failed to start\n    at main (pi.js:1:1)\n");
    process.exit(1);
  }
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? "0.84.0"}\n`);
  process.exit(0);
}
function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
const sessionFile = args.includes("--no-session") ? undefined : flag("--session");
const extensionPath = flag("--extension");
const processLogPath = process.env.FAKE_PI_PROCESS_LOG;
const commandLogPath = process.env.FAKE_PI_COMMAND_LOG;
if (sessionFile !== undefined) {
  mkdirSync(dirname(sessionFile), { recursive: true });
  if (!existsSync(sessionFile)) {
    // The header pi's SessionManager writes (CURRENT_SESSION_VERSION 3, a
    // UUID id), hand-written so the fake answers get_state without first
    // loading the pi package: the bridge's readiness gate is timed.
    const header = {
      type: "session",
      version: 3,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, "utf8");
  }
}

function logProcessStep(step) {
  if (!processLogPath) return;
  try {
    appendFileSync(processLogPath, `${step}:${process.pid}:${process.ppid}\n`);
  } catch {
    // The test's directory is already gone; nothing to record.
  }
}
logProcessStep("spawn");
let exiting = false;
function exit() {
  if (exiting) return;
  exiting = true;
  logProcessStep("exit");
  process.exit(0);
}
// FAKE_PI_HANG_ON_CLOSE=1: a wedged pi that ignores stdin EOF and SIGTERM,
// so only the bridge's SIGKILL escalation ends it.
const hangOnClose = process.env.FAKE_PI_HANG_ON_CLOSE === "1";
process.on("SIGTERM", () => {
  if (hangOnClose) return;
  exit();
});
if (process.env.FAKE_PI_EXIT_BEFORE_FIRST_RESPONSE === "1") {
  exit();
}

const MODELS = [
  {
    id: "fake-model",
    name: "Fake Model",
    provider: "fake-provider",
    input: ["text"],
    reasoning: true,
    contextWindow: 200_000,
  },
  {
    id: "fake-mini",
    name: "Fake Mini",
    provider: "fake-provider",
    input: ["text"],
    reasoning: false,
    contextWindow: 32_000,
  },
];

let model = MODELS[0];
const requestedModel = flag("--model");
let spawnIndex = 1;
if (process.env.FAKE_PI_SPAWN_COUNTER_FILE) {
  try {
    spawnIndex = Number(readFileSync(process.env.FAKE_PI_SPAWN_COUNTER_FILE, "utf8")) + 1;
  } catch {
    spawnIndex = 1;
  }
  writeFileSync(process.env.FAKE_PI_SPAWN_COUNTER_FILE, String(spawnIndex), "utf8");
}
const ignoreRequestedModel =
  process.env.FAKE_PI_MISMATCH_FIRST_SPAWN === "1" && spawnIndex === 1;
if (requestedModel !== undefined && !ignoreRequestedModel) {
  const [provider, id] = requestedModel.split("/");
  model = MODELS.find((entry) => entry.provider === provider && entry.id === id) ?? MODELS[0];
}
let thinkingLevel = flag("--thinking") ?? "medium";
let isStreaming = false;
let isCompacting = false;
let leafCounter = 0;
let leafId = null;
let turnCounter = 0;
let tokens = 0;
let holdAbort = null;
/** Follow-up queue: prompts that arrived while a run was live. */
const followUp = [];
/** Steering queue: steers that arrived while a run was live. */
const steering = [];
let endedWithStreamingFlag = false;

/** A line held back to go out in one write with the next one. */
let heldLine = null;

function send(message) {
  const line = `${JSON.stringify(message)}\n`;
  if (heldLine === null) {
    process.stdout.write(line);
    return;
  }
  // One write, so the bridge reads both lines in one chunk.
  process.stdout.write(`${heldLine}${line}`);
  heldLine = null;
}
function holdUntilNextSend(message) {
  heldLine = `${JSON.stringify(message)}\n`;
}
function respond(id, command, data) {
  send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}
function respondError(id, command, error) {
  send({ id, type: "response", command, success: false, error });
}
function event(payload) {
  // Pi writes each AgentSessionEvent unwrapped on its own line.
  send(payload);
}
function queueUpdate() {
  event({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the extension, loaded like pi loads it ----

const extensionTools = new Map();
const extensionHandlers = new Map();
let activeTools = ["read", "bash", "edit", "write"];
const scopedModel =
  process.env.FAKE_PI_SCOPE_BY_SPAWN === "1"
    ? MODELS[spawnIndex === 1 ? 0 : 1]
    : undefined;
const extensionContext = {
  cwd: process.cwd(),
  sessionManager: { getLeafId: () => leafId },
  model: scopedModel,
  scopedModels: scopedModel ? [{ model: scopedModel }] : [],
};

async function emitExtensionEvent(type, payload = {}) {
  for (const handler of extensionHandlers.get(type) ?? []) {
    await handler({ type, ...payload }, extensionContext);
  }
}

async function loadExtension(path) {
  const aliases = new Map([
    ["@earendil-works/pi-coding-agent", import.meta.resolve("@earendil-works/pi-coding-agent")],
    ["typebox", import.meta.resolve("typebox")],
  ]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = aliases.get(specifier);
      return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
    },
  });
  const module = await import(pathToFileURL(path).href);
  module.default({
    registerTool(tool) {
      extensionTools.set(tool.name, tool);
      if (process.env.FAKE_PI_TOOLS_DUMP) {
        // TypeBox schemas are plain JSON Schema objects: what pi's model sees.
        appendFileSync(
          process.env.FAKE_PI_TOOLS_DUMP,
          `${JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })}\n`,
        );
      }
    },
    on(type, handler) {
      const handlers = extensionHandlers.get(type) ?? [];
      handlers.push(handler);
      extensionHandlers.set(type, handlers);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names) {
      activeTools = [...names];
    },
  });
  if (process.env.FAKE_PI_NO_SESSION_START !== "1") {
    await emitExtensionEvent("session_start");
  }
}

async function runExtensionTool(name, toolArgs) {
  const tool = extensionTools.get(name);
  const toolCallId = `call-${turnCounter}`;
  event({ type: "tool_execution_start", toolCallId, toolName: name, args: toolArgs });
  let result;
  let isError = false;
  try {
    result = tool
      ? await tool.execute(toolCallId, toolArgs, new AbortController().signal)
      : { content: [{ type: "text", text: `no tool ${name}` }], details: {} };
  } catch (error) {
    isError = true;
    result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
  event({ type: "tool_execution_end", toolCallId, toolName: name, result, isError });
  return result;
}

async function runPrompt(text) {
  isStreaming = true;
  turnCounter += 1;
  await emitExtensionEvent("agent_start");
  event({ type: "agent_start" });
  event({ type: "turn_start" });
  if (text === "/hold") {
    // Open until abort, or until a steer arrives (the steer is consumed by
    // this run and named in its reply, like pi's one-at-a-time steering).
    const released = await new Promise((resolve) => {
      holdAbort = resolve;
    });
    holdAbort = null;
    if (released === "steer") {
      const steerText = process.env.FAKE_PI_DROP_STEER_AT_END === "1" ? null : steering.shift();
      if (steerText !== null && steerText !== undefined) {
        queueUpdate();
      }
      const reply = steerText === null || steerText === undefined ? "Held run ended" : `Steered: ${steerText}`;
      const steered = {
        role: "assistant",
        content: [{ type: "text", text: reply }],
        stopReason: "stop",
        provider: model.provider,
        model: model.id,
        usage: { input: 12, output: 5, totalTokens: 17 },
      };
      event({ type: "message_start", message: { role: "assistant", content: [] } });
      event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply, contentIndex: 0 }, message: steered });
      event({ type: "message_end", message: steered });
      event({ type: "turn_end", message: steered, toolResults: [] });
      leafCounter += 1;
      leafId = `leaf-${leafCounter}`;
      const messages = [{ role: "user", content: text }, steered];
      await emitExtensionEvent("agent_end", { messages });
      endedWithStreamingFlag = process.env.FAKE_PI_STREAMING_AFTER_END === "1";
      event({ type: "agent_end", messages });
      isStreaming = endedWithStreamingFlag;
      return;
    }
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "aborted",
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 0, totalTokens: 1 },
    };
    event({ type: "turn_end", message, toolResults: [] });
    await emitExtensionEvent("agent_end", { messages: [message] });
    event({ type: "agent_end", messages: [message] });
    isStreaming = false;
    return;
  }
  if (text === "/die") {
    // Mid-run death without an answer: the bridge's next write hits EPIPE.
    process.exit(0);
  }
  let toolResultText = "";
  const toolMatch = text.match(/^\/tool (\S+) ?(.*)$/su);
  if (toolMatch) {
    let toolArgs = {};
    try {
      toolArgs = toolMatch[2] ? JSON.parse(toolMatch[2]) : {};
    } catch {
      toolArgs = { raw: toolMatch[2] };
    }
    const result = await runExtensionTool(toolMatch[1], toolArgs);
    toolResultText = (result?.content ?? [])
      .filter((block) => block && block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  const failed = text === "/fail-run";
  const reply = failed ? "" : toolMatch ? `Tool said: ${toolResultText}` : `Response to: ${text}`;
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: reply }],
    provider: model.provider,
    model: model.id,
    usage: { input: 12, output: 5, totalTokens: 17 },
    ...(failed
      ? { stopReason: "error", errorMessage: "scripted run failure" }
      : { stopReason: "stop" }),
  };
  event({ type: "message_start", message: { role: "assistant", content: [] } });
  if (!failed) {
    event({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: reply, contentIndex: 0 },
      message: assistant,
    });
  }
  event({ type: "message_end", message: assistant });
  event({ type: "turn_end", message: assistant, toolResults: [] });
  tokens += 17;
  leafCounter += 1;
  leafId = `leaf-${leafCounter}`;
  const messages = [{ role: "user", content: text }, assistant];
  // Extensions see agent_end first (they read the leaf in-process); the RPC
  // stream gets it after, exactly pi's order.
  await emitExtensionEvent("agent_end", { messages });
  event({ type: "agent_end", messages });
  isStreaming = false;
}

async function drainFollowUps() {
  while (followUp.length > 0) {
    const text = followUp.shift();
    queueUpdate();
    await runPrompt(text);
  }
}

async function handle(command) {
  const id = command.id;
  if (commandLogPath) {
    appendFileSync(commandLogPath, `${command.type}\n`);
  }
  switch (command.type) {
    case "get_state":
      respond(id, "get_state", {
        model,
        thinkingLevel,
        isStreaming,
        isCompacting,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        sessionFile,
        sessionId: "fake-session",
        autoCompactionEnabled: true,
        messageCount: turnCounter * 2,
        pendingMessageCount: followUp.length,
      });
      return;
    case "get_available_models":
      respond(id, "get_available_models", { models: MODELS });
      if (
        process.env.FAKE_PI_EXIT_AFTER_FIRST_AVAILABLE === "1" &&
        spawnIndex === 1
      ) {
        setTimeout(exit, 25);
      }
      return;
    case "set_model": {
      const found = MODELS.find(
        (entry) => entry.provider === command.provider && entry.id === command.modelId,
      );
      if (!found) {
        respondError(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
        return;
      }
      model = found;
      respond(id, "set_model", model);
      return;
    }
    case "set_thinking_level":
      thinkingLevel = command.level;
      respond(id, "set_thinking_level");
      return;
    case "get_session_stats":
      respond(id, "get_session_stats", {
        sessionFile,
        sessionId: "fake-session",
        userMessages: turnCounter,
        assistantMessages: turnCounter,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: turnCounter * 2,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        contextUsage: { tokens, contextWindow: model.contextWindow, percent: 0 },
      });
      return;
    case "prompt": {
      if (isStreaming && command.streamingBehavior === "steer") {
        // A steer into a live run: pi reports the queue BEFORE it answers the
        // preflight (recorded order), then hands it to the run (a held run
        // resumes on it) — or leaves it queued when the run is told to drop
        // it at its end.
        steering.push(command.message);
        queueUpdate();
        if (process.env.FAKE_PI_BATCH_STEER_REPLY === "1" && holdAbort) {
          // The response goes out with the resumed run's first event.
          holdUntilNextSend({ id, type: "response", command: "prompt", success: true });
        } else {
          respond(id, "prompt");
        }
        if (holdAbort) {
          holdAbort("steer");
        }
        return;
      }
      if (isStreaming) {
        // Queued: pi reports the queue, then answers the preflight; the run
        // picks it up after the live run ends.
        followUp.push(command.message);
        queueUpdate();
        respond(id, "prompt");
        return;
      }
      respond(id, "prompt");
      await runPrompt(command.message);
      await drainFollowUps();
      return;
    }
    case "steer":
      respond(id, "steer");
      return;
    case "abort":
      if (holdAbort) {
        holdAbort("abort");
        await sleep(5);
      }
      isStreaming = false;
      endedWithStreamingFlag = false;
      respond(id, "abort");
      return;
    case "compact": {
      isCompacting = true;
      event({ type: "compaction_start", reason: "manual" });
      await sleep(5);
      if (turnCounter === 0) {
        const errorMessage = "Compaction failed: Nothing to compact (session too small)";
        event({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage });
        isCompacting = false;
        respondError(id, "compact", "Nothing to compact (session too small)");
        return;
      }
      event({ type: "compaction_end", reason: "manual", aborted: false });
      isCompacting = false;
      leafCounter += 1;
      leafId = `leaf-${leafCounter}`;
      respond(id, "compact", { summary: "scripted summary", tokensBefore: tokens, firstKeptEntryId: leafId });
      return;
    }
    default:
      respondError(id, command.type, `Unknown command "${command.type}"`);
  }
}

// Newline-only framing, like pi's own jsonl reader.
function readLines(input, onLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  input.on("data", (chunk) => {
    const text = decoder.write(chunk);
    let start = 0;
    for (;;) {
      const index = text.indexOf("\n", start);
      if (index === -1) {
        pending += text.slice(start);
        return;
      }
      const line = pending + text.slice(start, index);
      pending = "";
      start = index + 1;
      onLine(line);
    }
  });
}

const loaded = extensionPath ? loadExtension(extensionPath) : Promise.resolve();
let chain = loaded;
readLines(process.stdin, (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let command;
  try {
    command = JSON.parse(trimmed);
  } catch {
    return;
  }
  // Commands are handled in order, but `prompt` runs its scripted turn
  // asynchronously so `abort` — and a steer into a held run — can reach it.
  if (
    command.type === "abort" ||
    command.type === "get_state" ||
    command.type === "get_session_stats" ||
    (command.type === "prompt" && command.streamingBehavior === "steer")
  ) {
    void loaded.then(() => handle(command));
    return;
  }
  chain = chain.then(() => handle(command));
});
process.stdin.on("end", () => {
  if (!hangOnClose) exit();
});
process.stdin.on("close", () => {
  if (!hangOnClose) exit();
});
if (hangOnClose) {
  setInterval(() => undefined, 60_000);
}
