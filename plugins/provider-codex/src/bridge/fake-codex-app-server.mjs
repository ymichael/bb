#!/usr/bin/env node

/**
 * Minimal scripted `codex app-server` for hermetic codex-bridge tests.
 *
 * Speaks the subset of the app-server dialect the bridge drives: initialize,
 * thread/start|resume|fork returning a thread identity (plus the
 * thread/started notification a real app-server emits), and turn/start
 * answering with a full scripted turn. The scripted turn is deliberately
 * DELTA-FIRST — `item/agentMessage/delta` arrives before any `item/started`
 * for that item — so the bridge's item-opening synthesis is exercised for
 * real by the conformance kit's item/opens-before-delta rule.
 *
 * An optional argv[2] script file replaces that hardcoded turn:
 * `{ "turns": [[{ "method", "params" }, …], …] }`, where the Nth accepted
 * `turn/start` emits the Nth turn's notifications verbatim. It exists so the
 * dual-path calibration suite can drive this process and the legacy adapter
 * from ONE script. An entry marked `"kind": "request"` is sent as a JSON-RPC
 * *request* toward the client (an approval) and blocks the rest of the turn
 * until the client answers, exactly as a real app-server does. Every
 * `threadId` in the script is rewritten to the thread id this process minted,
 * because only this process knows it. Without the argument the hardcoded
 * behavior below is unchanged.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";

let threadCounter = 0;
let turnCounter = 0;
const openTurnIdsByThreadId = new Map();
const processInstanceId = `${process.pid}-${Date.now()}-${Math.random()}`;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** The prompt the kit's turn/settles-without-activity scenario sends. */
const ZERO_WORK_PROMPT_TEXT = "/clear";

/**
 * A prompt answered BEFORE any turn notification, whose real turn then arrives
 * late. Codex normally emits `turn/started` ahead of its `turn/start`
 * response; this inverts that order so the bridge's zero-work settlement has
 * to lose the race to the real turn (fabricating a turn from a late signal is
 * the ACP bug 0c2f4cc9a).
 */
const LATE_TURN_START_PROMPT_TEXT = "/late-start";
const LATE_TURN_START_DELAY_MS = 60;

/** A prompt that stays open until the client sends turn/interrupt. */
const INTERRUPTIBLE_PROMPT_TEXT = "/wait-for-interrupt";

/**
 * A prompt that spawns a native subagent (open thread work) and then dies with
 * the subagent still running — the crash/OOM shape. The bridge has to settle
 * the open turn AND retract the open-work claim, or the runtime never reaps
 * the thread.
 */
const SUBAGENT_THEN_CRASH_PROMPT_TEXT = "/subagent-then-crash";

function firstInputText(input) {
  const first = Array.isArray(input) ? input[0] : undefined;
  return first && first.type === "text" ? first.text : undefined;
}

const FIXED_TOKEN_USAGE = {
  total: {
    totalTokens: 39970,
    inputTokens: 39960,
    cachedInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 0,
  },
  last: {
    totalTokens: 19993,
    inputTokens: 19988,
    cachedInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0,
  },
  modelContextWindow: 258400,
};

function runScriptedTurn(threadId) {
  turnCounter += 1;
  const turnId = `turn-fx-${turnCounter}`;
  const itemId = `item-fx-${turnCounter}`;
  const text = `hello from codex turn ${turnCounter}`;
  openTurnIdsByThreadId.set(threadId, turnId);

  notify("turn/started", {
    threadId,
    turn: { id: turnId, status: "inProgress" },
  });
  // Delta-first: no item/started for the agent message. The bridge must
  // synthesize the opening event.
  notify("item/agentMessage/delta", { threadId, turnId, itemId, delta: text });
  notify("item/completed", {
    threadId,
    turnId,
    item: { type: "agentMessage", id: itemId, text },
  });
  if (String(threadId).startsWith("usage-replay-")) {
    // Usage-replay threads also report the turn's own usage, like the real
    // app-server, so tests can tell a replay from live turn usage (#1727).
    notify("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: FIXED_TOKEN_USAGE,
    });
  }
  notify("turn/completed", {
    threadId,
    turn: { id: turnId, status: "completed" },
  });
  openTurnIdsByThreadId.delete(threadId);
}

// argv, not an env var: the bridge builds its child's environment from an
// allowlist, so an env var set by a test never reaches this process.
const scriptPath = process.argv[2];
const script = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : null;
const scriptedTurns = script?.turns ?? null;
const requestLogPath = script?.requestLogPath ?? null;
const modelListFailOnceMarkerPath = script?.modelListFailOnceMarkerPath ?? null;
/**
 * `archiveStatePath`: a JSON file of archived thread ids shared by every fake
 * child the bridge spawns from one script. The real app-server keeps archive
 * state on disk (the rollout moves to an archived dir), so an archive seen by
 * one child must refuse a resume in the next — the bridge kills a thread's
 * child on archive and resumes on a fresh one.
 */
const archiveStatePath = script?.archiveStatePath ?? null;
/**
 * `renameEmptyRolloutFailures`: how many `thread/name/set` calls fail with the
 * real app-server's "rollout … is empty" error before one succeeds — the
 * window between a rollout file's creation and its first record.
 */
let renameEmptyRolloutFailuresLeft = script?.renameEmptyRolloutFailures ?? 0;
const archivedThreadIds = new Set();
/**
 * `processLogPath`: one line per child lifecycle step (`spawn:<pid>:<ppid>`,
 * `exit:<pid>:<ppid>`), so a test can count how many app-server children the
 * bridge runs, how many bridge processes spawned them (distinct ppids), and
 * see the children die on release, archive, and bridge shutdown.
 */
const processLogPath = script?.processLogPath ?? null;
/** `startDelayMs`: answer `thread/start` only after this many milliseconds. */
const startDelayMs = script?.startDelayMs ?? 0;
const sigtermDelayMs = script?.sigtermDelayMs ?? 0;

function logProcessStep(step) {
  if (processLogPath === null) {
    return;
  }
  appendFileSync(processLogPath, `${step}:${process.pid}:${process.ppid}\n`);
}

logProcessStep("spawn");
function exitCleanly() {
  logProcessStep("exit");
  process.exit(0);
}

process.on("SIGTERM", () => {
  if (sigtermDelayMs > 0) {
    setTimeout(exitCleanly, sigtermDelayMs);
    return;
  }
  exitCleanly();
});
let scriptedTurnIndex = 0;

function readArchivedThreadIds() {
  if (archiveStatePath === null) {
    return archivedThreadIds;
  }
  if (!existsSync(archiveStatePath)) {
    return new Set();
  }
  return new Set(JSON.parse(readFileSync(archiveStatePath, "utf8")));
}

function setThreadArchived(threadId, archived) {
  const ids = readArchivedThreadIds();
  if (archived) {
    ids.add(threadId);
  } else {
    ids.delete(threadId);
  }
  if (archiveStatePath === null) {
    return;
  }
  writeFileSync(archiveStatePath, JSON.stringify([...ids]));
}

function isThreadArchived(threadId) {
  return readArchivedThreadIds().has(threadId);
}

function shouldFailThisModelList() {
  if (modelListFailOnceMarkerPath === null) {
    return false;
  }
  try {
    closeSync(openSync(modelListFailOnceMarkerPath, "wx"));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

/** Rewrite every `threadId` to the id this process minted for the session. */
function withThreadId(value, threadId) {
  if (Array.isArray(value)) {
    return value.map((entry) => withThreadId(entry, threadId));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const rewritten = {};
  for (const [key, entry] of Object.entries(value)) {
    rewritten[key] =
      key === "threadId" && typeof entry === "string"
        ? threadId
        : withThreadId(entry, threadId);
  }
  return rewritten;
}

/**
 * Requests this process originates toward its client (approvals). A real
 * app-server blocks the turn until the client answers, so the scripted turn
 * does too — an entry marked `"kind": "request"` is sent as a JSON-RPC request
 * rather than a notification.
 */
let outboundRequestCounter = 0;
const pendingOutboundRequests = new Map();

function requestFromClient(method, params) {
  outboundRequestCounter += 1;
  const id = `fx-req-${outboundRequestCounter}`;
  return new Promise((resolve) => {
    pendingOutboundRequests.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

/**
 * `turnCursorPath`: persists the scripted-turn cursor across child processes,
 * so a script whose Nth turn must run on a REBUILT child (the bridge replaces
 * a thread's app-server after a terminal account error) keeps counting where
 * the previous child stopped.
 */
const turnCursorPath = script?.turnCursorPath ?? null;

function takeScriptedTurnIndex() {
  if (turnCursorPath === null) {
    const index = scriptedTurnIndex;
    scriptedTurnIndex += 1;
    return index;
  }
  const index = existsSync(turnCursorPath)
    ? Number(readFileSync(turnCursorPath, "utf8"))
    : 0;
  writeFileSync(turnCursorPath, String(index + 1));
  return index;
}

async function runScriptFileTurn(threadId) {
  const turn = scriptedTurns[takeScriptedTurnIndex()] ?? [];
  for (const entry of turn) {
    const params = withThreadId(entry.params ?? {}, threadId);
    if (entry.kind === "request") {
      await requestFromClient(entry.method, params);
      continue;
    }
    if (entry.method === "turn/started") {
      openTurnIdsByThreadId.set(threadId, params.turn.id);
    }
    if (entry.method === "turn/completed") {
      openTurnIdsByThreadId.delete(threadId);
    }
    notify(entry.method, params);
  }
}

function replayLastTurnUsage(threadId) {
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId: "turn-fx-1",
    tokenUsage: FIXED_TOKEN_USAGE,
  });
}

async function handleRequest(message) {
  const { id, method } = message;
  const params = message.params ?? {};
  if (requestLogPath !== null) {
    appendFileSync(requestLogPath, `${JSON.stringify({ method, params })}\n`);
  }
  switch (method) {
    case "initialize":
      respond(id, {});
      return;
    case "account/rateLimits/read":
      respond(id, { rateLimits: {} });
      return;
    case "model/list":
      if (shouldFailThisModelList()) {
        respond(id, { data: [] });
        return;
      }
      respond(id, {
        data: [
          {
            id: `fake-model-${processInstanceId}`,
            model: `fake-model-${processInstanceId}`,
            displayName: "Fake model",
            description: "Hermetic bridge fixture model",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Medium" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: true,
          },
        ],
      });
      return;
    case "skills/extraRoots/set":
      respond(id, {});
      return;
    case "thread/start": {
      if (startDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, startDelayMs));
      }
      threadCounter += 1;
      const threadId = `codex-fx-${process.pid}-${threadCounter}`;
      notify("thread/started", { thread: { id: threadId } });
      respond(id, { thread: { id: threadId } });
      return;
    }
    case "thread/resume": {
      // Scripted archived-session rejection: the real app-server refuses to
      // resume an archived thread with an error naming the session. Tests use
      // an `archived-` provider-thread-id prefix to trigger it.
      if (
        String(params.threadId).startsWith("archived-") ||
        isThreadArchived(params.threadId)
      ) {
        respondError(
          id,
          -32603,
          `session ${params.threadId} is archived; unarchive it and retry`,
        );
        return;
      }
      // Mirror the real app-server (codex-cli 0.147.0, observed live for
      // #1727): thread/resume replays the rollout's last-turn token usage,
      // scoped to that PREVIOUS turn's id, before any new turn is started.
      // Opt-in via a `usage-replay-` provider-thread-id prefix.
      if (String(params.threadId).startsWith("usage-replay-")) {
        replayLastTurnUsage(params.threadId);
      }
      respond(id, { thread: { id: params.threadId } });
      return;
    }
    case "thread/fork": {
      // The real app-server reads the source rollout; an archived source is
      // refused with the same wording a resume gets.
      if (
        String(params.threadId).startsWith("archived-") ||
        isThreadArchived(params.threadId)
      ) {
        respondError(
          id,
          -32603,
          `session ${params.threadId} is archived; unarchive it and retry`,
        );
        return;
      }
      threadCounter += 1;
      const replaysUsage = String(params.threadId).startsWith("usage-replay-");
      const threadId = replaysUsage
        ? `usage-replay-fork-${process.pid}-${threadCounter}`
        : `codex-fx-${process.pid}-fork-${threadCounter}`;
      respond(id, { thread: { id: threadId } });
      // thread/fork replays the source rollout's last-turn usage the same way,
      // after the response, under the NEW thread id but the SOURCE turn id
      // (#1727).
      if (replaysUsage) {
        replayLastTurnUsage(threadId);
      }
      return;
    }
    case "turn/start": {
      // A prompt the provider handles locally: accepted and answered, but with
      // no turn/started and no turn/completed, so nothing in the child's
      // output can open or settle a bb turn (#1431).
      if (firstInputText(params.input) === ZERO_WORK_PROMPT_TEXT) {
        respond(id, {});
        return;
      }
      if (firstInputText(params.input) === SUBAGENT_THEN_CRASH_PROMPT_TEXT) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        openTurnIdsByThreadId.set(params.threadId, turnId);
        notify("turn/started", {
          threadId: params.threadId,
          turn: { id: turnId, status: "inProgress" },
        });
        notify("item/completed", {
          threadId: params.threadId,
          turnId,
          item: {
            type: "subAgentActivity",
            id: `call-fx-${turnCounter}`,
            kind: "started",
            agentThreadId: `codex-fx-sub-${turnCounter}`,
            agentPath: "reviewer",
          },
        });
        respond(id, {});
        setTimeout(() => process.exit(1), 20);
        return;
      }
      if (firstInputText(params.input) === LATE_TURN_START_PROMPT_TEXT) {
        respond(id, {});
        setTimeout(
          () => runScriptedTurn(params.threadId),
          LATE_TURN_START_DELAY_MS,
        );
        return;
      }
      if (firstInputText(params.input) === INTERRUPTIBLE_PROMPT_TEXT) {
        turnCounter += 1;
        const turnId = `turn-fx-${turnCounter}`;
        openTurnIdsByThreadId.set(params.threadId, turnId);
        notify("turn/started", {
          threadId: params.threadId,
          turn: { id: turnId, status: "inProgress" },
        });
        respond(id, {});
        return;
      }
      if (scriptedTurns) {
        await runScriptFileTurn(params.threadId);
      } else {
        runScriptedTurn(params.threadId);
      }
      respond(id, {});
      return;
    }
    case "turn/steer":
      respond(id, {});
      return;
    case "turn/interrupt": {
      const openTurnId = openTurnIdsByThreadId.get(params.threadId);
      if (openTurnId !== undefined) {
        openTurnIdsByThreadId.delete(params.threadId);
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: openTurnId, status: "interrupted" },
        });
      }
      respond(id, {});
      return;
    }
    case "thread/archive":
      // The real app-server moves the rollout into its archived dir, so a
      // second archive finds no live rollout; the reverse holds for unarchive.
      if (isThreadArchived(params.threadId)) {
        respondError(
          id,
          -32603,
          `no rollout found for thread id ${params.threadId}`,
        );
        return;
      }
      setThreadArchived(params.threadId, true);
      respond(id, {});
      return;
    case "thread/unarchive":
      if (!isThreadArchived(params.threadId)) {
        respondError(
          id,
          -32603,
          `no archived rollout found for thread id ${params.threadId}`,
        );
        return;
      }
      setThreadArchived(params.threadId, false);
      respond(id, {});
      return;
    case "thread/name/set":
      if (renameEmptyRolloutFailuresLeft > 0) {
        renameEmptyRolloutFailuresLeft -= 1;
        respondError(
          id,
          -32603,
          `failed to set thread name: rollout at /tmp/${params.threadId}.jsonl is empty`,
        );
        return;
      }
      respond(id, {});
      return;
    case "thread/compact/start":
    case "thread/goal/clear":
      respond(id, {});
      return;
    default:
      respondError(id, -32601, `Unknown method "${method}"`);
  }
}

const stdinLines = createInterface({ input: process.stdin, terminal: false });
stdinLines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return;
  }
  if (parsed.id !== undefined && typeof parsed.method === "string") {
    void handleRequest(parsed);
    return;
  }
  if (parsed.id !== undefined) {
    // A response to a request this process originated (an approval answer).
    const resolve = pendingOutboundRequests.get(parsed.id);
    if (resolve) {
      pendingOutboundRequests.delete(parsed.id);
      resolve(parsed);
    }
  }
});
stdinLines.on("close", () => {
  exitCleanly();
});
