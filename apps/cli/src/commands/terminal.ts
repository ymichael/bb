import { Buffer } from "node:buffer";
import { Command } from "commander";
import { TERMINAL_DATA_MAX_BYTES } from "@bb/domain";
import {
  BbHttpError,
  type BbSdk,
  type TerminalCreateScope,
  type TerminalListScope,
} from "@bb/sdk";
import { createNodeWebsocketFactory } from "@bb/sdk/node-websocket";
import {
  terminalServerMessageSchema,
  type TerminalSession,
} from "@bb/server-contract";
import { action, CliExitError } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";
import { resolveMachineHostId, resolveMachineTargetOption } from "./machine.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERMINAL_WAIT_TIMEOUT_EXIT_CODE = 124;

interface TerminalJsonOptions {
  json?: boolean;
}

interface TerminalScopeOptions {
  cwd?: string;
  environment?: string;
  host?: string;
  machine?: string;
  thread?: string;
}

interface TerminalListOptions
  extends TerminalJsonOptions, TerminalScopeOptions {}

interface TerminalStartOptions
  extends TerminalJsonOptions, TerminalScopeOptions {
  attach?: boolean;
  command?: string;
  cols?: string;
  rows?: string;
  title?: string;
}

interface TerminalSendOptions extends TerminalJsonOptions {
  enter?: boolean;
  stdin?: boolean;
  text?: string;
}

interface TerminalResizeOptions extends TerminalJsonOptions {
  cols: string;
  rows: string;
}

interface TerminalOutputOptions extends TerminalJsonOptions {
  limitChunks?: string;
  sinceSeq?: string;
  tailBytes?: string;
}

interface TerminalWaitOptions extends TerminalOutputOptions {
  contains?: string;
  exit?: boolean;
  fromStart?: boolean;
  pollInterval?: string;
  regex?: string;
  timeout?: string;
}

interface TerminalCloseOptions extends TerminalJsonOptions {
  ifClean?: boolean;
}

interface TerminalStartResolution {
  command: string | null;
}

export function registerTerminalCommands(
  program: Command,
  getUrl: () => string,
): void {
  const terminal = program
    .command("terminal")
    .description(
      "Manage terminal sessions across threads, environments, and machines",
    );

  addTerminalScopeOptions(
    terminal
      .command("list")
      .description("List terminal sessions in exactly one scope")
      .option("--json", "Print machine-readable JSON output"),
  ).action(
    action(async (opts: TerminalListOptions) => {
      const sdk = createCliBbSdk(getUrl());
      const result = await sdk.terminals.list({
        scope: await resolveTerminalListScope(opts, getUrl()),
      });
      if (outputJson(opts, result)) return;
      printTerminalTable(result.sessions);
    }),
  );

  addTerminalScopeOptions(
    terminal
      .command("create [command...]")
      .alias("start")
      .description("Create a terminal session in exactly one scope")
      .option("--title <title>", "Terminal title")
      .option(
        "--command <command>",
        "Command to run instead of an interactive shell",
      )
      .option("--cols <n>", "Initial terminal columns")
      .option("--rows <n>", "Initial terminal rows")
      .option("--attach", "Attach after creating")
      .option("--json", "Print machine-readable JSON output"),
  ).action(
    action(async (commandParts: string[], opts: TerminalStartOptions) => {
      const sdk = createCliBbSdk(getUrl());
      const resolvedStart = resolveTerminalStart({
        commandOption: opts.command,
        commandParts,
      });
      const session = await sdk.terminals.create({
        cols: parsePositiveInteger(opts.cols, DEFAULT_COLS, "--cols"),
        rows: parsePositiveInteger(opts.rows, DEFAULT_ROWS, "--rows"),
        scope: await resolveTerminalCreateScope(opts, getUrl()),
        title: opts.title,
        start:
          resolvedStart.command === null
            ? { mode: "shell" }
            : { mode: "command", command: resolvedStart.command },
      });
      if (outputJson(opts, session)) return;
      console.log(`Created terminal ${session.id} (${session.title})`);
      if (opts.attach) {
        await attachTerminal({
          baseUrl: getUrl(),
          terminalId: session.id,
        });
      }
    }),
  );

  terminal
    .command("show <terminalId>")
    .description("Show a terminal session")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalJsonOptions) => {
        const session = await createCliBbSdk(getUrl()).terminals.get({
          terminalId,
        });
        if (outputJson(opts, session)) return;
        console.log(JSON.stringify(session, null, 2));
      }),
    );

  terminal
    .command("attach <terminalId>")
    .description("Attach to a running terminal session")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalJsonOptions) => {
        if (opts.json) {
          const session = await createCliBbSdk(getUrl()).terminals.get({
            terminalId,
          });
          outputJson(opts, session);
          return;
        }
        await attachTerminal({
          baseUrl: getUrl(),
          terminalId,
        });
      }),
    );

  terminal
    .command("send <terminalId>")
    .description("Send input to a terminal session")
    .option("--text <text>", "Text to send")
    .option("--stdin", "Read bytes from stdin")
    .option("--enter", "Append a newline")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalSendOptions) => {
        const data = await resolveSendData(opts);
        const sdk = createCliBbSdk(getUrl());
        let session: TerminalSession | null = null;
        for (const chunk of chunkTerminalInput(data)) {
          session = await sdk.terminals.input({
            terminalId,
            dataBase64: chunk.toString("base64"),
          });
        }
        if (session === null) {
          throw new CliExitError("Terminal input cannot be empty", 1);
        }
        if (outputJson(opts, session)) return;
        console.log(`Sent input to terminal ${terminalId}`);
      }),
    );

  terminal
    .command("resize <terminalId>")
    .description("Resize a terminal session")
    .requiredOption("--cols <n>", "Terminal columns")
    .requiredOption("--rows <n>", "Terminal rows")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalResizeOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const session = await sdk.terminals.resize({
          terminalId,
          cols: parseRequiredPositiveInteger(opts.cols, "--cols"),
          rows: parseRequiredPositiveInteger(opts.rows, "--rows"),
        });
        if (outputJson(opts, session)) return;
        console.log(
          `Resized terminal ${terminalId} to ${session.cols}x${session.rows}`,
        );
      }),
    );

  terminal
    .command("output <terminalId>")
    .description("Print terminal output from daemon scrollback")
    .option("--since-seq <n>", "Only output chunks from this sequence")
    .option("--tail-bytes <n>", "Bound output to the latest N bytes")
    .option("--limit-chunks <n>", "Bound output to the latest N chunks")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalOutputOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const output = await sdk.terminals.output({
          terminalId,
          ...terminalOutputQuery(opts),
        });
        if (outputJson(opts, output)) return;
        writeOutputChunks(output.chunks);
      }),
    );

  terminal
    .command("wait <terminalId>")
    .description("Wait for terminal output or exit")
    .option("--contains <text>", "Wait until output contains text")
    .option(
      "--regex <pattern>",
      "Wait until output matches a regular expression",
    )
    .option("--exit", "Wait until the terminal exits")
    .option("--from-start", "Include existing scrollback from sequence 0")
    .option("--timeout <seconds>", "Timeout in seconds", "30")
    .option("--poll-interval <ms>", "Polling interval in milliseconds", "500")
    .option("--tail-bytes <n>", "Bound each output poll to N bytes")
    .option("--limit-chunks <n>", "Bound each output poll to N chunks")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalWaitOptions) => {
        const result = await waitForTerminal({
          baseUrl: getUrl(),
          opts,
          terminalId,
        });
        if (outputJson(opts, result)) return;
        console.log(`Terminal ${terminalId} matched ${result.matched}`);
      }),
    );

  terminal
    .command("rename <terminalId> <title>")
    .description("Rename a terminal session")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          terminalId: string,
          title: string,
          opts: TerminalJsonOptions,
        ) => {
          const session = await createCliBbSdk(getUrl()).terminals.rename({
            terminalId,
            title,
          });
          if (outputJson(opts, session)) return;
          console.log(`Renamed terminal ${terminalId} to ${session.title}`);
        },
      ),
    );

  terminal
    .command("restart <terminalId>")
    .description("Replace a terminal with a shell in the same scope")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalJsonOptions) => {
        const session = await createCliBbSdk(getUrl()).terminals.restart({
          terminalId,
        });
        if (outputJson(opts, session)) return;
        console.log(`Restarted terminal ${terminalId} as ${session.id}`);
      }),
    );

  terminal
    .command("close <terminalId>")
    .alias("stop")
    .description("Close a terminal session")
    .option("--if-clean", "Only close if no user input was sent")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (terminalId: string, opts: TerminalCloseOptions) => {
        const session = await createCliBbSdk(getUrl()).terminals.close({
          terminalId,
          mode: opts.ifClean ? "if-clean" : "force",
        });
        if (outputJson(opts, session)) return;
        console.log(`Closed terminal ${terminalId}`);
      }),
    );
}

function addTerminalScopeOptions(command: Command): Command {
  return command
    .option("--thread <id>", "Thread-scoped terminal")
    .option("--environment <id>", "Environment-scoped terminal")
    .option("--machine <id-or-name>", "Machine-scoped terminal")
    .option("--host <id-or-name>", "Alias for --machine")
    .option("--cwd <path>", "Working directory for --machine or --host");
}

async function resolveTerminalListScope(
  opts: TerminalScopeOptions,
  serverUrl: string,
): Promise<TerminalListScope> {
  const machine = resolveTerminalMachineSelector(opts);
  assertExactlyOneTerminalScope({
    environment: opts.environment,
    machine,
    thread: opts.thread,
  });
  if (opts.cwd !== undefined && machine === undefined) {
    throw new Error("--cwd can only be used with --machine or --host.");
  }
  if (opts.thread !== undefined) {
    return { kind: "thread", threadId: opts.thread };
  }
  if (opts.environment !== undefined) {
    return { kind: "environment", environmentId: opts.environment };
  }
  return {
    kind: "host_path",
    hostId: await resolveMachineHostId({
      serverUrl,
      target: machine ?? "",
    }),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  };
}

async function resolveTerminalCreateScope(
  opts: TerminalScopeOptions,
  serverUrl: string,
): Promise<TerminalCreateScope> {
  const scope = await resolveTerminalListScope(opts, serverUrl);
  if (scope.kind !== "host_path") return scope;
  return { ...scope, cwd: scope.cwd ?? null };
}

function resolveTerminalMachineSelector(
  opts: TerminalScopeOptions,
): string | undefined {
  return resolveMachineTargetOption({
    machine: opts.machine,
    host: opts.host,
  });
}

function assertExactlyOneTerminalScope(args: {
  environment?: string;
  machine?: string;
  thread?: string;
}): void {
  const count = [args.thread, args.environment, args.machine].filter(
    (value) => value !== undefined,
  ).length;
  if (count !== 1) {
    throw new Error(
      "Provide exactly one terminal scope: --thread, --environment, or --machine/--host.",
    );
  }
}

function resolveTerminalStart(args: {
  commandOption?: string;
  commandParts: readonly string[];
}): TerminalStartResolution {
  if (args.commandOption !== undefined && args.commandParts.length > 0) {
    throw new Error(
      "Provide either --command or positional command args, not both",
    );
  }
  if (args.commandOption !== undefined) {
    const command = args.commandOption.trim();
    if (command.length === 0) {
      throw new Error("--command must not be empty");
    }
    return { command };
  }
  if (args.commandParts.length > 0) {
    return {
      command: args.commandParts.map(shellQuoteArg).join(" "),
    };
  }
  return { command: null };
}

function shellQuoteArg(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  return parseRequiredPositiveInteger(value, label);
}

function parseRequiredPositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export async function resolveSendData(
  opts: TerminalSendOptions,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<Buffer> {
  if (opts.text !== undefined && opts.stdin) {
    throw new Error("Provide only one of --text or --stdin");
  }
  if (opts.text === undefined && !opts.stdin) {
    throw new Error("Provide one of --text or --stdin");
  }
  const baseData =
    opts.text !== undefined
      ? Buffer.from(opts.text, "utf8")
      : await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
          stdin.on("error", reject);
          stdin.on("end", () => resolve(Buffer.concat(chunks)));
        });
  return opts.enter
    ? Buffer.concat([baseData, Buffer.from("\n", "utf8")])
    : baseData;
}

function terminalOutputQuery(opts: TerminalOutputOptions) {
  return {
    ...(opts.sinceSeq !== undefined
      ? { sinceSeq: parseNonNegativeInteger(opts.sinceSeq, "--since-seq") }
      : {}),
    ...(opts.tailBytes !== undefined
      ? {
          tailBytes: parseRequiredPositiveInteger(
            opts.tailBytes,
            "--tail-bytes",
          ),
        }
      : {}),
    ...(opts.limitChunks !== undefined
      ? {
          limitChunks: parseRequiredPositiveInteger(
            opts.limitChunks,
            "--limit-chunks",
          ),
        }
      : {}),
  };
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function printTerminalTable(sessions: TerminalSession[]): void {
  if (sessions.length === 0) {
    console.log("No terminal sessions found");
    return;
  }
  const rows = sessions.map((session) => [
    session.id,
    session.title,
    session.status,
    `${session.cols}x${session.rows}`,
  ]);
  const colWidths = [12, 24, 14, 10].map((minWidth, index) =>
    Math.max(minWidth, ...rows.map((row) => row[index].length)),
  );
  console.log("");
  console.log(
    renderBorderlessTable(
      {
        head: ["ID", "Title", "Status", "Size"],
        colWidths,
      },
      rows,
    ),
  );
  console.log("");
}

function writeOutputChunks(
  chunks: readonly { dataBase64: string; seq: number }[],
): void {
  for (const chunk of chunks) {
    process.stdout.write(Buffer.from(chunk.dataBase64, "base64"));
  }
}

function terminalWebsocketUrl(args: {
  baseUrl: string;
  terminalId: string;
}): string {
  const url = new URL(args.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/ws/terminals/${encodeURIComponent(
    args.terminalId,
  )}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

async function attachTerminal(args: {
  baseUrl: string;
  terminalId: string;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Attach requires an interactive terminal");
  }

  const socket = createNodeWebsocketFactory()(
    terminalWebsocketUrl({
      baseUrl: args.baseUrl,
      terminalId: args.terminalId,
    }),
  );
  let detachPrefix = false;
  const previousRawMode = process.stdin.isRaw;
  const onInput = (chunk: Buffer) => {
    if (chunk.length === 1 && chunk[0] === 0x02) {
      detachPrefix = true;
      return;
    }
    if (detachPrefix) {
      detachPrefix = false;
      if (chunk.length === 1 && chunk[0] === 0x64) {
        socket.close();
        return;
      }
      sendTerminalInput(socket, Buffer.from([0x02]));
    }
    sendTerminalInput(socket, chunk);
  };
  const onResize = () => {
    socket.send(
      JSON.stringify({
        type: "resize",
        cols: process.stdout.columns || DEFAULT_COLS,
        rows: process.stdout.rows || DEFAULT_ROWS,
      }),
    );
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      onResize();
    };
    socket.onerror = () => reject(new Error("Terminal websocket failed"));
    socket.onclose = () => resolve();
    socket.onmessage = (event) => {
      const message = terminalServerMessageSchema.parse(
        JSON.parse(String(event.data)),
      );
      switch (message.type) {
        case "attached":
        case "pong":
        case "session-updated":
          return;
        case "output":
          process.stdout.write(Buffer.from(message.chunk.dataBase64, "base64"));
          return;
        case "exited":
          socket.close();
          return;
        case "error":
          reject(new Error(message.message));
          return;
      }
    };
    process.stdin.on("data", onInput);
    process.stdout.on("resize", onResize);
  }).finally(() => {
    process.stdin.off("data", onInput);
    process.stdout.off("resize", onResize);
    process.stdin.setRawMode(previousRawMode);
    process.stdin.pause();
  });
}

function chunkTerminalInput(data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (
    let offset = 0;
    offset < data.byteLength;
    offset += TERMINAL_DATA_MAX_BYTES
  ) {
    chunks.push(
      data.subarray(
        offset,
        Math.min(offset + TERMINAL_DATA_MAX_BYTES, data.byteLength),
      ),
    );
  }
  return chunks;
}

function sendTerminalInput(socket: { send(data: string): void }, data: Buffer) {
  for (const chunk of chunkTerminalInput(data)) {
    socket.send(
      JSON.stringify({
        type: "input",
        dataBase64: chunk.toString("base64"),
      }),
    );
  }
}

async function waitForTerminal(args: {
  baseUrl: string;
  opts: TerminalWaitOptions;
  terminalId: string;
}): Promise<{ matched: string; nextSeq: number; terminalId: string }> {
  const hasContains = args.opts.contains !== undefined;
  const hasRegex = args.opts.regex !== undefined;
  const hasExit = args.opts.exit === true;
  if ([hasContains, hasRegex, hasExit].filter(Boolean).length !== 1) {
    throw new Error("Provide exactly one of --contains, --regex, or --exit");
  }
  const sdk = createCliBbSdk(args.baseUrl);
  const timeoutMs =
    parsePositiveInteger(args.opts.timeout, 30, "--timeout") * 1000;
  const pollIntervalMs = parsePositiveInteger(
    args.opts.pollInterval,
    500,
    "--poll-interval",
  );
  const deadline = Date.now() + timeoutMs;
  let nextSeq = args.opts.fromStart ? 0 : undefined;
  const regex =
    args.opts.regex === undefined ? null : new RegExp(args.opts.regex, "u");

  if (!hasExit && nextSeq === undefined) {
    const currentOutput = await readTerminalOutputForWait({
      sdk,
      terminalId: args.terminalId,
      query: { limitChunks: 1, tailBytes: 1 },
    });
    nextSeq = currentOutput.nextSeq;
  }

  while (Date.now() <= deadline) {
    if (hasExit) {
      const session = await sdk.terminals.get({ terminalId: args.terminalId });
      if (session.status === "exited") {
        return {
          matched: "exit",
          nextSeq: nextSeq ?? 0,
          terminalId: args.terminalId,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }

    const output = await readTerminalOutputForWait({
      sdk,
      terminalId: args.terminalId,
      query: {
        ...terminalOutputQuery(args.opts),
        ...(nextSeq !== undefined ? { sinceSeq: nextSeq } : {}),
      },
    });
    nextSeq = output.nextSeq;
    const text = output.chunks
      .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
      .join("");
    if (args.opts.contains !== undefined && text.includes(args.opts.contains)) {
      return {
        matched: args.opts.contains,
        nextSeq,
        terminalId: args.terminalId,
      };
    }
    if (regex && regex.test(text)) {
      return {
        matched: args.opts.regex ?? "",
        nextSeq,
        terminalId: args.terminalId,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new CliExitError(
    `Timed out waiting for terminal ${args.terminalId}`,
    TERMINAL_WAIT_TIMEOUT_EXIT_CODE,
  );
}

async function readTerminalOutputForWait(args: {
  query: ReturnType<typeof terminalOutputQuery>;
  sdk: BbSdk;
  terminalId: string;
}) {
  return args.sdk.terminals
    .output({
      terminalId: args.terminalId,
      ...args.query,
    })
    .catch((error: unknown) => {
      if (isTerminalOutputUnavailable(error)) {
        throw new CliExitError(
          `Terminal ${args.terminalId} exited before the requested output matched`,
          TERMINAL_WAIT_TIMEOUT_EXIT_CODE,
        );
      }
      throw error;
    });
}

function isTerminalOutputUnavailable(error: unknown): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 409 &&
    error.code === "terminal_output_unavailable"
  );
}
