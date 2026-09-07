import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAcpMcpServerConfig } from "./tool-proxy-mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE_MODULE = resolve(here, "bridge.ts");
const TSX_LOADER = import.meta.resolve("tsx");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function listenFakeBridge(args: {
  responseDelayMs: number;
  response?: unknown;
}): Promise<{ port: number; server: Server; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as {
        kind?: unknown;
      };
      if (request.kind === "initialized") {
        socket.end(`${JSON.stringify({ ok: true, content: "" })}\n`);
        return;
      }
      requests.push(request);
      const response = args.response ?? {
        ok: true,
        content: '{"answers":{"Which?":"B"}}',
      };
      setTimeout(() => {
        socket.end(`${JSON.stringify(response)}\n`);
      }, args.responseDelayMs);
    });
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake bridge did not bind a port");
  }
  return { port: address.port, server, requests };
}

async function connectLikeOpenCode(port: number): Promise<Client> {
  const config = buildAcpMcpServerConfig({
    bridgeArgs: [
      "--conditions=source",
      "--import",
      TSX_LOADER,
      BRIDGE_MODULE,
      "--mcp-stdio",
    ],
    command: process.execPath,
    dynamicTools: [
      {
        name: "AskUserQuestion",
        description: "Ask the user a question.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    host: "127.0.0.1",
    port,
    runtimeEnv: [],
    threadId: "thread-ask",
    token: "secret-token",
  });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const { name, value } of config.env) env[name] = value;
  env.BB_ACP_DYNAMIC_TOOL_PROGRESS_INTERVAL_MS = "200";
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "opencode-like", version: "0" });
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[bb-bridge mcp] ${chunk.toString()}`);
  });
  cleanups.push(() => client.close());
  return client;
}

describe("bb-bridge MCP server keeps long tool calls alive", () => {
  it("sends progress notifications so an OpenCode-style client does not time out while the user answers", async () => {
    const fakeBridge = await listenFakeBridge({ responseDelayMs: 2_500 });
    const client = await connectLikeOpenCode(fakeBridge.port);

    let progressCount = 0;
    const result = await client.callTool(
      {
        name: "AskUserQuestion",
        arguments: { questions: [] },
      },
      CallToolResultSchema,
      {
        timeout: 1_000,
        resetTimeoutOnProgress: true,
        onprogress: () => {
          progressCount += 1;
        },
      },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "text", text: '{"answers":{"Which?":"B"}}' },
    ]);
    expect(progressCount).toBeGreaterThan(0);
    expect(fakeBridge.requests).toHaveLength(1);
  }, 20_000);

  it("relays an image-only result as an MCP image block", async () => {
    const fakeBridge = await listenFakeBridge({
      responseDelayMs: 0,
      response: {
        ok: true,
        content: "",
        contentBlocks: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        ],
        images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      },
    });
    const client = await connectLikeOpenCode(fakeBridge.port);

    const result = await client.callTool(
      { name: "AskUserQuestion", arguments: {} },
      CallToolResultSchema,
      { timeout: 5_000 },
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
  }, 20_000);
});
