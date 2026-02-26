import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createInterface, type Interface } from "node:readline";

type JsonRpcId = string | number;
type JsonObject = Record<string, unknown>;

interface BridgeCliOptions {
  piCommand: string;
  piArgs: string[];
}

interface PendingPiRequest {
  command: string;
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface AssistantItemState {
  itemId: string;
  text: string;
  reasoningItemId?: string;
  reasoningText: string;
}

interface ToolExecutionState {
  toolName: string;
  command?: string;
  output: string;
}

interface PiImageInput {
  type: "image";
  data: string;
  mimeType: string;
}

function asRecord(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function asJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

function normalizeToken(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function parseCliOptions(argv: string[]): BridgeCliOptions {
  let piCommand = process.env.BEANBAG_PI_PROVIDER_COMMAND?.trim() || "pi";
  const piArgs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pi-command" && i + 1 < argv.length) {
      piCommand = argv[i + 1] ?? piCommand;
      i += 1;
      continue;
    }
    if (arg === "--pi-arg" && i + 1 < argv.length) {
      piArgs.push(argv[i + 1] ?? "");
      i += 1;
    }
  }

  return {
    piCommand,
    piArgs,
  };
}

function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function derivePreviewFromInput(input: unknown): string | undefined {
  if (!Array.isArray(input)) return undefined;
  for (const entry of input) {
    const part = asRecord(entry);
    if (!part) continue;
    if (normalizeToken(asString(part.type)) !== "text") continue;
    const text = asString(part.text)?.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length <= 60) return text;
    return `${text.slice(0, 57).trimEnd()}...`;
  }
  return undefined;
}

function imageMimeTypeFromPath(path: string): string {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function buildPromptFromInput(input: unknown): {
  message: string;
  images: PiImageInput[];
} {
  const textParts: string[] = [];
  const images: PiImageInput[] = [];

  if (!Array.isArray(input)) {
    return {
      message: "Continue.",
      images,
    };
  }

  for (const entry of input) {
    const part = asRecord(entry);
    if (!part) continue;
    const type = normalizeToken(asString(part.type));

    switch (type) {
      case "text": {
        const text = asString(part.text);
        if (text) textParts.push(text);
        break;
      }
      case "localimage": {
        const path = asString(part.path);
        if (!path) break;
        try {
          const data = readFileSync(path).toString("base64");
          images.push({
            type: "image",
            data,
            mimeType: imageMimeTypeFromPath(path),
          });
        } catch {
          textParts.push(`[image unavailable: ${path}]`);
        }
        break;
      }
      case "image": {
        const url = asString(part.url);
        if (url) textParts.push(`[image URL: ${url}]`);
        break;
      }
      case "localfile": {
        const path = asString(part.path);
        if (path) textParts.push(`[file: ${path}]`);
        break;
      }
      default:
        break;
    }
  }

  const message = textParts.join("").trim();
  if (message.length > 0) {
    return { message, images };
  }

  if (images.length > 0) {
    return { message: "Please analyze the attached image(s).", images };
  }

  return { message: "Continue.", images };
}

function extractTextFromContentValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const entry of value) {
      const record = asRecord(entry);
      if (!record) continue;
      const text = asString(record.text);
      if (text) {
        out.push(text);
      }
    }
    return out.join("");
  }
  return "";
}

function extractAssistantText(message: JsonObject | null): string {
  if (!message) return "";
  return extractTextFromContentValue(message.content);
}

function extractAssistantReasoning(message: JsonObject | null): string {
  if (!message) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const entry of content) {
    const block = asRecord(entry);
    if (!block) continue;
    const type = normalizeToken(asString(block.type));
    if (type !== "thinking" && type !== "reasoning") continue;
    const text = asString(block.thinking) ?? asString(block.text);
    if (text) parts.push(text);
  }
  return parts.join("");
}

function toPiCommandString(toolName: string, args: JsonObject | null): string | undefined {
  const command = asString(args?.command);
  if (command) return command;
  if (!args || Object.keys(args).length === 0) return undefined;
  try {
    return `${toolName} ${JSON.stringify(args)}`;
  } catch {
    return toolName;
  }
}

function extractToolOutput(result: unknown): string {
  const record = asRecord(result);
  if (!record) return "";
  return extractTextFromContentValue(record.content);
}

function extractToolExitCode(result: unknown): number | undefined {
  const record = asRecord(result);
  if (!record) return undefined;
  const details = asRecord(record.details);
  const exitCode = details?.exitCode;
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) {
    return exitCode;
  }
  return undefined;
}

function extractDelta(previous: string, next: string): string {
  if (!next) return "";
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  return next;
}

class PiRpcBridge {
  private piProcess: ChildProcess | undefined;
  private piStdoutRl: Interface | undefined;
  private piStderrRl: Interface | undefined;
  private stdinRl: Interface | undefined;
  private pendingPiRequests = new Map<string, PendingPiRequest>();
  private piRequestCounter = 0;
  private requestChain: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  private providerThreadId: string | undefined;
  private activeTurnId: string | undefined;
  private turnCounter = 0;
  private messageCounter = 0;
  private assistantStates = new Map<string, AssistantItemState>();
  private userItemIds = new Map<string, string>();
  private toolStates = new Map<string, ToolExecutionState>();

  constructor(private readonly cli: BridgeCliOptions) {}

  start(): void {
    this.stdinRl = createInterface({ input: process.stdin });
    this.stdinRl.on("line", (line) => {
      this.requestChain = this.requestChain
        .then(() => this.handleInboundLine(line))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[pi-rpc-bridge] inbound error: ${message}\n`);
        });
    });
    this.stdinRl.on("close", () => {
      void this.shutdown(0);
    });

    process.on("SIGTERM", () => {
      void this.shutdown(0);
    });
    process.on("SIGINT", () => {
      void this.shutdown(0);
    });
  }

  private async handleInboundLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    const msg = asRecord(parsed);
    if (!msg) return;

    const id = asJsonRpcId(msg.id);
    const method = asString(msg.method);
    if (!method) {
      this.respondError(id, "JSON-RPC method must be a string");
      return;
    }

    try {
      await this.dispatchRequest(method, msg.params);
      this.respondResult(id, this.lastResultForMethod(method));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.respondError(id, message);
    }
  }

  private lastResultForMethod(method: string): unknown {
    switch (method) {
      case "thread/start":
      case "thread/resume":
        return this.providerThreadId ? { threadId: this.providerThreadId } : {};
      default:
        return {};
    }
  }

  private async dispatchRequest(method: string, params: unknown): Promise<void> {
    switch (method) {
      case "initialize":
        await this.ensurePiProcess();
        return;
      case "thread/start":
        await this.handleThreadStart(params);
        return;
      case "thread/resume":
        await this.handleThreadResume(params);
        return;
      case "turn/start":
        await this.handleTurnStart(params);
        return;
      case "turn/steer":
        await this.handleTurnSteer(params);
        return;
      case "thread/name/set":
        await this.handleThreadNameSet(params);
        return;
      default:
        throw new Error(`Unsupported method "${method}"`);
    }
  }

  private respondResult(id: JsonRpcId | undefined, result: unknown): void {
    if (id === undefined) return;
    writeJsonLine({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private respondError(id: JsonRpcId | undefined, message: string): void {
    if (id === undefined) return;
    writeJsonLine({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message,
      },
    });
  }

  private emitNotification(method: string, params: unknown): void {
    writeJsonLine({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  private async handleThreadStart(params: unknown): Promise<void> {
    const record = asRecord(params) ?? {};
    await this.ensurePiProcess();
    await this.applyExecutionOptions(record);
    const state = await this.getState();
    this.providerThreadId = this.resolveProviderThreadId(state);
    if (!this.providerThreadId) {
      throw new Error("Pi RPC state did not include a resumable session ID");
    }

    const preview = derivePreviewFromInput(record.input);
    this.emitNotification("thread/started", {
      threadId: this.providerThreadId,
      thread: {
        id: this.providerThreadId,
        ...(preview ? { preview } : {}),
      },
    });
  }

  private async handleThreadResume(params: unknown): Promise<void> {
    const record = asRecord(params) ?? {};
    const targetThreadId = asString(record.threadId);
    if (!targetThreadId) {
      throw new Error("thread/resume requires params.threadId");
    }

    await this.ensurePiProcess();
    await this.switchSession(targetThreadId);
    await this.applyExecutionOptions(record);

    const state = await this.getState();
    this.providerThreadId = this.resolveProviderThreadId(state) ?? targetThreadId;
  }

  private async handleTurnStart(params: unknown): Promise<void> {
    const record = asRecord(params) ?? {};
    await this.ensurePiProcess();
    await this.ensureSessionFromTurnParams(record);
    await this.applyExecutionOptions(record);

    const prompt = buildPromptFromInput(record.input);
    await this.sendPiCommand({
      type: "prompt",
      message: prompt.message,
      ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
    });
  }

  private async handleTurnSteer(params: unknown): Promise<void> {
    const record = asRecord(params) ?? {};
    await this.ensurePiProcess();
    await this.ensureSessionFromTurnParams(record);

    const expectedTurnId = asString(record.expectedTurnId);
    if (expectedTurnId && this.activeTurnId && expectedTurnId !== this.activeTurnId) {
      throw new Error(
        `turn/steer expected turn ${expectedTurnId}, but active turn is ${this.activeTurnId}`,
      );
    }

    const prompt = buildPromptFromInput(record.input);
    await this.sendPiCommand({
      type: "steer",
      message: prompt.message,
      ...(prompt.images.length > 0 ? { images: prompt.images } : {}),
    });
  }

  private async handleThreadNameSet(params: unknown): Promise<void> {
    const record = asRecord(params) ?? {};
    const title = asString(record.name)?.trim();
    if (!title) {
      throw new Error("thread/name/set requires params.name");
    }

    await this.ensurePiProcess();
    await this.sendPiCommand({
      type: "set_session_name",
      name: title,
    });
    this.emitNotification("thread/name/updated", {
      threadName: title,
      threadId: this.providerThreadId,
    });
  }

  private async ensureSessionFromTurnParams(params: JsonObject): Promise<void> {
    const requestedThreadId = asString(params.threadId);
    if (!requestedThreadId) return;
    if (!this.providerThreadId) {
      this.providerThreadId = requestedThreadId;
      return;
    }
    if (requestedThreadId === this.providerThreadId) return;
    await this.switchSession(requestedThreadId);
  }

  private async switchSession(sessionPath: string): Promise<void> {
    const response = await this.sendPiCommand({
      type: "switch_session",
      sessionPath,
    });
    const data = asRecord(response.data);
    if (data?.cancelled === true) {
      throw new Error(`Pi cancelled switch_session for "${sessionPath}"`);
    }
    const state = await this.getState();
    this.providerThreadId = this.resolveProviderThreadId(state) ?? sessionPath;
  }

  private async applyExecutionOptions(params: JsonObject): Promise<void> {
    const modelValue = asString(params.model);
    if (modelValue) {
      const resolvedModel = await this.resolveModelSelection(modelValue);
      if (resolvedModel) {
        await this.sendPiCommand({
          type: "set_model",
          provider: resolvedModel.provider,
          modelId: resolvedModel.modelId,
        });
      }
    }

    const config = asRecord(params.config);
    const reasoningLevel = asString(config?.model_reasoning_effort);
    if (reasoningLevel) {
      await this.sendPiCommand({
        type: "set_thinking_level",
        level: reasoningLevel,
      });
    }
  }

  private async resolveModelSelection(
    model: string,
  ): Promise<{ provider: string; modelId: string } | undefined> {
    const slashIndex = model.indexOf("/");
    if (slashIndex > 0 && slashIndex < model.length - 1) {
      return {
        provider: model.slice(0, slashIndex),
        modelId: model.slice(slashIndex + 1),
      };
    }

    try {
      const response = await this.sendPiCommand({ type: "get_available_models" });
      const data = asRecord(response.data);
      const models = Array.isArray(data?.models) ? data.models : [];
      const matches = models
        .map((entry) => asRecord(entry))
        .filter((entry): entry is JsonObject => Boolean(entry))
        .filter((entry) => asString(entry.id) === model);
      if (matches.length === 1) {
        const provider = asString(matches[0].provider);
        const modelId = asString(matches[0].id);
        if (provider && modelId) {
          return { provider, modelId };
        }
      }
    } catch {
      // Best effort: ignore model override if we cannot resolve it in Pi.
    }

    return undefined;
  }

  private async getState(): Promise<JsonObject> {
    const response = await this.sendPiCommand({ type: "get_state" });
    const data = asRecord(response.data);
    if (!data) throw new Error("Pi get_state returned malformed data");
    return data;
  }

  private resolveProviderThreadId(state: JsonObject): string | undefined {
    return asString(state.sessionFile) ?? asString(state.sessionId);
  }

  private async ensurePiProcess(): Promise<void> {
    if (this.piProcess && this.piProcess.exitCode === null) return;

    const child = spawn(
      this.cli.piCommand,
      ["--mode", "rpc", ...this.cli.piArgs],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: process.cwd(),
        env: process.env,
      },
    );
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error(`Failed to launch Pi process using command "${this.cli.piCommand}"`);
    }
    this.piProcess = child;

    this.piStdoutRl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.piStdoutRl.on("line", (line) => this.handlePiStdoutLine(line));

    this.piStderrRl = createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    this.piStderrRl.on("line", (line) => {
      process.stderr.write(`[pi-rpc] ${line}\n`);
    });

    child.on("error", (err) => {
      const error = new Error(`Pi process error: ${err.message}`);
      for (const [, pending] of this.pendingPiRequests) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pendingPiRequests.clear();
      this.piProcess = undefined;
      this.piStdoutRl?.close();
      this.piStdoutRl = undefined;
      this.piStderrRl?.close();
      this.piStderrRl = undefined;
      if (!this.shuttingDown) {
        process.stderr.write(`[pi-rpc-bridge] ${error.message}\n`);
        process.exit(1);
      }
    });

    child.on("exit", (code, signal) => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      const error = new Error(`Pi process exited (${reason})`);
      for (const [, pending] of this.pendingPiRequests) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pendingPiRequests.clear();
      this.piProcess = undefined;
      this.piStdoutRl?.close();
      this.piStdoutRl = undefined;
      this.piStderrRl?.close();
      this.piStderrRl = undefined;
      if (!this.shuttingDown) {
        process.stderr.write(`[pi-rpc-bridge] ${error.message}\n`);
        process.exit(1);
      }
    });

    await this.sendPiCommand({ type: "get_state" }, 15_000);
  }

  private handlePiStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    const msg = asRecord(parsed);
    if (!msg) return;

    const responseType = asString(msg.type);
    if (responseType === "response") {
      const responseId = asString(msg.id);
      if (!responseId) return;

      const pending = this.pendingPiRequests.get(responseId);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pendingPiRequests.delete(responseId);

      if (msg.success === false) {
        const err = asString(msg.error) ?? `Pi command ${pending.command} failed`;
        pending.reject(new Error(err));
        return;
      }

      pending.resolve(msg);
      return;
    }

    this.translatePiEvent(msg);
  }

  private translatePiEvent(event: JsonObject): void {
    const type = asString(event.type);
    if (!type) return;

    switch (type) {
      case "turn_start":
        this.handlePiTurnStart();
        return;
      case "turn_end":
        this.handlePiTurnEnd();
        return;
      case "agent_end":
        this.completeActiveTurn();
        return;
      case "message_start":
        this.handlePiMessageStart(event);
        return;
      case "message_update":
        this.handlePiMessageUpdate(event);
        return;
      case "message_end":
        this.handlePiMessageEnd(event);
        return;
      case "tool_execution_start":
        this.handlePiToolExecutionStart(event);
        return;
      case "tool_execution_update":
        this.handlePiToolExecutionUpdate(event);
        return;
      case "tool_execution_end":
        this.handlePiToolExecutionEnd(event);
        return;
      default:
        this.emitNotification(type, event);
    }
  }

  private handlePiTurnStart(): void {
    this.turnCounter += 1;
    this.activeTurnId = `pi-turn-${this.turnCounter}`;
    this.emitNotification("turn/started", {
      turnId: this.activeTurnId,
      threadId: this.providerThreadId,
    });
  }

  private handlePiTurnEnd(): void {
    this.completeActiveTurn();
  }

  private completeActiveTurn(): void {
    if (!this.activeTurnId) return;
    this.emitNotification("turn/completed", {
      turnId: this.activeTurnId,
      threadId: this.providerThreadId,
    });
    this.activeTurnId = undefined;
    this.assistantStates.clear();
  }

  private nextItemId(prefix: string): string {
    this.messageCounter += 1;
    return `${prefix}-${this.messageCounter}`;
  }

  private messageKey(message: JsonObject): string {
    const role = normalizeToken(asString(message.role)) || "unknown";
    const timestamp = message.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      return `${role}:${timestamp}`;
    }
    const id = asString(message.id);
    if (id) return `${role}:${id}`;
    return `${role}:${this.nextItemId("msg")}`;
  }

  private handlePiMessageStart(event: JsonObject): void {
    const message = asRecord(event.message);
    if (!message) return;
    const role = normalizeToken(asString(message.role));
    const key = this.messageKey(message);

    if (role === "user") {
      const itemId = this.nextItemId("user");
      this.userItemIds.set(key, itemId);
      this.emitNotification("item/started", {
        turnId: this.activeTurnId,
        item: {
          id: itemId,
          type: "userMessage",
          content: this.toUserContent(message),
        },
      });
      return;
    }

    if (role === "assistant") {
      this.assistantStates.set(key, {
        itemId: this.nextItemId("assistant"),
        text: "",
        reasoningText: "",
      });
    }
  }

  private handlePiMessageUpdate(event: JsonObject): void {
    const message = asRecord(event.message);
    if (!message) return;
    const role = normalizeToken(asString(message.role));
    if (role !== "assistant") return;

    const key = this.messageKey(message);
    const state =
      this.assistantStates.get(key) ??
      {
        itemId: this.nextItemId("assistant"),
        text: "",
        reasoningText: "",
      };
    this.assistantStates.set(key, state);

    const assistantEvent = asRecord(event.assistantMessageEvent);
    const deltaType = normalizeToken(asString(assistantEvent?.type));
    const deltaText =
      asString(assistantEvent?.delta) ??
      asString(assistantEvent?.content) ??
      "";
    if (!deltaText) return;

    if (deltaType === "thinking_delta" || deltaType === "reasoning_delta") {
      if (!state.reasoningItemId) {
        state.reasoningItemId = this.nextItemId("reasoning");
      }
      state.reasoningText += deltaText;
      this.emitNotification("item/reasoning/summaryTextDelta", {
        turnId: this.activeTurnId,
        itemId: state.reasoningItemId,
        delta: deltaText,
      });
      return;
    }

    if (deltaType === "text_delta") {
      state.text += deltaText;
      this.emitNotification("item/agentMessage/delta", {
        turnId: this.activeTurnId,
        itemId: state.itemId,
        delta: deltaText,
      });
    }
  }

  private handlePiMessageEnd(event: JsonObject): void {
    const message = asRecord(event.message);
    if (!message) return;
    const role = normalizeToken(asString(message.role));
    const key = this.messageKey(message);

    if (role === "user") {
      const existing = this.userItemIds.get(key);
      const itemId = existing ?? this.nextItemId("user");
      this.userItemIds.delete(key);
      this.emitNotification("item/completed", {
        turnId: this.activeTurnId,
        item: {
          id: itemId,
          type: "userMessage",
          content: this.toUserContent(message),
        },
      });
      return;
    }

    if (role !== "assistant") return;

    const state =
      this.assistantStates.get(key) ??
      {
        itemId: this.nextItemId("assistant"),
        text: "",
        reasoningText: "",
      };
    this.assistantStates.delete(key);

    const finalReasoning =
      state.reasoningText || extractAssistantReasoning(message);
    if (finalReasoning) {
      this.emitNotification("item/completed", {
        turnId: this.activeTurnId,
        item: {
          id: state.reasoningItemId ?? this.nextItemId("reasoning"),
          type: "reasoning",
          summary: finalReasoning,
        },
      });
    }

    const finalText = state.text || extractAssistantText(message);
    if (!finalText) return;
    this.emitNotification("item/completed", {
      turnId: this.activeTurnId,
      item: {
        id: state.itemId,
        type: "agentMessage",
        text: finalText,
      },
    });
  }

  private toUserContent(message: JsonObject): Array<Record<string, unknown>> {
    const content = message.content;
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }

    if (!Array.isArray(content)) return [];

    const normalized: Array<Record<string, unknown>> = [];
    for (const entry of content) {
      const block = asRecord(entry);
      if (!block) continue;
      const type = normalizeToken(asString(block.type));
      if (type === "text") {
        const text = asString(block.text);
        if (text) {
          normalized.push({ type: "text", text });
        }
        continue;
      }
      if (type === "image") {
        normalized.push({ type: "image" });
        continue;
      }
      normalized.push({ type: type || "unknown" });
    }
    return normalized;
  }

  private handlePiToolExecutionStart(event: JsonObject): void {
    const callId = asString(event.toolCallId);
    if (!callId) return;
    const toolName = asString(event.toolName) ?? "tool";
    const args = asRecord(event.args);
    const command = toPiCommandString(toolName, args);
    this.toolStates.set(callId, {
      toolName,
      command,
      output: "",
    });

    this.emitNotification("item/started", {
      turnId: this.activeTurnId,
      item: {
        id: callId,
        type: "commandExecution",
        ...(command ? { command } : {}),
        source: toolName,
        status: "in_progress",
      },
    });
  }

  private handlePiToolExecutionUpdate(event: JsonObject): void {
    const callId = asString(event.toolCallId);
    if (!callId) return;

    const state = this.toolStates.get(callId);
    if (!state) return;

    const partialResult = asRecord(event.partialResult);
    const fullOutput = extractToolOutput(partialResult);
    const delta = extractDelta(state.output, fullOutput);
    if (!delta) return;

    state.output = fullOutput;
    this.emitNotification("item/commandExecution/outputDelta", {
      turnId: this.activeTurnId,
      itemId: callId,
      delta,
    });
  }

  private handlePiToolExecutionEnd(event: JsonObject): void {
    const callId = asString(event.toolCallId);
    if (!callId) return;

    const state = this.toolStates.get(callId);
    this.toolStates.delete(callId);

    const finalOutput = extractToolOutput(event.result) || state?.output || "";
    const trailingDelta = state ? extractDelta(state.output, finalOutput) : finalOutput;
    if (trailingDelta) {
      this.emitNotification("item/commandExecution/outputDelta", {
        turnId: this.activeTurnId,
        itemId: callId,
        delta: trailingDelta,
      });
    }

    const isError = event.isError === true;
    const exitCode = extractToolExitCode(event.result);
    this.emitNotification("item/completed", {
      turnId: this.activeTurnId,
      item: {
        id: callId,
        type: "commandExecution",
        ...(state?.command ? { command: state.command } : {}),
        source: state?.toolName,
        aggregatedOutput: finalOutput,
        ...(exitCode !== undefined ? { exitCode } : {}),
        status: isError ? "error" : "completed",
      },
    });
  }

  private sendPiCommand(command: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    return new Promise<JsonObject>((resolve, reject) => {
      void (async () => {
        await this.ensurePiProcess();
        if (!this.piProcess?.stdin) {
          reject(new Error("Pi process stdin is unavailable"));
          return;
        }

        const id = `pi-${++this.piRequestCounter}`;
        const commandType = asString(command.type) ?? "unknown";
        const payload = { ...command, id };

        const timeout = setTimeout(() => {
          this.pendingPiRequests.delete(id);
          reject(new Error(`Timed out waiting for Pi response to ${commandType}`));
        }, timeoutMs);

        this.pendingPiRequests.set(id, {
          command: commandType,
          resolve,
          reject,
          timeout,
        });

        this.piProcess.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
          if (!err) return;
          const pending = this.pendingPiRequests.get(id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.pendingPiRequests.delete(id);
          pending.reject(new Error(`Failed to write Pi command ${commandType}: ${err.message}`));
        });
      })().catch((err: unknown) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async shutdown(code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    this.stdinRl?.close();
    this.stdinRl = undefined;

    for (const [, pending] of this.pendingPiRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Bridge shutdown"));
    }
    this.pendingPiRequests.clear();

    if (this.piStdoutRl) {
      this.piStdoutRl.close();
      this.piStdoutRl = undefined;
    }
    if (this.piStderrRl) {
      this.piStderrRl.close();
      this.piStderrRl = undefined;
    }

    if (this.piProcess && this.piProcess.exitCode === null) {
      this.piProcess.kill("SIGTERM");
    }
    this.piProcess = undefined;

    process.exit(code);
  }
}

const bridge = new PiRpcBridge(parseCliOptions(process.argv.slice(2)));
bridge.start();
