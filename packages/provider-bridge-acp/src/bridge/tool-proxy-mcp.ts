import { dynamicToolSchema } from "@bb/domain";
import type { DynamicTool } from "@bb/domain";
import { buildBridgeToolCallContent as experimental_buildBridgeToolCallContent } from "@bb/provider-bridge-protocol/bridge-kit";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { z } from "zod";

export const ACP_BRIDGE_MCP_SERVER_NAME = "bb-bridge";

const ENV_HOST = "BB_ACP_DYNAMIC_TOOL_HOST";
const ENV_PORT = "BB_ACP_DYNAMIC_TOOL_PORT";
const ENV_TOKEN = "BB_ACP_DYNAMIC_TOOL_TOKEN";
const ENV_THREAD_ID = "BB_ACP_DYNAMIC_TOOL_THREAD_ID";
const ENV_TOOLS = "BB_ACP_DYNAMIC_TOOLS";
const ENV_PROGRESS_INTERVAL_MS = "BB_ACP_DYNAMIC_TOOL_PROGRESS_INTERVAL_MS";

export interface AcpMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

interface BuildAcpMcpServerConfigArgs {
  bridgeArgs: string[];
  command: string;
  dynamicTools: readonly DynamicTool[];
  host: string;
  port: number;
  runtimeEnv: { name: string; value: string }[];
  threadId: string;
  token: string;
}

interface BridgeRequestBase {
  threadId: string;
  token: string;
}

type BridgeRequest = BridgeRequestBase & BridgeRequestPayload;

type BridgeRequestPayload =
  | { kind: "initialized"; toolCount: number }
  | {
      kind: "toolCall";
      arguments: Record<string, unknown>;
      callId: string;
      tool: string;
    };

const bridgeToolCallResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    content: z.string(),
    contentBlocks: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({
            type: z.literal("image"),
            data: z.string(),
            mimeType: z.string(),
          }),
        ]),
      )
      .optional(),
    images: z
      .array(z.object({ data: z.string(), mimeType: z.string() }))
      .default([]),
    isError: z.boolean().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
type BridgeToolCallResponse = z.infer<typeof bridgeToolCallResponseSchema>;

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
}

interface McpServerEnvironment {
  host: string;
  port: number;
  progressIntervalMs: number | undefined;
  threadId: string;
  token: string;
  tools: DynamicTool[];
}

let nextMcpToolCallId = 0;

const TOOL_CALL_PROGRESS_INTERVAL_MS = 15_000;

export function buildAcpMcpServerConfig(
  args: BuildAcpMcpServerConfigArgs,
): AcpMcpServerConfig {
  return {
    name: ACP_BRIDGE_MCP_SERVER_NAME,
    command: args.command,
    args: args.bridgeArgs,
    env: [
      ...args.runtimeEnv,
      { name: ENV_HOST, value: args.host },
      { name: ENV_PORT, value: String(args.port) },
      { name: ENV_TOKEN, value: args.token },
      { name: ENV_THREAD_ID, value: args.threadId },
      { name: ENV_TOOLS, value: JSON.stringify(args.dynamicTools) },
    ],
  };
}

function readEnvironment(): McpServerEnvironment {
  const port = Number(process.env[ENV_PORT]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${ENV_PORT} must be a positive integer`);
  }
  const host = process.env[ENV_HOST];
  const token = process.env[ENV_TOKEN];
  const threadId = process.env[ENV_THREAD_ID];
  const toolsJson = process.env[ENV_TOOLS];
  if (!host || !token || !threadId || !toolsJson) {
    throw new Error("Missing ACP dynamic tool MCP server environment");
  }
  const parsedTools = JSON.parse(toolsJson) as unknown;
  const tools = dynamicToolSchema.array().parse(parsedTools);
  const rawProgressInterval = process.env[ENV_PROGRESS_INTERVAL_MS];
  const progressIntervalMs =
    rawProgressInterval !== undefined && Number(rawProgressInterval) > 0
      ? Number(rawProgressInterval)
      : undefined;
  return {
    host,
    port,
    progressIntervalMs,
    threadId,
    token,
    tools,
  };
}

function writeJson(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResult(id: string | number, result: unknown): void {
  writeJson({ jsonrpc: "2.0", id, result });
}

function writeError(id: string | number, code: number, message: string): void {
  writeJson({ jsonrpc: "2.0", id, error: { code, message } });
}

function mcpToolCallId(toolName: string): string {
  nextMcpToolCallId += 1;
  return `acp-mcp-${toolName}-${Date.now()}-${nextMcpToolCallId}`;
}

function callBridge(
  env: McpServerEnvironment,
  request: BridgeRequestPayload,
): Promise<BridgeToolCallResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: env.host, port: env.port });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const payload: BridgeRequest = {
        ...request,
        threadId: env.threadId,
        token: env.token,
      };
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      socket.end();
      try {
        resolve(bridgeToolCallResponseSchema.parse(JSON.parse(line)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (!buffer.includes("\n")) {
        reject(new Error("ACP dynamic tool bridge closed without a response"));
      }
    });
  });
}

function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function readProgressToken(params: unknown): string | number | null {
  const meta = objectParams(objectParams(params)._meta).progressToken;
  return typeof meta === "string" || typeof meta === "number" ? meta : null;
}

function startProgressHeartbeat(args: {
  intervalMs?: number;
  progressToken: string | number;
}): () => void {
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    writeJson({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: args.progressToken, progress },
    });
  }, args.intervalMs ?? TOOL_CALL_PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function handleRequest(
  env: McpServerEnvironment,
  message: JsonRpcMessage,
): Promise<void> {
  if (message.id === undefined || message.method === undefined) {
    return;
  }

  switch (message.method) {
    case "initialize":
      writeResult(message.id, {
        protocolVersion:
          typeof objectParams(message.params).protocolVersion === "string"
            ? objectParams(message.params).protocolVersion
            : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: ACP_BRIDGE_MCP_SERVER_NAME, version: "1.0.0" },
      });
      void callBridge(env, {
        kind: "initialized",
        toolCount: env.tools.length,
      }).catch((error) => {
        process.stderr.write(
          `bb-bridge MCP: failed to report initialize: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
      return;

    case "tools/list":
      writeResult(message.id, {
        tools: env.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;

    case "tools/call": {
      const params = objectParams(message.params);
      const name = typeof params.name === "string" ? params.name : "";
      const tool = env.tools.find((candidate) => candidate.name === name);
      if (!tool) {
        writeError(message.id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const rawArguments = params.arguments;
      const toolArguments =
        rawArguments &&
        typeof rawArguments === "object" &&
        !Array.isArray(rawArguments)
          ? (rawArguments as Record<string, unknown>)
          : {};
      const progressToken = readProgressToken(message.params);
      const stopHeartbeat =
        progressToken === null
          ? () => {}
          : startProgressHeartbeat({
              intervalMs: env.progressIntervalMs,
              progressToken,
            });
      try {
        const result = await callBridge(env, {
          kind: "toolCall",
          arguments: toolArguments,
          callId: mcpToolCallId(tool.name),
          tool: tool.name,
        });
        stopHeartbeat();
        if (!result.ok) {
          writeResult(message.id, {
            content: [{ type: "text", text: result.error }],
            isError: true,
          });
          return;
        }
        writeResult(message.id, {
          content: experimental_buildBridgeToolCallContent(result),
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (error) {
        stopHeartbeat();
        writeResult(message.id, {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        });
      }
      return;
    }

    default:
      writeError(
        message.id,
        -32601,
        `Unsupported MCP method: ${message.method}`,
      );
  }
}

export function runAcpDynamicToolMcpServer(): void {
  const env = readEnvironment();
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    void handleRequest(env, message);
  });
}
