import { chmodSync, constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { spawn as spawnPty } from "node-pty";
import type { TerminalSessionCloseReason } from "@bb/domain";
import type { HostDaemonDaemonWsMessage } from "@bb/host-daemon-contract";
import type { HostDaemonServerTerminalMessage } from "../server-connection-support.js";
import type { HostDaemonLogger } from "../logger.js";
import { RuntimeManager } from "../runtime-manager.js";

const DEFAULT_SCROLLBACK_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_SCROLLBACK_MAX_CHUNKS = 10_000;
const MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;
const requireForNodePty = createRequire(import.meta.url);
let nodePtySpawnHelperChecked = false;

export interface TerminalPtyDisposable {
  dispose(): void;
}

export interface TerminalPtyExit {
  exitCode: number;
}

export interface TerminalPtyProcess {
  kill(signal?: string): void;
  onData(listener: (data: string) => void): TerminalPtyDisposable;
  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable;
  resize(cols: number, rows: number): void;
  write(data: Buffer | string): void;
}

export interface SpawnTerminalPtyArgs {
  cols: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  file: string;
  rows: number;
}

export interface TerminalPtyAdapter {
  spawn(args: SpawnTerminalPtyArgs): TerminalPtyProcess;
}

export type ResolveTerminalShell = () => Promise<string>;
type TerminalOpenMessage = Extract<
  HostDaemonServerTerminalMessage,
  { type: "terminal.open" }
>;
type TerminalAttachMessage = Extract<
  HostDaemonServerTerminalMessage,
  { type: "terminal.attach" }
>;

export interface TerminalManagerOptions {
  logger: HostDaemonLogger;
  platform?: NodeJS.Platform;
  ptyAdapter?: TerminalPtyAdapter;
  resolveShell?: ResolveTerminalShell;
  runtimeManager: RuntimeManager;
  scrollbackMaxBytes?: number;
  scrollbackMaxChunks?: number;
  sendMessage: (message: HostDaemonDaemonWsMessage) => boolean;
}

interface ScrollbackEntry {
  byteLength: number;
  chunk: Extract<
    HostDaemonDaemonWsMessage,
    { type: "terminal.output" }
  >["chunk"];
}

interface TerminalSession {
  closeReason: TerminalSessionCloseReason | null;
  cols: number;
  disposables: TerminalPtyDisposable[];
  environmentId: string;
  nextSeq: number;
  pty: TerminalPtyProcess;
  rows: number;
  scrollback: ScrollbackEntry[];
  scrollbackBytes: number;
  terminalId: string;
}

interface SendTerminalErrorArgs {
  code: string;
  message: string;
  requestId: string;
  terminalId: string;
}

interface CloseTerminalArgs {
  reason: TerminalSessionCloseReason;
  terminalId: string;
}

interface BuildTerminalEnvArgs {
  shellEnv: NodeJS.ProcessEnv;
  terminalId: string;
}

interface ResizeTerminalArgs {
  cols: number;
  rows: number;
  terminalId: string;
}

interface FinishTerminalSessionArgs {
  closeReason: TerminalSessionCloseReason;
  exitCode: number | null;
  session: TerminalSession;
}

export const nodePtyAdapter: TerminalPtyAdapter = {
  spawn(args) {
    ensureNodePtySpawnHelperExecutable();
    const pty = spawnPty(args.file, [], {
      cols: args.cols,
      cwd: args.cwd,
      env: args.env,
      name: "xterm-256color",
      rows: args.rows,
    });
    return {
      kill: (signal) => pty.kill(signal),
      onData: (listener) => pty.onData(listener),
      onExit: (listener) =>
        pty.onExit((event) =>
          listener({
            exitCode: event.exitCode,
          }),
        ),
      resize: (cols, rows) => pty.resize(cols, rows),
      write: (data) => pty.write(data),
    };
  },
};

function ensureNodePtySpawnHelperExecutable(): void {
  if (nodePtySpawnHelperChecked || process.platform !== "darwin") {
    return;
  }
  nodePtySpawnHelperChecked = true;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const helperPath = path.join(
    path.dirname(packageJsonPath),
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  if (existsSync(helperPath)) {
    chmodSync(helperPath, 0o755);
  }
}

async function pathIsExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export async function resolveDefaultTerminalShell(): Promise<string> {
  const candidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
  ].filter(isNonEmptyString);

  for (const candidate of candidates) {
    if (await pathIsExecutable(candidate)) {
      return candidate;
    }
  }

  return "/bin/sh";
}

function buildTerminalEnv(args: BuildTerminalEnvArgs): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...args.shellEnv,
    BB_TERMINAL_SESSION_ID: args.terminalId,
    COLORTERM: "truecolor",
    DISABLE_AUTO_TITLE: "true",
    // zsh emits a highlighted "%" by default when a prompt follows output
    // without a newline. It becomes noisy when scrollback is replayed.
    PROMPT_EOL_MARK: "",
    TERM: "xterm-256color",
  };
}

function terminalTitleFromShell(shell: string): string {
  return path.basename(shell) || "Terminal";
}

export class TerminalManager {
  private readonly platform: NodeJS.Platform;
  private readonly ptyAdapter: TerminalPtyAdapter;
  private readonly resolveShell: ResolveTerminalShell;
  private readonly scrollbackMaxBytes: number;
  private readonly scrollbackMaxChunks: number;
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(private readonly options: TerminalManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.ptyAdapter = options.ptyAdapter ?? nodePtyAdapter;
    this.resolveShell = options.resolveShell ?? resolveDefaultTerminalShell;
    this.scrollbackMaxBytes =
      options.scrollbackMaxBytes ?? DEFAULT_SCROLLBACK_MAX_BYTES;
    this.scrollbackMaxChunks =
      options.scrollbackMaxChunks ?? DEFAULT_SCROLLBACK_MAX_CHUNKS;
  }

  async handleMessage(message: HostDaemonServerTerminalMessage): Promise<void> {
    switch (message.type) {
      case "terminal.open":
        await this.openTerminal(message);
        return;
      case "terminal.attach":
        this.attachTerminal(message);
        return;
      case "terminal.input":
        this.writeTerminalInput(message.terminalId, message.dataBase64);
        return;
      case "terminal.resize":
        this.resizeTerminal({
          cols: message.cols,
          rows: message.rows,
          terminalId: message.terminalId,
        });
        return;
      case "terminal.close":
        this.closeTerminal({
          reason: message.reason,
          terminalId: message.terminalId,
        });
        return;
    }
  }

  closeEnvironmentTerminals(
    environmentId: string,
    reason: TerminalSessionCloseReason,
  ): void {
    for (const session of this.sessions.values()) {
      if (session.environmentId === environmentId) {
        this.closeTerminal({
          reason,
          terminalId: session.terminalId,
        });
      }
    }
  }

  async shutdownAll(
    reason: TerminalSessionCloseReason = "daemon-disconnect",
  ): Promise<void> {
    const sessions = [...this.sessions.values()];
    for (const session of sessions) {
      try {
        session.pty.kill();
      } catch (error) {
        this.options.logger.warn(
          { err: error, terminalId: session.terminalId },
          "Failed to kill terminal during shutdown",
        );
      }
      this.finishTerminalSession({
        closeReason: reason,
        exitCode: null,
        session,
      });
    }
  }

  private async openTerminal(message: TerminalOpenMessage): Promise<void> {
    if (this.sessions.has(message.terminalId)) {
      this.sendTerminalError({
        code: "terminal_exists",
        message: "Terminal session is already open",
        requestId: message.requestId,
        terminalId: message.terminalId,
      });
      return;
    }

    if (this.platform === "win32") {
      this.sendTerminalError({
        code: "unsupported_platform",
        message: "Native Windows terminals are not supported",
        requestId: message.requestId,
        terminalId: message.terminalId,
      });
      return;
    }

    try {
      const entry = await this.options.runtimeManager.ensureEnvironment({
        environmentId: message.environmentId,
        workspacePath: message.workspaceContext.workspacePath,
        workspaceProvisionType: message.workspaceContext.workspaceProvisionType,
      });
      const shell = await this.resolveShell();
      const pty = this.ptyAdapter.spawn({
        cols: message.cols,
        cwd: entry.path,
        env: buildTerminalEnv({
          shellEnv: this.options.runtimeManager.getShellEnv(),
          terminalId: message.terminalId,
        }),
        file: shell,
        rows: message.rows,
      });
      const session: TerminalSession = {
        closeReason: null,
        cols: message.cols,
        disposables: [],
        environmentId: message.environmentId,
        nextSeq: 0,
        pty,
        rows: message.rows,
        scrollback: [],
        scrollbackBytes: 0,
        terminalId: message.terminalId,
      };
      this.sessions.set(message.terminalId, session);
      this.options.runtimeManager.markTerminalActive(
        message.environmentId,
        message.terminalId,
      );
      session.disposables.push(
        pty.onData((data) => this.handleTerminalOutput(session, data)),
        pty.onExit((event) =>
          this.finishTerminalSession({
            closeReason: session.closeReason ?? "process-exit",
            exitCode: event.exitCode,
            session,
          }),
        ),
      );
      this.options.sendMessage({
        type: "terminal.opened",
        requestId: message.requestId,
        terminalId: message.terminalId,
        shell,
        title: terminalTitleFromShell(shell),
        initialCwd: entry.path,
        currentCwd: null,
        cols: message.cols,
        rows: message.rows,
      });
    } catch (error) {
      this.sendTerminalError({
        code: "terminal_open_failed",
        message: error instanceof Error ? error.message : String(error),
        requestId: message.requestId,
        terminalId: message.terminalId,
      });
    }
  }

  private attachTerminal(message: TerminalAttachMessage): void {
    const session = this.sessions.get(message.terminalId);
    if (!session) {
      this.sendTerminalError({
        code: "terminal_not_found",
        message: "Terminal session is not open",
        requestId: message.requestId,
        terminalId: message.terminalId,
      });
      return;
    }

    this.options.sendMessage({
      type: "terminal.replay",
      requestId: message.requestId,
      terminalId: message.terminalId,
      chunks: session.scrollback
        .filter((entry) => entry.chunk.seq >= message.sinceSeq)
        .map((entry) => entry.chunk),
      nextSeq: session.nextSeq,
    });
  }

  private writeTerminalInput(terminalId: string, dataBase64: string): void {
    const session = this.sessions.get(terminalId);
    if (!session) {
      return;
    }
    session.pty.write(Buffer.from(dataBase64, "base64").toString("utf8"));
  }

  private resizeTerminal(args: ResizeTerminalArgs): void {
    const session = this.sessions.get(args.terminalId);
    if (!session) {
      return;
    }
    session.cols = args.cols;
    session.rows = args.rows;
    session.pty.resize(args.cols, args.rows);
  }

  private closeTerminal(args: CloseTerminalArgs): void {
    const session = this.sessions.get(args.terminalId);
    if (!session) {
      return;
    }
    session.closeReason = args.reason;
    try {
      session.pty.kill();
    } catch (error) {
      this.options.logger.warn(
        { err: error, terminalId: args.terminalId },
        "Failed to kill terminal",
      );
      this.finishTerminalSession({
        closeReason: args.reason,
        exitCode: null,
        session,
      });
    }
  }

  private handleTerminalOutput(session: TerminalSession, data: string): void {
    const buffer = Buffer.from(data, "utf8");
    if (buffer.byteLength === 0) {
      return;
    }

    for (
      let offset = 0;
      offset < buffer.byteLength;
      offset += MAX_OUTPUT_CHUNK_BYTES
    ) {
      const dataBuffer = buffer.subarray(
        offset,
        Math.min(offset + MAX_OUTPUT_CHUNK_BYTES, buffer.byteLength),
      );
      const chunk = {
        seq: session.nextSeq,
        dataBase64: dataBuffer.toString("base64"),
      };
      session.nextSeq += 1;
      const entry: ScrollbackEntry = {
        byteLength: dataBuffer.byteLength,
        chunk,
      };
      session.scrollback.push(entry);
      session.scrollbackBytes += entry.byteLength;
      this.pruneScrollback(session);
      this.options.sendMessage({
        type: "terminal.output",
        terminalId: session.terminalId,
        chunk,
      });
    }
  }

  private pruneScrollback(session: TerminalSession): void {
    while (
      session.scrollbackBytes > this.scrollbackMaxBytes ||
      session.scrollback.length > this.scrollbackMaxChunks
    ) {
      const removed = session.scrollback.shift();
      if (!removed) {
        return;
      }
      session.scrollbackBytes -= removed.byteLength;
    }
  }

  private finishTerminalSession(args: FinishTerminalSessionArgs): void {
    if (!this.sessions.has(args.session.terminalId)) {
      return;
    }
    this.sessions.delete(args.session.terminalId);
    this.options.runtimeManager.markTerminalInactive(
      args.session.environmentId,
      args.session.terminalId,
    );
    for (const disposable of args.session.disposables) {
      disposable.dispose();
    }
    this.options.sendMessage({
      type: "terminal.exited",
      terminalId: args.session.terminalId,
      exitCode: args.exitCode,
      closeReason: args.closeReason,
    });
  }

  private sendTerminalError(args: SendTerminalErrorArgs): void {
    this.options.sendMessage({
      type: "terminal.error",
      requestId: args.requestId,
      terminalId: args.terminalId,
      code: args.code,
      message: args.message,
    });
  }
}
