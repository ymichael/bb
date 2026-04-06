import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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

  const actual = await vi.importActual<typeof import("pino")>("pino");
  const transportSpy = vi.fn(actual.default.transport);
  const mockedPino = Object.assign(
    ((...args: Parameters<typeof actual.default>) => actual.default(...args)) as typeof actual.default,
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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
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
      (entry) =>
        entry.startsWith(`${component}.`) && entry.endsWith(".log"),
    )
    .sort((left, right) => {
      const leftIndex = Number.parseInt(left.match(/\.(\d+)\.log$/u)?.[1] ?? "0", 10);
      const rightIndex = Number.parseInt(right.match(/\.(\d+)\.log$/u)?.[1] ?? "0", 10);
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
    vi.stubEnv("BB_LOG_FORMAT", "json");

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
    vi.stubEnv("BB_LOG_FORMAT", "json");

    const { createLogger } = await importFreshLogger();
    const logger = createLogger({ component: "host-daemon" });
    const logDir = path.join(dataDir, "logs");

    logger.child({ threadId: "thr_123" }).info("turn started");
    await waitFor(() => readComponentLogLines(logDir, "host-daemon").length === 1);

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
    vi.stubEnv("BB_LOG_FORMAT", "json");

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

  it("configures pretty output in development without dropping file logs", async () => {
    const dataDir = createTempDir();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DATA_DIR", dataDir);
    vi.stubEnv("BB_LOG_FORMAT", "pretty");

    const { createLogger, transportSpy } = await importFreshLoggerWithPinoTransportSpy();
    createLogger({ component: "server" });

    expect(transportSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: expect.arrayContaining([
          expect.objectContaining({ target: "pino-roll" }),
          expect.objectContaining({ target: "pino-pretty" }),
        ]),
      }),
    );
  });

  it("uses a direct file destination when stream mode is requested", async () => {
    const dataDir = createTempDir();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", dataDir);
    vi.stubEnv("BB_LOG_FORMAT", "json");

    const { createLogger, transportSpy } =
      await importFreshLoggerWithPinoTransportSpy();
    const logger = createLogger({
      component: "host-daemon",
      transportMode: "stream",
    });
    const logDir = path.join(dataDir, "logs");

    logger.info({ requestId: "req_2" }, "sandbox booted");
    await waitFor(() => readComponentLogLines(logDir, "host-daemon").length === 1);

    expect(transportSpy).not.toHaveBeenCalled();
    const entries = readComponentLogLines(logDir, "host-daemon");
    expect(entries[0]).toMatchObject({
      component: "host-daemon",
      level: 30,
      msg: "sandbox booted",
      requestId: "req_2",
    });
  });

  it("serializes nested error causes", async () => {
    const dataDir = createTempDir();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", dataDir);
    vi.stubEnv("BB_LOG_FORMAT", "json");

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
