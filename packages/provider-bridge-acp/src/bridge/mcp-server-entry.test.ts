import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ACP_BRIDGE_MCP_SERVER_NAME } from "./tool-proxy-mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE_MODULE = resolve(here, "bridge.ts");
const FAKE_AGENT_PATH = resolve(here, "fake-acp-agent.mjs");
const WORKER_ENTRY = fileURLToPath(
  import.meta.resolve("@bb/provider-bridge-protocol/bridge-worker-entry"),
);
const TSX_LOADER = import.meta.resolve("tsx");

interface BridgeLine {
  id?: number | string;
  method?: string;
  params?: {
    deltas?: { kind?: string; channel?: string; text?: unknown }[];
  };
  result?: { providerThreadId?: unknown };
  error?: { message?: string };
}

interface AdvertisedMcpServer {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

const children: ChildProcess[] = [];
const tempDirs: string[] = [];
const bridgeLines: BridgeLine[] = [];
let bridgeStderr = "";
let nextRequestId = 1;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitFor<T>(
  pick: () => T | undefined,
  what: string,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = pick();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

function agentMessageTexts(): string[] {
  const texts: string[] = [];
  for (const line of bridgeLines) {
    if (line.method !== "thread/delta") {
      continue;
    }
    for (const delta of line.params?.deltas ?? []) {
      if (delta.kind === "item.textDelta" && delta.channel === "agentMessage") {
        texts.push(String(delta.text));
      }
    }
  }
  return texts;
}

function spawnBridgeLikeTheAgentRuntime(dataDir: string): ChildProcess {
  const bridge = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      TSX_LOADER,
      WORKER_ENTRY,
      BRIDGE_MODULE,
      "provider-acp",
      dataDir,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(bridge);
  bridge.stderr?.on("data", (chunk: Buffer) => {
    bridgeStderr += chunk.toString();
    process.stderr.write(`[bridge] ${chunk.toString()}`);
  });
  if (!bridge.stdout) {
    throw new Error("Bridge child has no stdout");
  }
  createInterface({ input: bridge.stdout }).on("line", (line) => {
    try {
      bridgeLines.push(JSON.parse(line) as BridgeLine);
    } catch {}
  });
  return bridge;
}

function sendToBridge(
  bridge: ChildProcess,
  method: string,
  params: unknown,
): number {
  const id = nextRequestId++;
  if (!bridge.stdin) {
    throw new Error("Bridge child has no stdin");
  }
  bridge.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
  );
  return id;
}

async function readAdvertisedMcpServer(
  bridge: ChildProcess,
  workspaceDir: string,
): Promise<AdvertisedMcpServer> {
  const startId = sendToBridge(bridge, "thread/start", {
    threadId: "thread-1918",
    cwd: workspaceDir,
    instructionMode: "append",
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
      providerOptions: {
        acpLaunchSpec: {
          displayName: "Fake ACP",
          command: process.execPath,
          args: [FAKE_AGENT_PATH],
          env: {},
        },
      },
    },
    dynamicTools: [
      {
        name: "update_environment_directory",
        description: "Move this thread to another environment directory.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  });
  const startResponse = await waitFor(
    () =>
      bridgeLines.find(
        (line) => line.id === startId && line.method === undefined,
      ),
    "thread/start response",
  );
  expect(startResponse.error).toBeUndefined();
  const providerThreadId = String(startResponse.result?.providerThreadId);

  sendToBridge(bridge, "turn/start", {
    threadId: "thread-1918",
    providerThreadId,
    clientRequestId: "creq_abcdefghjk",
    options: {
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    input: [{ type: "text", text: "echo-mcp-server-config", mentions: [] }],
  });
  const configPrefix = "mcp-server-config:";
  const configText = await waitFor(
    () => agentMessageTexts().find((text) => text.startsWith(configPrefix)),
    "mcp-server-config echo",
  );
  const [config] = JSON.parse(
    configText.slice(configPrefix.length),
  ) as AdvertisedMcpServer[];
  if (!config) {
    throw new Error("Fake ACP agent reported no MCP server config");
  }
  return config;
}

async function runMcpInitialize(config: AdvertisedMcpServer): Promise<{
  exitCode: number | null | undefined;
  stderr: string;
  stdoutLines: string[];
}> {
  const env = { ...process.env };
  for (const { name, value } of config.env) {
    env[name] = value;
  }
  const mcp = spawn(config.command, config.args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(mcp);
  let stderr = "";
  mcp.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const stdoutLines: string[] = [];
  if (!mcp.stdout || !mcp.stdin) {
    throw new Error("MCP child has no stdio");
  }
  createInterface({ input: mcp.stdout }).on("line", (line) =>
    stdoutLines.push(line),
  );
  let exitCode: number | null | undefined;
  mcp.on("exit", (code) => {
    exitCode = code;
  });
  mcp.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "bb-test", version: "0" },
      },
    })}\n`,
  );
  await waitFor(
    () => (stdoutLines.length > 0 || exitCode !== undefined ? true : undefined),
    "MCP initialize response or child exit",
    15_000,
  );
  return { exitCode, stderr, stdoutLines };
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  bridgeLines.length = 0;
  bridgeStderr = "";
});

describe("bb-bridge MCP server entry point (#1918)", () => {
  it("advertises an MCP server command that answers MCP initialize when the bridge runs under the bootstrap", async () => {
    const dataDir = makeTempDir("bb-acp-mcp-entry-data-");
    const workspaceDir = makeTempDir("bb-acp-mcp-entry-ws-");
    const bridge = spawnBridgeLikeTheAgentRuntime(dataDir);

    const config = await readAdvertisedMcpServer(bridge, workspaceDir);
    expect(config.name).toBe(ACP_BRIDGE_MCP_SERVER_NAME);
    expect(config.args).toContain("--mcp-stdio");

    const { exitCode, stderr, stdoutLines } = await runMcpInitialize(config);
    expect(stderr).not.toMatch(/provider bridge bootstrap usage/u);
    expect(exitCode).toBeUndefined();
    expect(stdoutLines[0]).toContain(
      `"serverInfo":{"name":"${ACP_BRIDGE_MCP_SERVER_NAME}"`,
    );
    await waitFor(
      () =>
        bridgeStderr.includes(
          `"${ACP_BRIDGE_MCP_SERVER_NAME}" answered initialize`,
        )
          ? true
          : undefined,
      "bridge-side MCP initialize diagnostic",
    );
    expect(config.args.some((arg) => arg.includes("bridge-worker"))).toBe(
      false,
    );
  }, 60_000);
});
