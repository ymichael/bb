import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  installSafeProcessDiagnostics,
  resolveContainedPath,
  sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess,
  spawnPortablePipedProcess,
  writeSafeProcessDiagnosticReport,
} from "../src/index.js";

async function readProcessOutput() {
  const child = spawnPortablePipedProcess({
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("stdout"); process.stderr.write("stderr");',
    ],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const [exitCode] = await once(child, "exit");
  return {
    exitCode,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
  };
}

describe("process utils", () => {
  it("installs safe diagnostics without enabling Node process reports", () => {
    const originalDirectory = process.report.directory;
    const originalReportOnFatalError = process.report.reportOnFatalError;
    const originalReportOnUncaughtException =
      process.report.reportOnUncaughtException;
    const originalListenerCount = process.listenerCount(
      "uncaughtExceptionMonitor",
    );
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );

    const dispose = installSafeProcessDiagnostics({
      logsDir,
      processName: "test-process",
    });

    try {
      expect(existsSync(logsDir)).toBe(true);
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(
        originalListenerCount + 1,
      );
      expect(process.report.directory).toBe(originalDirectory);
      expect(process.report.reportOnFatalError).toBe(
        originalReportOnFatalError,
      );
      expect(process.report.reportOnUncaughtException).toBe(
        originalReportOnUncaughtException,
      );
    } finally {
      dispose();
    }

    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(
      originalListenerCount,
    );
  });

  it("writes env-safe diagnostic reports", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
    const secretValue = "sk-test-secret-that-must-not-leak";
    process.env.OPENAI_API_KEY = secretValue;

    try {
      const reportPath = writeSafeProcessDiagnosticReport({
        kind: "startupFailure",
        logsDir,
        processName: "test-process",
        error: new Error("startup failed"),
        now: () => new Date("2026-06-01T12:00:00.000Z"),
        createReportId: () => "report-id",
      });
      const reportText = readFileSync(reportPath, "utf8");

      expect(reportText).toContain('"kind": "startupFailure"');
      expect(reportText).toContain('"processName": "test-process"');
      expect(reportText).toContain('"message": "startup failed"');
      expect(reportText).not.toContain("OPENAI_API_KEY");
      expect(reportText).not.toContain(secretValue);
    } finally {
      if (originalOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiApiKey;
      }
    }
  });

  it("writes nested error causes", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const connectionError = new Error("connect ECONNREFUSED 127.0.0.1:38886");
    Object.defineProperty(connectionError, "code", {
      value: "ECONNREFUSED",
    });
    const reportPath = writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir,
      processName: "host-daemon",
      error: new TypeError("fetch failed", { cause: connectionError }),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      createReportId: () => "report-id",
    });

    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      error: {
        name: "TypeError",
        message: "fetch failed",
        cause: {
          name: "Error",
          message: "connect ECONNREFUSED 127.0.0.1:38886",
          code: "ECONNREFUSED",
        },
      },
    });
  });

  it("truncates cyclic error causes", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const firstError = new Error("first");
    const secondError = new Error("second");
    firstError.cause = secondError;
    secondError.cause = firstError;

    const reportPath = writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir,
      processName: "host-daemon",
      error: firstError,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      createReportId: () => "report-id",
    });

    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      error: {
        message: "first",
        cause: {
          message: "second",
          cause: {
            name: "TruncatedErrorCause",
            truncationReason: "cycle",
          },
        },
      },
    });
  });

  it("truncates error causes that exceed the depth limit", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const rootError = new Error("cause-0");
    let currentError = rootError;
    for (let index = 1; index < 32; index += 1) {
      const cause = new Error(`cause-${index}`);
      currentError.cause = cause;
      currentError = cause;
    }

    const reportPath = writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir,
      processName: "host-daemon",
      error: rootError,
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      createReportId: () => "report-id",
    });
    const reportText = readFileSync(reportPath, "utf8");

    expect(reportText).toContain('"name": "TruncatedErrorCause"');
    expect(reportText).toContain('"truncationReason": "depth"');
    expect(reportText).not.toContain("cause-31");
  });

  it("writes bounded AggregateError details", () => {
    const logsDir = join(
      mkdtempSync(join(tmpdir(), "bb-process-utils-report-")),
      "logs",
    );
    const connectionErrors = Array.from({ length: 10 }, (_, index) => {
      const error = new Error(`connect ECONNREFUSED address-${index}`);
      Object.defineProperty(error, "code", { value: "ECONNREFUSED" });
      return error;
    });
    const reportPath = writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir,
      processName: "host-daemon",
      error: new AggregateError(connectionErrors, "fetch failed"),
      now: () => new Date("2026-06-01T12:00:00.000Z"),
      createReportId: () => "report-id",
    });
    const reportText = readFileSync(reportPath, "utf8");

    expect(reportText).toContain('"errors"');
    expect(reportText).toContain('"code": "ECONNREFUSED"');
    expect(reportText).toContain("connect ECONNREFUSED address-7");
    expect(reportText).toContain('"errorsTruncated": 2');
    expect(reportText).not.toContain("connect ECONNREFUSED address-8");
  });

  it("spawns a process with piped stdio", async () => {
    await expect(readProcessOutput()).resolves.toEqual({
      exitCode: 0,
      stdout: "stdout",
      stderr: "stderr",
    });
  });

  it("spawns a process with stdin closed and output piped", async () => {
    const child = spawnPortableOutputProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdin.on("error", () => {}); process.stdin.on("end", () => process.stdout.write("closed")); process.stdin.resume();',
      ],
    });

    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));

    const [exitCode] = await once(child, "exit");

    expect(exitCode).toBe(0);
    expect(child.stdin).toBeNull();
    expect(Buffer.concat(stdoutChunks).toString("utf8")).toBe("closed");
  });

  it("resolves paths that stay within the configured root", () => {
    expect(
      resolveContainedPath({
        rootPath: "/tmp/root",
        candidatePath: "/tmp/root/child/file.txt",
      }),
    ).toBe("/tmp/root/child/file.txt");
  });

  it("rejects root and escaped paths", () => {
    expect(
      resolveContainedPath({
        rootPath: "/tmp/root",
        candidatePath: "/tmp/root",
      }),
    ).toBeNull();
    expect(
      resolveContainedPath({
        rootPath: "/tmp/root",
        candidatePath: "/tmp/root/../escape",
      }),
    ).toBeNull();
  });

  it("scrubs inherited bb runtime env vars and node mode", () => {
    const env: NodeJS.ProcessEnv = {
      BB_DATA_DIR: "/tmp/bb-data",
      BB_HOST_DAEMON_PORT: "38887",
      NODE_ENV: "development",
      NODE_OPTIONS: "--enable-source-maps",
      OPENAI_API_KEY: "external-secret",
      PATH: "/bin",
      SKIP_ME: undefined,
    };

    const sanitizedEnv = sanitizeInheritedChildProcessEnv({ env });
    expect(sanitizedEnv).toEqual({
      NODE_OPTIONS: "--enable-source-maps",
      OPENAI_API_KEY: "external-secret",
      PATH: "/bin",
    });
    expect("SKIP_ME" in sanitizedEnv).toBe(false);
  });

  it("does not mutate the inherited env", () => {
    const env: NodeJS.ProcessEnv = {
      BB_DATA_DIR: "/tmp/bb-data",
      NODE_ENV: "development",
      PATH: "/bin",
    };
    const originalEnv: NodeJS.ProcessEnv = { ...env };

    expect(sanitizeInheritedChildProcessEnv({ env })).toEqual({
      PATH: "/bin",
    });
    expect(env).toEqual(originalEnv);
  });
});
