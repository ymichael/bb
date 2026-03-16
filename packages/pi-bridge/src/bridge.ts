#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  translatePiEvent,
  resetTurnCounter,
  type JsonRpcNotification,
} from "./event-translator.js";

export const BRIDGE_METHODS = [
  "initialize",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/steer",
  "thread/stop",
] as const;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

let piProcess: ChildProcess | undefined;
let currentThreadId: string | undefined;
let currentTurnId: string | undefined;
let piStdoutBuffer = "";

function send(msg: JsonRpcResponse | JsonRpcNotification): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id: string | number, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: string | number, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendToPi(command: Record<string, unknown>): void {
  if (!piProcess?.stdin?.writable) return;
  piProcess.stdin.write(JSON.stringify(command) + "\n");
}

function onPiOutput(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }

  // Skip pi's command responses — we already sent our JSON-RPC response
  if (parsed.type === "response") return;

  if (!currentThreadId) return;

  const { notifications, turnId } = translatePiEvent(
    parsed,
    currentThreadId,
    currentTurnId,
  );
  currentTurnId = turnId;

  for (const notification of notifications) {
    send(notification);
  }
}

function startPiProcess(
  cwd: string,
  model?: string,
  env?: NodeJS.ProcessEnv,
): void {
  if (piProcess) {
    piProcess.kill();
    piProcess = undefined;
  }

  const args = ["--mode", "rpc", "--no-session"];
  if (model) {
    args.push("--model", model);
  }

  piProcess = spawn("pi", args, {
    cwd,
    env: env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Read pi's stdout line by line using raw buffer splitting (not readline,
  // which splits on U+2028/U+2029 — pi's docs warn against this).
  piProcess.stdout?.on("data", (chunk: Buffer) => {
    piStdoutBuffer += chunk.toString("utf8");
    while (true) {
      const idx = piStdoutBuffer.indexOf("\n");
      if (idx === -1) break;
      let line = piStdoutBuffer.slice(0, idx);
      piStdoutBuffer = piStdoutBuffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onPiOutput(line);
    }
  });

  piProcess.on("exit", () => {
    piProcess = undefined;
  });
}

function handleRequest(request: JsonRpcRequest): void {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      sendResult(id, { ok: true });
      break;

    case "thread/start":
      handleThreadStart(id, params ?? {});
      break;

    case "thread/resume":
      handleThreadResume(id, params ?? {});
      break;

    case "turn/start":
      handleTurnStart(id, params ?? {});
      break;

    case "turn/steer":
      handleTurnSteer(id, params ?? {});
      break;

    case "thread/stop":
      handleThreadStop(id);
      break;

    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

function handleThreadStart(
  id: string | number,
  params: Record<string, unknown>,
): void {
  resetTurnCounter();
  currentTurnId = undefined;

  const cwd =
    typeof params.cwd === "string" ? params.cwd : process.cwd();
  const model =
    typeof params.model === "string" ? params.model : undefined;

  const envOverrides: Record<string, string> = {};
  const config = params.config as Record<string, unknown> | undefined;
  if (config) {
    for (const [key, value] of Object.entries(config)) {
      if (
        key.startsWith("shell_environment_policy.set.") &&
        typeof value === "string"
      ) {
        const envVar = key.slice("shell_environment_policy.set.".length);
        envOverrides[envVar] = value;
      }
    }
  }

  const piEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...envOverrides,
  };

  startPiProcess(cwd, model, piEnv);

  currentThreadId = `pi-${Date.now()}`;

  // Send the initial prompt
  const input = extractInputText(params.input);
  if (input) {
    sendToPi({ type: "prompt", message: input });
  }

  sendResult(id, { threadId: currentThreadId });
}

function handleThreadResume(
  id: string | number,
  params: Record<string, unknown>,
): void {
  const threadId =
    typeof params.threadId === "string" ? params.threadId : undefined;

  resetTurnCounter();
  currentTurnId = undefined;
  currentThreadId = threadId ?? `pi-${Date.now()}`;

  const cwd =
    typeof params.cwd === "string" ? params.cwd : process.cwd();
  const model =
    typeof params.model === "string" ? params.model : undefined;

  // Pi doesn't have a built-in resume mechanism via RPC, so we start a fresh
  // session. The Beanbag daemon tracks conversation state externally.
  startPiProcess(cwd, model);

  sendResult(id, { threadId: currentThreadId });
}

function handleTurnStart(
  id: string | number,
  params: Record<string, unknown>,
): void {
  if (!piProcess) {
    sendError(id, -32000, "No active pi process");
    return;
  }

  const input = extractInputText(params.input);
  if (!input) {
    sendError(id, -32602, "Missing input text");
    return;
  }

  sendToPi({ type: "prompt", message: input });
  sendResult(id, { threadId: currentThreadId });
}

function handleTurnSteer(
  id: string | number,
  params: Record<string, unknown>,
): void {
  if (!piProcess) {
    sendError(id, -32000, "No active pi process");
    return;
  }

  const input = extractInputText(params.input);
  if (!input) {
    sendError(id, -32602, "Missing input text");
    return;
  }

  sendToPi({ type: "steer", message: input });
  sendResult(id, { threadId: currentThreadId });
}

function handleThreadStop(id: string | number): void {
  if (piProcess) {
    sendToPi({ type: "abort" });
    piProcess.kill();
    piProcess = undefined;
  }
  currentTurnId = undefined;
  sendResult(id, { ok: true });
}

function extractInputText(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return undefined;

  const chunks: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const typed = item as { type?: string; text?: string };
    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
    }
  }

  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const request = parsed as JsonRpcRequest;
  if (
    !request ||
    typeof request !== "object" ||
    request.jsonrpc !== "2.0" ||
    typeof request.method !== "string"
  ) {
    return;
  }

  handleRequest(request);
}

// Main entry point
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", handleLine);
rl.on("close", () => {
  if (piProcess) {
    piProcess.kill();
  }
  process.exit(0);
});
