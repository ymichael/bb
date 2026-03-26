const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

const threads = new Map();
const pendingToolCalls = new Map();

let nextProviderThreadId = 1;
let nextToolCallId = 1;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function getThreadState(threadId) {
  const thread = threads.get(threadId);
  if (!thread) {
    return null;
  }
  return thread;
}

function parseInputText(input) {
  return (input ?? [])
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join(" ");
}

function parseTurnPlan(inputText) {
  const delayMatch = /(?:^|\s)delay:(\d+)(?:\s|$)/.exec(inputText);
  const toolMatch = /(?:^|\s)call_tool:([^\s]+)(?:\s|$)/.exec(inputText);

  let delayMs = delayMatch ? Number(delayMatch[1]) : 0;
  let toolName = toolMatch ? toolMatch[1] : null;

  if (toolName && /^delay:\d+$/u.test(toolName)) {
    delayMs = Number(toolName.slice("delay:".length));
    toolName = null;
  }

  return {
    delayMs,
    responseText: inputText ? `Response to: ${inputText}` : "Response complete",
    toolName,
  };
}

function clearActiveTurn(thread) {
  if (!thread.activeTurn) {
    return;
  }
  if (thread.activeTurn.timer) {
    clearTimeout(thread.activeTurn.timer);
  }
  thread.activeTurn = null;
}

function completeTurn(threadId, status, responseText) {
  const thread = getThreadState(threadId);
  if (!thread || !thread.activeTurn) {
    return;
  }

  const turn = thread.activeTurn;
  clearActiveTurn(thread);

  if (status === "completed") {
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        threadId,
        turnId: turn.turnId,
        item: {
          type: "agentMessage",
          id: `msg-${thread.turnCount}`,
          text: responseText,
        },
      },
    });
  }

  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      threadId,
      turnId: turn.turnId,
      providerThreadId: thread.providerThreadId,
      status,
    },
  });
}

function scheduleTurnCompletion(threadId, responseText, delayMs) {
  const thread = getThreadState(threadId);
  if (!thread || !thread.activeTurn) {
    return;
  }

  thread.activeTurn.timer = setTimeout(() => {
    completeTurn(threadId, "completed", responseText);
  }, delayMs);
}

function startTurn(message) {
  const threadId = message.params?.threadId ?? "unknown";
  const thread = getThreadState(threadId);
  if (!thread) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "Unknown thread: " + threadId },
    });
    return;
  }

  clearActiveTurn(thread);
  thread.turnCount += 1;

  const turnId = "turn-" + thread.turnCount;
  const inputText = parseInputText(message.params?.input);
  const plan = parseTurnPlan(inputText);

  thread.activeTurn = {
    turnId,
    timer: null,
  };

  send({
    jsonrpc: "2.0",
    id: message.id,
    result: { ok: true },
  });
  send({
    jsonrpc: "2.0",
    method: "turn/started",
    params: {
      threadId,
      turnId,
      providerThreadId: thread.providerThreadId,
    },
  });

  if (plan.toolName) {
    const toolCallId = nextToolCallId++;
    pendingToolCalls.set(toolCallId, {
      delayMs: plan.delayMs,
      responseText: `Tool called: ${plan.toolName}`,
      threadId,
    });
    send({
      jsonrpc: "2.0",
      id: toolCallId,
      method: "item/tool/call",
      params: {
        threadId,
        turnId,
        callId: "call-" + toolCallId,
        tool: plan.toolName,
        arguments: {},
      },
    });
    return;
  }

  scheduleTurnCompletion(threadId, plan.responseText, plan.delayMs);
}

function startOrResumeThread(message, mode) {
  const threadId = message.params?.threadId ?? "unknown";
  const providerThreadId =
    mode === "resume"
      ? (message.params?.providerThreadId ?? "resumed-" + nextProviderThreadId++)
      : "prov-" + nextProviderThreadId++;

  threads.set(threadId, {
    activeTurn: null,
    providerThreadId,
    turnCount: 0,
  });

  send({
    jsonrpc: "2.0",
    id: message.id,
    result: { providerThreadId },
  });

  if (mode === "start") {
    send({
      jsonrpc: "2.0",
      method: "thread/identity",
      params: { threadId, providerThreadId },
    });
  }
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id !== undefined && !message.method) {
    const pendingToolCall = pendingToolCalls.get(message.id);
    if (!pendingToolCall) {
      return;
    }

    pendingToolCalls.delete(message.id);
    scheduleTurnCompletion(
      pendingToolCall.threadId,
      pendingToolCall.responseText,
      pendingToolCall.delayMs,
    );
    return;
  }

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true },
    });
    return;
  }

  if (message.method === "thread/start") {
    startOrResumeThread(message, "start");
    return;
  }

  if (message.method === "thread/resume") {
    startOrResumeThread(message, "resume");
    return;
  }

  if (message.method === "turn/start") {
    startTurn(message);
    return;
  }

  if (message.method === "turn/steer") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true },
    });
    return;
  }

  if (message.method === "thread/stop") {
    const threadId = message.params?.threadId ?? "unknown";
    const thread = getThreadState(threadId);
    if (thread && thread.activeTurn) {
      completeTurn(threadId, "interrupted", "Interrupted");
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true },
    });
    return;
  }

  if (message.method === "thread/name/set") {
    const threadId = message.params?.threadId ?? "unknown";
    const thread = getThreadState(threadId);
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { ok: true },
    });
    if (thread) {
      send({
        jsonrpc: "2.0",
        method: "thread/name/updated",
        params: {
          threadId,
          providerThreadId: thread.providerThreadId,
          threadName: message.params?.title ?? "",
        },
      });
    }
    return;
  }

  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found: " + message.method },
    });
  }
});
