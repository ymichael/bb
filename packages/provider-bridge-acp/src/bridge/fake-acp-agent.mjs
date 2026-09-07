#!/usr/bin/env node

/**
 * Scripted fake ACP agent for bridge tests.
 *
 * Speaks just enough of the Agent Client Protocol to exercise the bridge:
 * initialize/session lifecycle, streamed message chunks, permission requests,
 * client fs writes, cancellation, and (env-gated) session/load support.
 *
 * Env knobs (passed by tests through thread/start envVars):
 * - FAKE_ACP_LOAD_SESSION=1  → advertise + accept session/load
 * - FAKE_ACP_FAIL_LOAD=1     → advertise session/load, then fail it
 * - FAKE_ACP_FORK_SESSION=1  → advertise + accept session/fork
 * - FAKE_ACP_FORK_LOG        → write the session/fork params as JSON
 * - FAKE_ACP_FORK_REUSE_SOURCE_ID=1
 *                            → return the source session id from session/fork
 * - FAKE_ACP_USAGE_ON_LOAD=1 → report context usage during session/load
 * - FAKE_ACP_USAGE_SESSION_ID
 *                            → override the usage notification session id
 * - FAKE_ACP_MODEL_LINES     → stdout for the agent's `--list-models` mode
 * - FAKE_ACP_MODEL_LIST_STDERR
 *                            → make `--list-models` fail with this stderr
 * - FAKE_ACP_MODEL_CONFIG=1  → advertise a model configOptions select
 * - FAKE_ACP_MODELS_FIELD=1  → advertise legacy ACP models state
 * - FAKE_ACP_THOUGHT_LEVEL_CONFIG=1
 *                            → advertise per-model effort configOptions
 * - FAKE_ACP_INITIAL_FAST    → set the initial Fast mode value
 * - FAKE_ACP_UNMAPPED_REASONING_CONFIG=1
 *                            → advertise unmapped thought_level values
 * - FAKE_ACP_ACCEPT_NATIVE_REASONING=1
 *                            → accept reasoning_effort config updates without
 *                              advertising a thought_level config option
 * - FAKE_ACP_SET_CONFIG_MODEL_ERROR=1
 *                            → fail session/set_config_option for model values
 * - FAKE_ACP_SET_CONFIG_FAST_ERROR=1
 *                            → fail session/set_config_option for Fast values
 * - FAKE_ACP_CURSOR_PARAMETERIZED_MODELS=1
 *                            → mirror Cursor compatibility-vs-parameterized
 *                              model/config-option responses
 * - FAKE_ACP_REQUEST_LOG     → append each client request as JSON
 * - FAKE_ACP_MODEL_COUNT=<n> → pad the catalog to n reasoning-capable models
 *                              (exercises large-catalog reasoning discovery)
 * - FAKE_ACP_AUTH_METHODS    → comma-separated auth method ids to advertise;
 *                              session creation requires authenticate first
 * - FAKE_ACP_AUTH_OPTIONAL=1 → advertise the auth methods but never require
 *                              authenticate (a signed-in agent, as Cursor is)
 * - FAKE_ACP_SESSION_NEW_ERROR
 *                            → reject session/new with this message (-32603)
 * - FAKE_ACP_EXIT_ON_SESSION_NEW=<code>
 *                            → exit with this code when session/new arrives
 * - FAKE_ACP_SESSION_NEW_DELAY_MS=<ms>
 *                            → answer session/new only after this delay
 * - FAKE_ACP_UPDATES_WITH_SESSION_RESPONSE=1
 *                            → write a usage_update and a message chunk for
 *                              the new session (plus one for a stale session
 *                              id) in the same chunk as the session/new and
 *                              session/fork responses
 * - FAKE_ACP_IGNORE_CANCEL=1 → never answer a prompt after session/cancel
 * - FAKE_ACP_READY_FILE      → written once the agent process is up
 * - FAKE_ACP_SIGNAL_FILE     → written with "SIGTERM" when the agent is reaped
 * - FAKE_ACP_WRITE_PATH      → target path for the "write-file" prompt
 * - FAKE_ACP_LAUNCH_LOG      → append one line per process launch (used to
 *                              count model-discovery spawns in cache/TTL tests)
 * - FAKE_ACP_PROMPT_LOG      → append one JSON-encoded prompt text per request
 * - FAKE_ACP_PROMPT_ERROR=1  → reject every session/prompt request
 * - FAKE_ACP_COMPACT_STOP_REASON
 *                            → stop reason returned for /compact
 */

import { createInterface } from "node:readline";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";

const failLoad = process.env.FAKE_ACP_FAIL_LOAD === "1";
const loadSession = process.env.FAKE_ACP_LOAD_SESSION === "1" || failLoad;
const forkSession = process.env.FAKE_ACP_FORK_SESSION === "1";
const forkReuseSourceId = process.env.FAKE_ACP_FORK_REUSE_SOURCE_ID === "1";
const usageOnLoad = process.env.FAKE_ACP_USAGE_ON_LOAD === "1";
const usageSessionId = process.env.FAKE_ACP_USAGE_SESSION_ID;
const modelConfig = process.env.FAKE_ACP_MODEL_CONFIG === "1";
const modelsField = process.env.FAKE_ACP_MODELS_FIELD === "1";
const thoughtLevelConfig = process.env.FAKE_ACP_THOUGHT_LEVEL_CONFIG === "1";
const unmappedReasoningConfig =
  process.env.FAKE_ACP_UNMAPPED_REASONING_CONFIG === "1";
const acceptNativeReasoning =
  process.env.FAKE_ACP_ACCEPT_NATIVE_REASONING === "1";
const setConfigModelError = process.env.FAKE_ACP_SET_CONFIG_MODEL_ERROR === "1";
const setConfigFastError = process.env.FAKE_ACP_SET_CONFIG_FAST_ERROR === "1";
const cursorParameterizedModels =
  process.env.FAKE_ACP_CURSOR_PARAMETERIZED_MODELS === "1";
const requestLog = process.env.FAKE_ACP_REQUEST_LOG;
const hangInitialize = process.env.FAKE_ACP_HANG_INITIALIZE === "1";
const authMethods = (process.env.FAKE_ACP_AUTH_METHODS ?? "")
  .split(",")
  .map((method) => method.trim())
  .filter(Boolean);
const authOptional = process.env.FAKE_ACP_AUTH_OPTIONAL === "1";
const sessionNewError = process.env.FAKE_ACP_SESSION_NEW_ERROR;
const exitOnSessionNew = process.env.FAKE_ACP_EXIT_ON_SESSION_NEW;
const sessionNewDelayMs = Number(
  process.env.FAKE_ACP_SESSION_NEW_DELAY_MS ?? "0",
);
const updatesWithSessionResponse =
  process.env.FAKE_ACP_UPDATES_WITH_SESSION_RESPONSE === "1";
const ignoreCancel = process.env.FAKE_ACP_IGNORE_CANCEL === "1";
// `--list-models` is the agent's own model-list mode: the bridge derives its
// list command from the launch spec's agent binary plus `modelCli.listArgs`,
// so a list command can only ever be this binary.
if (process.argv.includes("--list-models")) {
  if (process.env.FAKE_ACP_MODEL_LIST_STDERR) {
    process.stderr.write(`${process.env.FAKE_ACP_MODEL_LIST_STDERR}\n`);
    process.exit(1);
  }
  process.stdout.write(`${process.env.FAKE_ACP_MODEL_LINES ?? ""}\n`);
  process.exit(0);
}

const sessionId = `fake-sess-${process.pid}`;
const fakeModels = [
  { value: "fake/default", name: "Fake Default" },
  { value: "fake/strong", name: "Fake Strong" },
];

let activePromptId = null;
let nextAgentRequestId = 1000;
let selectedModel = "fake/default";
let selectedEffort = "none";
let selectedFast = process.env.FAKE_ACP_INITIAL_FAST ?? "false";
let clientSupportsParameterizedModels = false;
let authenticatedMethod = null;
let activeSessionId = sessionId;
const pendingClientRequests = new Map();
let currentMcpServers = [];

const effortsByModel = new Map([
  ["fake/strong", ["none", "low", "medium", "high", "xhigh"]],
]);

const modelCount = Number(process.env.FAKE_ACP_MODEL_COUNT ?? "0");
for (let i = fakeModels.length; i < modelCount; i += 1) {
  const value = `fake/gen-${i}`;
  fakeModels.push({ value, name: `Fake Gen ${i}` });
  effortsByModel.set(value, ["low", "medium", "high"]);
}

process.on("SIGTERM", () => {
  if (process.env.FAKE_ACP_SIGNAL_FILE) {
    const signalFile = process.env.FAKE_ACP_SIGNAL_FILE;
    const stagedSignalFile = `${signalFile}.${process.pid}.tmp`;
    // The final path is the test's completion boundary: publish it only after
    // the marker bytes are complete.
    writeFileSync(stagedSignalFile, "SIGTERM\n");
    renameSync(stagedSignalFile, signalFile);
  }
  process.exit(0);
});

if (process.env.FAKE_ACP_READY_FILE) {
  writeFileSync(process.env.FAKE_ACP_READY_FILE, "ready\n");
}

if (process.env.FAKE_ACP_LAUNCH_LOG) {
  appendFileSync(process.env.FAKE_ACP_LAUNCH_LOG, `launch ${process.pid}\n`);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function notifyUpdate(update, targetSessionId = activeSessionId) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: targetSessionId, update },
  });
}

function messageChunk(text) {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  };
}

function effortOptionForModel(model) {
  if (unmappedReasoningConfig) {
    return {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "smart",
      options: [{ value: "smart" }, { value: "fast" }],
    };
  }
  const efforts = thoughtLevelConfig ? effortsByModel.get(model) : undefined;
  if (!efforts) {
    return undefined;
  }
  if (!efforts.includes(selectedEffort)) {
    selectedEffort = efforts[0];
  }
  return {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: selectedEffort,
    options: efforts.map((value) => ({ value })),
  };
}

function cursorModelOptions() {
  return clientSupportsParameterizedModels
    ? [
        { value: "default", name: "Auto" },
        { value: "composer-2.5", name: "Composer 2.5" },
        { value: "grok-4.6", name: "Cursor Grok 4.6" },
        { value: "grok-4.5", name: "Cursor Grok 4.5" },
        { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ]
    : [
        { value: "default[]", name: "Auto" },
        {
          value: "composer-2.5[fast=true]",
          name: "composer-2.5",
        },
        {
          value: "grok-4.6[effort=high,fast=true]",
          name: "grok-4.6",
        },
        {
          value: "grok-4.5[effort=high,fast=true]",
          name: "grok-4.5",
        },
      ];
}

function cursorConfigOptions() {
  const models = cursorModelOptions();
  if (!models.some((model) => model.value === selectedModel)) {
    selectedModel = models[0].value;
  }
  const options = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: selectedModel,
      options: models,
    },
  ];
  if (
    clientSupportsParameterizedModels &&
    (selectedModel.startsWith("grok-") || selectedModel === "claude-sonnet-4-6")
  ) {
    options.push(
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: selectedEffort,
        options: ["low", "medium", "high", "xhigh"].map((value) => ({
          value,
        })),
      },
      {
        id: "fast",
        name: "Fast",
        category: "model_config",
        type: "select",
        currentValue: selectedFast,
        options: [{ value: "false" }, { value: "true" }],
      },
    );
  }
  return options;
}

function configOptions() {
  if (cursorParameterizedModels) {
    return cursorConfigOptions();
  }
  if (!modelConfig) {
    return undefined;
  }
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: true,
      options: [{ value: "build", name: "Build" }],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: selectedModel,
      options: fakeModels,
    },
    effortOptionForModel(selectedModel),
  ].filter(Boolean);
}

function configState() {
  const state = {};
  const options = configOptions();
  if (options !== undefined) {
    state.configOptions = options;
  }
  if (cursorParameterizedModels) {
    const availableModels = cursorModelOptions();
    state.models = {
      currentModelId: selectedModel,
      availableModels: availableModels.map((model) => ({
        modelId: model.value,
        name: model.name,
      })),
    };
  } else if (modelsField) {
    state.models = {
      currentModelId: selectedModel,
      availableModels: fakeModels.map((model) => ({
        modelId: model.value,
        name: model.name,
      })),
    };
  }
  return state;
}

function requireAuthenticated(message) {
  if (
    authMethods.length === 0 ||
    authOptional ||
    authenticatedMethod !== null
  ) {
    return true;
  }
  // ACP's reserved auth-required error: code -32000 with this message.
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32000, message: "Authentication required" },
  });
  return false;
}

/**
 * A session response, optionally written in one chunk together with the
 * session's first updates (and one update for a session id this agent never
 * owned), the way an agent that starts streaming right away can.
 */
function sendSessionResponse(message, result) {
  const response = { jsonrpc: "2.0", id: message.id, result };
  if (!updatesWithSessionResponse) {
    send(response);
    return;
  }
  const update = (targetSessionId, body) => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: targetSessionId, update: body },
  });
  process.stdout.write(
    [
      response,
      update(result.sessionId, {
        sessionUpdate: "usage_update",
        used: 12_345,
        size: 200_000,
      }),
      update("stale-session", {
        sessionUpdate: "usage_update",
        used: 1,
        size: 2,
      }),
      update(result.sessionId, messageChunk("hello-with-session-response")),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
}

function requestClient(method, params) {
  nextAgentRequestId += 1;
  const id = nextAgentRequestId;
  return new Promise((resolve, reject) => {
    pendingClientRequests.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptText(prompt) {
  return (Array.isArray(prompt) ? prompt : [])
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function captureMcpServers(message) {
  currentMcpServers = Array.isArray(message.params?.mcpServers)
    ? message.params.mcpServers
    : [];
}

async function handlePrompt(message) {
  activePromptId = message.id;
  const text = promptText(message.params?.prompt);
  if (process.env.FAKE_ACP_PROMPT_LOG) {
    appendFileSync(
      process.env.FAKE_ACP_PROMPT_LOG,
      `${JSON.stringify(text)}\n`,
    );
  }

  if (process.env.FAKE_ACP_PROMPT_ERROR === "1") {
    activePromptId = null;
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "Fake prompt failure" },
    });
    return;
  }

  if (text === "/compact") {
    // OpenCode treats this exact prompt as a provider-local control.
    const compactMessage = process.env.FAKE_ACP_COMPACT_AGENT_MESSAGE;
    if (compactMessage !== undefined) {
      notifyUpdate(messageChunk(compactMessage));
    }
  } else if (text.includes("request-external-directory-permission")) {
    // opencode's external_directory permission: the running edit tool asks
    // with the generic kind "other", a bare directory title, and
    // locations = [file, parentDir]. Mirrors get-bb/bb#1719.
    notifyUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "write-tool-1",
      title: "Editing notes.md",
      kind: "edit",
      status: "pending",
      locations: [{ path: "/tmp/qa-1719/notes.md" }],
    });
    let outcome = "cancelled";
    try {
      const result = await requestClient("session/request_permission", {
        sessionId: activeSessionId,
        toolCall: {
          toolCallId: "write-tool-1",
          title: "/tmp/qa-1719",
          kind: "other",
          locations: [
            { path: "/tmp/qa-1719/notes.md" },
            { path: "/tmp/qa-1719" },
          ],
          rawInput: {
            filepath: "/tmp/qa-1719/notes.md",
            parentDir: "/tmp/qa-1719",
          },
        },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Deny", kind: "reject_once" },
        ],
      });
      outcome =
        result?.outcome?.outcome === "selected"
          ? result.outcome.optionId
          : "cancelled";
    } catch {
      outcome = "error";
    }
    notifyUpdate(messageChunk(`permission:${outcome}`));
  } else if (text.includes("request-permission")) {
    notifyUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "perm-tool-1",
      title: "Run rm",
      kind: "execute",
      status: "pending",
      rawInput: { command: "rm -rf /tmp/scratch" },
    });
    let outcome = "cancelled";
    try {
      const result = await requestClient("session/request_permission", {
        sessionId: activeSessionId,
        toolCall: {
          toolCallId: "perm-tool-1",
          title: "Run rm",
          kind: "execute",
          rawInput: { command: "rm -rf /tmp/scratch" },
        },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "no", name: "Deny", kind: "reject_once" },
        ],
      });
      outcome =
        result?.outcome?.outcome === "selected"
          ? result.outcome.optionId
          : "cancelled";
    } catch {
      outcome = "error";
    }
    notifyUpdate(messageChunk(`permission:${outcome}`));
  } else if (text.includes("write-file")) {
    try {
      await requestClient("fs/write_text_file", {
        sessionId: activeSessionId,
        path: process.env.FAKE_ACP_WRITE_PATH,
        content: "hello from agent\n",
      });
      notifyUpdate(messageChunk("write:ok"));
    } catch {
      notifyUpdate(messageChunk("write:denied"));
    }
  } else if (text.includes("hang")) {
    // Stay pending until the client sends session/cancel.
    return;
  } else if (text.includes("die")) {
    process.exit(7);
  } else if (text.includes("slow")) {
    notifyUpdate(messageChunk(`echo:${text}`));
    await sleep(300);
  } else if (text.includes("echo-argv")) {
    // Lets bridge tests assert the launch args (e.g. the --model pin).
    notifyUpdate(messageChunk(`argv:${process.argv.slice(2).join(" ")}`));
  } else if (text.includes("echo-selected-model")) {
    notifyUpdate(messageChunk(`selected-model:${selectedModel}`));
  } else if (text.includes("echo-selected-effort")) {
    notifyUpdate(messageChunk(`selected-effort:${selectedEffort}`));
  } else if (text.includes("echo-selected-fast")) {
    notifyUpdate(messageChunk(`selected-fast:${selectedFast}`));
  } else if (text.includes("echo-auth-method")) {
    notifyUpdate(messageChunk(`auth-method:${authenticatedMethod ?? "none"}`));
  } else if (text.includes("echo-electron-run-as-node")) {
    notifyUpdate(
      messageChunk(
        `electron-run-as-node:${process.env.ELECTRON_RUN_AS_NODE ?? "missing"}`,
      ),
    );
  } else if (text.includes("echo-mcp-servers")) {
    const names = currentMcpServers
      .map((server) => server?.name)
      .filter((name) => typeof name === "string")
      .join(",");
    notifyUpdate(messageChunk(`mcp-servers:${names}`));
  } else if (text.includes("echo-mcp-server-config")) {
    notifyUpdate(
      messageChunk(`mcp-server-config:${JSON.stringify(currentMcpServers)}`),
    );
  } else {
    notifyUpdate(messageChunk(`echo:${text}`));
  }

  if (activePromptId === message.id) {
    activePromptId = null;
    const stopReason =
      text === "/compact"
        ? (process.env.FAKE_ACP_COMPACT_STOP_REASON ?? "end_turn")
        : "end_turn";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason },
    });
  }
}

async function handleMessage(message) {
  if (requestLog) {
    appendFileSync(requestLog, `${JSON.stringify(message)}\n`);
  }
  switch (message.method) {
    case "initialize":
      if (hangInitialize) {
        return;
      }
      if (cursorParameterizedModels) {
        clientSupportsParameterizedModels =
          message.params?.clientCapabilities?._meta
            ?.parameterizedModelPicker === true;
        selectedModel = clientSupportsParameterizedModels
          ? "default"
          : "default[]";
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession,
            promptCapabilities: { image: false },
            ...(forkSession ? { sessionCapabilities: { fork: {} } } : {}),
          },
          ...(authMethods.length > 0
            ? { authMethods: authMethods.map((id) => ({ id })) }
            : {}),
        },
      });
      return;
    case "authenticate": {
      const methodId = message.params?.methodId;
      if (!authMethods.includes(methodId)) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `unsupported auth: ${methodId}` },
        });
        return;
      }
      if (methodId === "xai.api_key" && !process.env.XAI_API_KEY) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32001, message: "XAI_API_KEY is required" },
        });
        return;
      }
      authenticatedMethod = methodId;
      send({ jsonrpc: "2.0", id: message.id, result: null });
      return;
    }
    case "session/new":
      if (!requireAuthenticated(message)) {
        return;
      }
      if (exitOnSessionNew !== undefined) {
        process.exit(Number(exitOnSessionNew));
      }
      if (sessionNewError !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: sessionNewError },
        });
        return;
      }
      if (sessionNewDelayMs > 0) {
        await sleep(sessionNewDelayMs);
      }
      activeSessionId = sessionId;
      captureMcpServers(message);
      sendSessionResponse(message, {
        sessionId: activeSessionId,
        ...configState(),
      });
      return;
    case "session/load":
      if (!requireAuthenticated(message)) {
        return;
      }
      if (loadSession) {
        captureMcpServers(message);
        if (usageOnLoad) {
          notifyUpdate(
            { sessionUpdate: "usage_update", used: 24_000, size: 128_000 },
            usageSessionId ?? message.params?.sessionId,
          );
        }
        if (failLoad) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "session/load failed" },
          });
        } else {
          activeSessionId = message.params?.sessionId;
          send({ jsonrpc: "2.0", id: message.id, result: configState() });
        }
      } else {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "session/load is not supported" },
        });
      }
      return;
    case "session/fork":
      if (!requireAuthenticated(message)) {
        return;
      }
      if (!forkSession) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "session/fork is not supported" },
        });
        return;
      }
      if (process.env.FAKE_ACP_FORK_LOG) {
        writeFileSync(
          process.env.FAKE_ACP_FORK_LOG,
          JSON.stringify(message.params),
        );
      }
      activeSessionId = forkReuseSourceId
        ? message.params.sessionId
        : `fake-fork-${process.pid}`;
      captureMcpServers(message);
      sendSessionResponse(message, {
        sessionId: activeSessionId,
        ...configState(),
      });
      return;
    case "session/set_model": {
      const modelId = message.params?.modelId;
      const availableModels = cursorParameterizedModels
        ? cursorModelOptions()
        : fakeModels;
      if (
        (!cursorParameterizedModels && !modelConfig && !modelsField) ||
        typeof modelId !== "string" ||
        !availableModels.some((model) => model.value === modelId)
      ) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `model not found: ${modelId}` },
        });
        return;
      }
      selectedModel = modelId;
      send({ jsonrpc: "2.0", id: message.id, result: configState() });
      return;
    }
    case "session/set_config_option": {
      const configId = message.params?.configId;
      const value = message.params?.value;
      if (configId === "model") {
        if (setConfigModelError) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "model config probe failed" },
          });
          return;
        }
        const availableModels = cursorParameterizedModels
          ? cursorModelOptions()
          : fakeModels;
        if (
          (!cursorParameterizedModels && !modelConfig) ||
          typeof value !== "string" ||
          !availableModels.some((model) => model.value === value)
        ) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: `model not found: ${value}` },
          });
          return;
        }
        selectedModel = value;
        send({ jsonrpc: "2.0", id: message.id, result: configState() });
        return;
      }
      if (configId === "effort") {
        const efforts = cursorParameterizedModels
          ? ["low", "medium", "high", "xhigh"]
          : effortsByModel.get(selectedModel);
        if (
          (!cursorParameterizedModels && !thoughtLevelConfig) ||
          typeof value !== "string" ||
          !efforts?.includes(value)
        ) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: `effort not found: ${value}` },
          });
          return;
        }
        selectedEffort = value;
        send({ jsonrpc: "2.0", id: message.id, result: configState() });
        return;
      }
      if (configId === "fast" && cursorParameterizedModels) {
        if (setConfigFastError) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: "fast config update failed" },
          });
          return;
        }
        if (value !== "false" && value !== "true") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: `fast mode not found: ${value}` },
          });
          return;
        }
        selectedFast = value;
        send({ jsonrpc: "2.0", id: message.id, result: configState() });
        return;
      }
      if (configId === "reasoning_effort" && acceptNativeReasoning) {
        if (typeof value !== "string") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: `effort not found: ${value}` },
          });
          return;
        }
        selectedEffort = value;
        send({ jsonrpc: "2.0", id: message.id, result: configState() });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: `Unknown config ${configId}` },
      });
      return;
    }
    case "session/prompt":
      await handlePrompt(message);
      return;
    case "session/cancel":
      if (ignoreCancel) {
        // An agent that never settles a cancelled prompt.
        return;
      }
      if (activePromptId !== null) {
        const id = activePromptId;
        activePromptId = null;
        send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
      }
      return;
    default:
      if (message.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Unknown method ${message.method}` },
        });
      }
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const pending = pendingClientRequests.get(message.id);
    if (pending) {
      pendingClientRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "client error"));
      } else {
        pending.resolve(message.result);
      }
    }
    return;
  }
  void handleMessage(message);
});
rl.on("close", () => {
  process.exit(0);
});
