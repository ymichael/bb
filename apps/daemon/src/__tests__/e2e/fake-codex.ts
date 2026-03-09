import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeCodexOptions {
  defaultTurnDelayMs?: number;
  defaultDuplicateTurnCompletion?: boolean;
  defaultItemCompletedText?: string;
}

const DEFAULT_FAKE_CODEX_OPTIONS: Required<FakeCodexOptions> = {
  defaultTurnDelayMs: 20,
  defaultDuplicateTurnCompletion: false,
  defaultItemCompletedText: "Fake agent output",
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

  const scriptDir = join(rootDir, ".beanbag-test");
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

  return `#!/usr/bin/env node
const { createInterface } = require("node:readline");

if (process.argv[2] !== "app-server") {
  process.stderr.write("fake codex only supports 'app-server'\\n");
  process.exit(1);
}

const defaultTurnDelayRaw = ${JSON.stringify(fallbackDelay)};
const defaultDuplicateRaw = ${JSON.stringify(fallbackDuplicate)};
const defaultItemText = ${fallbackText};

const parsedDelay = Number.parseInt(
  process.env.BEANBAG_FAKE_CODEX_TURN_DELAY_MS || defaultTurnDelayRaw,
  10,
);
const turnDelayMs = Number.isFinite(parsedDelay) ? parsedDelay : 0;
const duplicateTurnCompletion = (
  process.env.BEANBAG_FAKE_CODEX_DUPLICATE_COMPLETION || defaultDuplicateRaw
) === "1";
const scenarioRaw = String(process.env.BEANBAG_FAKE_CODEX_SCENARIO || "turn-complete")
  .trim()
  .toLowerCase();
// Open external test control: unknown scenario values intentionally use turn-complete behavior.
const scenario = scenarioRaw.length > 0 ? scenarioRaw : "turn-complete";

let nextThreadCounter = 1;
let nextTurnCounter = 1;

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
  return process.env.BEANBAG_FAKE_CODEX_ITEM_TEXT || defaultItemText;
}

function scheduleTurnLifecycle(threadId, input, turnId) {
  if (scenario === "manual") {
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
  process.exit(0);
});
`;
}
