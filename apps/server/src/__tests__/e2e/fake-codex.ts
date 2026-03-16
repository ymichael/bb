import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeCodexScenario =
  | "turn-complete"
  | "turn-complete-no-start"
  | "turn-complete-no-item"
  | "turn-start-only"
  | "manual"
  | "start-then-manual-complete";

export interface FakeCodexOptions {
  defaultTurnDelayMs?: number;
  defaultDuplicateTurnCompletion?: boolean;
  defaultItemCompletedText?: string;
  defaultScenario?: FakeCodexScenario;
}

const DEFAULT_FAKE_CODEX_OPTIONS: Required<FakeCodexOptions> = {
  defaultTurnDelayMs: 20,
  defaultDuplicateTurnCompletion: false,
  defaultItemCompletedText: "Fake agent output",
  defaultScenario: "turn-complete",
};

export function createFakeCodexBinDir(
  tempRoot: string,
  opts?: FakeCodexOptions,
): string {
  const settings: Required<FakeCodexOptions> = {
    ...DEFAULT_FAKE_CODEX_OPTIONS,
    ...opts,
  };

  const binDir = join(tempRoot, "fake-codex-bin");
  const codexPath = join(binDir, "codex");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(codexPath, buildFakeCodexScript(settings), "utf-8");
  chmodSync(codexPath, 0o755);
  return binDir;
}

export function createFakeCodexScriptFile(
  rootDir: string,
  opts?: FakeCodexOptions,
): string {
  const settings: Required<FakeCodexOptions> = {
    ...DEFAULT_FAKE_CODEX_OPTIONS,
    ...opts,
  };

  const scriptDir = join(rootDir, ".bb-test");
  const scriptPath = join(scriptDir, "fake-codex.cjs");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(scriptPath, buildFakeCodexScript(settings), "utf-8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function buildFakeCodexScript(settings: Required<FakeCodexOptions>): string {
  const fallbackDelay = String(settings.defaultTurnDelayMs);
  const fallbackDuplicate = settings.defaultDuplicateTurnCompletion ? "1" : "0";
  const fallbackText = JSON.stringify(settings.defaultItemCompletedText);
  const fallbackScenario = JSON.stringify(settings.defaultScenario);

  return `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

if (process.argv[2] !== "app-server") {
  process.stderr.write("fake codex only supports 'app-server'\\n");
  process.exit(1);
}

const defaultTurnDelayRaw = ${JSON.stringify(fallbackDelay)};
const defaultDuplicateRaw = ${JSON.stringify(fallbackDuplicate)};
const defaultItemText = ${fallbackText};
const defaultScenarioRaw = ${fallbackScenario};

const parsedDelay = Number.parseInt(
  process.env.BB_FAKE_CODEX_TURN_DELAY_MS || defaultTurnDelayRaw,
  10,
);
const turnDelayMs = Number.isFinite(parsedDelay) ? parsedDelay : 0;
const duplicateTurnCompletion = (
  process.env.BB_FAKE_CODEX_DUPLICATE_COMPLETION || defaultDuplicateRaw
) === "1";
const scenarioRaw = String(process.env.BB_FAKE_CODEX_SCENARIO || defaultScenarioRaw)
  .trim()
  .toLowerCase();
// Open external test control: unknown scenario values intentionally use turn-complete behavior.
const scenario = scenarioRaw.length > 0 ? scenarioRaw : "turn-complete";
const controlFilePath = String(process.env.BB_FAKE_CODEX_CONTROL_FILE || "").trim();

const stateFilePath = join(dirname(process.argv[1]), ".fake-codex-state.json");

function readState() {
  try {
    if (!existsSync(stateFilePath)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(stateFilePath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const nextThreadCounter =
      Number.isInteger(parsed.nextThreadCounter) && parsed.nextThreadCounter > 0
        ? parsed.nextThreadCounter
        : 1;
    const nextTurnCounter =
      Number.isInteger(parsed.nextTurnCounter) && parsed.nextTurnCounter > 0
        ? parsed.nextTurnCounter
        : 1;
    return { nextThreadCounter, nextTurnCounter };
  } catch {
    return null;
  }
}

function writeState() {
  try {
    writeFileSync(
      stateFilePath,
      JSON.stringify({ nextThreadCounter, nextTurnCounter }),
      "utf8",
    );
  } catch {
    // Best-effort only for fake e2e state.
  }
}

const persistedState = readState();
let nextThreadCounter = persistedState?.nextThreadCounter ?? 1;
let nextTurnCounter = persistedState?.nextTurnCounter ?? 1;
let controlFileOffset = 0;
const queuedLifecycleSteps = [];
let controlWatcher = null;

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function reply(id, result) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  send({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function notify(method, params) {
  send({
    jsonrpc: "2.0",
    method,
    params,
  });
}

function resolveThreadId(params) {
  if (typeof params.threadId === "string" && params.threadId.length > 0) {
    return params.threadId;
  }
  const id = "fake-thread-" + nextThreadCounter;
  nextThreadCounter += 1;
  writeState();
  return id;
}

function resolveTextInput(input) {
  if (!Array.isArray(input)) return "";
  const parts = [];
  for (const entry of input) {
    const chunk = asObject(entry);
    if (!chunk) continue;
    if (chunk.type !== "text") continue;
    if (typeof chunk.text !== "string") continue;
    const value = chunk.text.trim();
    if (value.length > 0) parts.push(value);
  }
  return parts.join(" ");
}

function resolveCompletionText(input) {
  const text = resolveTextInput(input);
  if (text.includes("Return ONLY a JSON object")) {
    return JSON.stringify({
      title: "Fake Metadata Title",
      worktreeName: "test/fake-metadata-title",
    });
  }
  return process.env.BB_FAKE_CODEX_ITEM_TEXT || defaultItemText;
}

function queueLifecycleStep(step) {
  queuedLifecycleSteps.push(step);
}

function flushNextLifecycleStep() {
  const step = queuedLifecycleSteps.shift();
  if (typeof step === "function") {
    step();
  }
}

function readControlCommands() {
  if (!controlFilePath) return;

  let content = "";
  try {
    content = readFileSync(controlFilePath, "utf8");
  } catch {
    return;
  }

  if (content.length < controlFileOffset) {
    controlFileOffset = 0;
  }
  if (content.length === controlFileOffset) {
    return;
  }

  const appended = content.slice(controlFileOffset);
  controlFileOffset = content.length;
  for (const rawLine of appended.split(/\\r?\\n/)) {
    const command = rawLine.trim().toLowerCase();
    if (!command) continue;
    if (command === "emit-next-event") {
      flushNextLifecycleStep();
    }
  }
}

function initializeControlWatcher() {
  if (!controlFilePath) return;

  mkdirSync(dirname(controlFilePath), { recursive: true });
  writeFileSync(controlFilePath, "", { encoding: "utf8", flag: "a" });
  controlFileOffset = statSync(controlFilePath).size;
  controlWatcher = watch(controlFilePath, { persistent: false }, () => {
    readControlCommands();
  });
  controlWatcher.on("error", () => {});
}

function scheduleTurnLifecycle(threadId, input, turnId) {
  if (scenario === "manual") {
    queueLifecycleStep(() => {
      notify("turn/started", { threadId, turnId });
    });
    queueLifecycleStep(() => {
      notify("item/completed", {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          text: resolveCompletionText(input),
        },
      });
      notify("turn/completed", { threadId, turnId });
      if (duplicateTurnCompletion) {
        notify("turn/completed", { threadId, turnId });
      }
    });
    return;
  }

  const turnStartedPayload = { threadId, turnId };
  const turnCompletedPayload = { threadId, turnId };
  const itemCompletedPayload = {
    threadId,
    turnId,
    item: {
      type: "agentMessage",
      text: resolveCompletionText(input),
    },
  };

  setTimeout(() => {
    if (scenario !== "turn-complete-no-start") {
      notify("turn/started", turnStartedPayload);
    }
  }, turnDelayMs);

  if (scenario === "start-then-manual-complete") {
    queueLifecycleStep(() => {
      notify("item/completed", itemCompletedPayload);
      notify("turn/completed", turnCompletedPayload);
      if (duplicateTurnCompletion) {
        notify("turn/completed", turnCompletedPayload);
      }
    });
    return;
  }

  setTimeout(() => {
    if (scenario !== "turn-complete-no-item") {
      notify("item/completed", itemCompletedPayload);
    }
    if (scenario === "turn-start-only") {
      return;
    }
    notify("turn/completed", turnCompletedPayload);
    if (duplicateTurnCompletion) {
      setTimeout(() => {
        notify("turn/completed", turnCompletedPayload);
      }, 1);
    }
  }, turnDelayMs + 5);
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
initializeControlWatcher();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const msg = asObject(parsed);
  if (!msg) return;

  const method = typeof msg.method === "string" ? msg.method : undefined;
  if (!method) return;

  const params = asObject(msg.params) || {};
  const id = Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;

  switch (method) {
    case "initialize":
      reply(id, { capabilities: {} });
      break;
    case "thread/start": {
      const threadId = resolveThreadId(params);
      reply(id, { threadId });
      notify("thread/started", {
        threadId,
        thread: {
          id: threadId,
          preview: "Fake thread preview",
        },
      });
      break;
    }
    case "thread/resume": {
      const threadId = resolveThreadId(params);
      reply(id, { threadId });
      break;
    }
    case "thread/name/set":
      reply(id, { ok: true });
      break;
    case "thread/archive":
      reply(id, { ok: true });
      break;
    case "turn/start":
    case "turn/steer": {
      const threadId = resolveThreadId(params);
      const turnId = "fake-turn-" + nextTurnCounter;
      nextTurnCounter += 1;
      writeState();
      reply(id, { threadId, turnId });
      scheduleTurnLifecycle(threadId, params.input, turnId);
      break;
    }
    default:
      replyError(id, -32601, "Method not found: " + method);
      break;
  }
});

rl.on("close", () => {
  controlWatcher?.close?.();
  process.exit(0);
});
`;
}
