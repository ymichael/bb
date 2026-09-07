import { afterEach, beforeEach, expect, vi } from "vitest";
import { Command } from "commander";
import { createApiClient, type ApiClient } from "@bb/server-contract";

const readlineState = vi.hoisted(() => ({
  question: vi.fn(),
  close: vi.fn(),
}));

const serverClientState = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("../../client.js", async () => {
  const { cliFetch } =
    await vi.importActual<typeof import("../../client.js")>("../../client.js");
  const { createBbSdk } =
    await vi.importActual<typeof import("@bb/sdk/core")>("@bb/sdk/core");
  const { createHttpTransport } =
    await vi.importActual<typeof import("@bb/sdk/node")>("@bb/sdk/node");
  const toResponse = (resolved: MockTransportResolved): Response =>
    resolved instanceof Response
      ? resolved
      : new Response(JSON.stringify(resolved), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
  const createCliBbSdk = vi.fn((baseUrl: string) => {
    const realTransport = createHttpTransport({ baseUrl, runtime: "node" });
    return createBbSdk({
      transport: {
        ...realTransport,
        api: serverClientState.createClient(baseUrl)?.api ?? {},
        readJson: (responsePromise: MockTransportPromise) =>
          realTransport.readJson(responsePromise.then(toResponse)),
        readVoid: (responsePromise: MockTransportPromise) =>
          realTransport.readVoid(responsePromise.then(toResponse)),
      },
    });
  });
  return { cliFetch, createCliBbSdk };
});

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: readlineState.question,
    close: readlineState.close,
  })),
}));

vi.mock("../../daemon.js", () => ({
  resolveLocalHostId: vi.fn(async () => "host-test-001"),
}));

import { resolveLocalHostId } from "../../daemon.js";

type ServerClient = ApiClient;
type MockTransportResolved =
  | Response
  | object
  | string
  | number
  | boolean
  | null
  | undefined;
type MockTransportPromise = Promise<MockTransportResolved>;
type ConsoleLogArgs = Parameters<typeof console.log>;
export type CommandRegistrar = (program: Command) => void;

interface ServerClientOverride {
  api: object;
}

export const createClientMock = serverClientState.createClient;
export const readlineMocks = readlineState;
export const resolveLocalHostIdMock = vi.mocked(resolveLocalHostId);

export function setupCommandOutputTestEnvironment(): void {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit:${code ?? 0}`);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    createClientMock.mockReset();
    resolveLocalHostIdMock.mockClear();
    resolveLocalHostIdMock.mockResolvedValue("host-test-001");
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    readlineState.question.mockReset();
    readlineState.close.mockReset();

    vi.stubEnv("BB_PROJECT_ID", undefined);
    vi.stubEnv("BB_THREAD_ID", undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
}

function asServerClient(value: ServerClientOverride): ServerClient {
  return Object.assign(createApiClient("http://server"), value);
}

type ApiStubHandler = (
  ...args: never[]
) => MockTransportResolved | MockTransportPromise;
interface ApiStubNode {
  [segment: string]: ApiStubNode | ApiStubHandler;
}

export function stubServerApi(handlers: Record<string, ApiStubHandler>): void {
  const api: ApiStubNode = {};
  for (const [path, handler] of Object.entries(handlers)) {
    const segments = path.split(".");
    let node = api;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      const existing = node[segment];
      const child: ApiStubNode = typeof existing === "object" ? existing : {};
      node[segment] = child;
      node = child;
    }
    node[segments[segments.length - 1]] = handler;
  }
  createClientMock.mockReturnValue(asServerClient({ api }));
}

export function collectLogLines(logSpy: ReturnType<typeof vi.spyOn>): string[] {
  return logSpy.mock.calls.map((args: ConsoleLogArgs) => args.join(" "));
}

export function collectLogPayloads(
  logSpy: ReturnType<typeof vi.spyOn>,
): string[] {
  return logSpy.mock.calls.map((args: ConsoleLogArgs) => String(args[0] ?? ""));
}

export async function runCommand(
  args: string[],
  register: CommandRegistrar,
): Promise<void> {
  const program = new Command();
  register(program);
  await program.parseAsync(["node", "bb", ...args]);
}

export async function getHelpOutput(
  args: string[],
  register: CommandRegistrar,
): Promise<string> {
  const program = new Command();
  const writeOut = vi.fn();
  program.exitOverride();
  program.configureOutput({
    writeOut,
    writeErr: vi.fn(),
  });
  register(program);

  await expect(
    program.parseAsync(["node", "bb", ...args, "--help"]),
  ).rejects.toMatchObject({
    code: "commander.helpDisplayed",
  });

  return writeOut.mock.calls
    .map((callArgs) => String(callArgs[0] ?? ""))
    .join("");
}
