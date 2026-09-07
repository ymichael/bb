import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostDaemonStartConfig } from "@bb/config/host-daemon";
import { loadHostDaemonEntrypointConfig } from "@bb/config/host-daemon-entrypoint";
import {
  installSafeProcessDiagnostics,
  writeSafeProcessDiagnosticReport,
} from "@bb/process-utils";

interface ReportStartupFailureArgs {
  diagnosticsLogsDir: string;
  error: unknown;
}

type MainFailureHandler = (error: unknown) => void;

const entrypointDir = dirname(fileURLToPath(import.meta.url));

function resolveEntrypointBridgeBundleDir(): string | undefined {
  return existsSync(join(entrypointDir, "bb-provider-bridge-worker.mjs"))
    ? entrypointDir
    : undefined;
}

function resolveDiagnosticsLogsDir(): string {
  const hostDaemonStartConfig = loadHostDaemonStartConfig({});

  return join(hostDaemonStartConfig.dataDir, "logs");
}

function reportStartupFailure(args: ReportStartupFailureArgs): void {
  try {
    writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir: args.diagnosticsLogsDir,
      processName: "host-daemon",
      error: args.error,
    });
  } catch {}

  const message =
    args.error instanceof Error
      ? (args.error.stack ?? args.error.message)
      : String(args.error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function runHostDaemonEntrypoint(): Promise<void> {
  const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig();
  const hostDaemonModule = await import("./start-host-daemon.js");
  const daemon = await hostDaemonModule.startHostDaemon({
    bbExecutableDirectory: hostDaemonEntrypointConfig.BB_CLI_DIR,
    bridgeBundleDir:
      hostDaemonEntrypointConfig.BB_BRIDGE_DIR ??
      resolveEntrypointBridgeBundleDir(),
    machineCredential: hostDaemonEntrypointConfig.BB_CONNECT_MACHINE_CREDENTIAL,
    connectMachineId: hostDaemonEntrypointConfig.BB_CONNECT_MACHINE_ID,
    autoUpdate: hostDaemonEntrypointConfig.BB_HOST_DAEMON_AUTO_UPDATE,
    enrollKey: hostDaemonEntrypointConfig.BB_HOST_ENROLL_KEY,
    hostId: hostDaemonEntrypointConfig.BB_HOST_ID,
    hostName: hostDaemonEntrypointConfig.BB_HOST_NAME,
    hostType: hostDaemonEntrypointConfig.BB_HOST_TYPE,
  });
  await daemon.waitUntilStopped();
}

const entrypointPath = process.argv[1];
const isMainModule =
  typeof entrypointPath === "string" &&
  fileURLToPath(import.meta.url) === entrypointPath;

if (isMainModule) {
  const diagnosticsLogsDir = resolveDiagnosticsLogsDir();
  installSafeProcessDiagnostics({
    logsDir: diagnosticsLogsDir,
    processName: "host-daemon",
  });
  const handleMainFailure: MainFailureHandler = (error) => {
    reportStartupFailure({ diagnosticsLogsDir, error });
  };
  void runHostDaemonEntrypoint().catch(handleMainFailure);
}
