import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const LOGGER_IMPORT_SPECIFIER = "@bb/logger";

const tempDirs: string[] = [];

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-logger-"));
  tempDirs.push(tempDir);
  return tempDir;
}

async function importFreshLogger() {
  vi.resetModules();
  return import("../src/index.js");
}

async function importFreshLoggerWithPinoTransportSpy() {
  vi.resetModules();

  // pino uses `export = pino` (CJS), but the runtime module after Node's
  // ESM interop exposes `default` alongside the named callable. The TS type
  // for `typeof import("pino")` is the function itself, so type the actual
  // module shape explicitly to access `default`.
  const actual = await vi.importActual<{ default: typeof import("pino") }>(
    "pino",
  );
  const transportSpy = vi.fn(actual.default.transport);
  const mockedPino = Object.assign(
    ((...args: Parameters<typeof actual.default>) =>
      actual.default(...args)) as typeof actual.default,
    actual.default,
    {
      transport: transportSpy,
    },
  );

  vi.doMock("pino", () => ({
    default: mockedPino,
  }));

  const loggerModule = await import("../src/index.js");
  return {
    ...loggerModule,
    transportSpy,
  };
}

interface SubprocessLoggerResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

async function runLoggerInSubprocess(args: {
  dataDir: string;
  component: string;
  message: string;
}): Promise<SubprocessLoggerResult> {
  const script = `
    (async () => {
      const { createLogger } = await import(${JSON.stringify(LOGGER_IMPORT_SPECIFIER)});
      const logger = createLogger({ component: ${JSON.stringify(args.component)} });
      logger.info({ marker: ${JSON.stringify(args.message)} }, ${JSON.stringify(args.message)});
      // Worker transport is async. Pino's flush callback only waits for the
      // main-thread buffer, not the worker thread; a short settle window lets
      // the worker drain to stdout/file before we exit.
      setTimeout(() => process.exit(0), 250);
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BB_DATA_DIR: args.dataDir,
  };
  // The logger skips pino-pretty under VITEST; clear it so the spawned
  // process exercises the real stdout transport like production does.
  delete childEnv.VITEST;

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--conditions=source", "--import", "tsx", "-e", script],
      {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for logger output");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function getComponentLogFiles(logDir: string, component: string): string[] {
  if (!fs.existsSync(logDir)) {
    return [];
  }

  return fs
    .readdirSync(logDir)
    .filter(
      (entry) => entry.startsWith(`${component}.`) && entry.endsWith(".log"),
    )
    .sort((left, right) => {
      const leftIndex = Number.parseInt(
        left.match(/\.(\d+)\.log$/u)?.[1] ?? "0",
        10,
      );
      const rightIndex = Number.parseInt(
        right.match(/\.(\d+)\.log$/u)?.[1] ?? "0",
        10,
      );
      return leftIndex - rightIndex;
    });
}

function readComponentLogLines(
  logDir: string,
  component: string,
): Array<Record<string, unknown>> {
  return getComponentLogFiles(logDir, component).flatMap((entry) => {
    const contents = fs.readFileSync(path.join(logDir, entry), "utf8").trim();
    if (!contents) {
      return [];
    }

    return contents
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  });
}

afterEach(() => {
  vi.doUnmock("pino");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("createLogger", () => {
  it("writes structured JSON to the component log file", async () => {
    const dataDir = createTempDir();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", dataDir);

    const { createLogger } = await importFreshLogger();
    const logger = createLogger({ component: "server" });
    const logDir = path.join(dataDir, "logs");

    logger.info({ requestId: "req_1" }, "booted");
    await waitFor(() => readComponentLogLines(logDir, "server").length === 1);

    const entries = readComponentLogLines(logDir, "server");
    expect(entries[0]).toMatchObject({
      component: "server",
      level: 30,
      msg: "booted",
      requestId: "req_1",
    });
  });

  it("keeps parent context on child loggers", async () => {
    const dataDir = createTempDir();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", dataDir);

    const { createLogger } = await importFreshLogger();
    const logger = createLogger({ component: "host-daemon" });
    const logDir = path.join(dataDir, "logs");

    logger.child({ threadId: "thr_123" }).info("turn started");
    await waitFor(
      () => readComponentLogLines(logDir, "host-daemon").length === 1,
    );

    const entries = readComponentLogLines(logDir, "host-daemon");
    expect(entries[0]).toMatchObject({
      component: "host-daemon",
      threadId: "thr_123",
      msg: "turn started",
    });
  });

  it("rotates files when the active log exceeds the configured size", async () => {
    const dataDir = createTempDir();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", dataDir);

    const { createLogger } = await importFreshLogger();
    const logger = createLogger({ component: "server" });
    const logDir = path.join(dataDir, "logs");
    const payload = "x".repeat(11 * 1024 * 1024);

    logger.info({ payload }, "rotate");
    logger.info({ payload }, "rotate again");

    await waitFor(
      () => getComponentLogFiles(logDir, "server").length > 1,
      10_000,
    );

    expect(getComponentLogFiles(logDir, "server").length).toBeGreaterThan(1);
  });

  it("delivers log lines to both the file and the process stdout in worker mode", async () => {
    const dataDir = createTempDir();
    const logDir = path.join(dataDir, "logs");
    const message = `stdout-behavior-${Date.now()}`;

    const result = await runLoggerInSubprocess({
      component: "behavior-check",
      dataDir,
      message,
    });

    expect(result.exitCode).toBe(0);
    // Pretty output to stdout is the load-bearing half of the contract —
    // the previous regression was silent dropping of this target.
    expect(result.stdout).toContain(message);
    // Structured JSON to the rolling file is the other half.
    const entries = readComponentLogLines(logDir, "behavior-check");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      component: "behavior-check",
      level: 30,
      marker: message,
      msg: message,
    });
  });

  it("uses a direct file destination when stream mode is requested", async () => {
    const dataDir = createTempDir();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", dataDir);

    const { createLogger, transportSpy } =
      await importFreshLoggerWithPinoTransportSpy();
    const logger = createLogger({
      component: "host-daemon",
      transportMode: "stream",
    });
    const logDir = path.join(dataDir, "logs");

    logger.info({ requestId: "req_2" }, "sandbox booted");
    await waitFor(
      () => readComponentLogLines(logDir, "host-daemon").length === 1,
    );

    expect(transportSpy).not.toHaveBeenCalled();
    const entries = readComponentLogLines(logDir, "host-daemon");
    expect(entries[0]).toMatchObject({
      component: "host-daemon",
      level: 30,
      msg: "sandbox booted",
      requestId: "req_2",
    });
  });

  it("uses an explicit data directory when provided", async () => {
    const envDataDir = createTempDir();
    const explicitDataDir = createTempDir();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", envDataDir);

    const { createLogger } = await importFreshLogger();
    const logger = createLogger({
      component: "host-daemon",
      dataDir: explicitDataDir,
      transportMode: "stream",
    });

    logger.info({ requestId: "req_explicit" }, "explicit data dir");

    const explicitLogDir = path.join(explicitDataDir, "logs");
    await waitFor(
      () => readComponentLogLines(explicitLogDir, "host-daemon").length === 1,
    );

    expect(
      readComponentLogLines(path.join(envDataDir, "logs"), "host-daemon"),
    ).toHaveLength(0);
    expect(
      readComponentLogLines(explicitLogDir, "host-daemon")[0],
    ).toMatchObject({
      component: "host-daemon",
      msg: "explicit data dir",
      requestId: "req_explicit",
    });
  });

  it("serializes nested error causes", async () => {
    const dataDir = createTempDir();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", dataDir);

    const { createLogger } = await importFreshLogger();
    const logger = createLogger({ component: "server" });
    const logDir = path.join(dataDir, "logs");
    const error = new Error("outer", { cause: new Error("inner") });

    logger.error({ err: error }, "request failed");
    await waitFor(() => readComponentLogLines(logDir, "server").length === 1);

    const entries = readComponentLogLines(logDir, "server");
    expect(entries[0]).toMatchObject({
      msg: "request failed",
      err: {
        message: "outer",
        cause: {
          message: "inner",
        },
      },
    });
  });
});
