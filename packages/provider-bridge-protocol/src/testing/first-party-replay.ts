import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  checkRecordedCellReplay,
  RECORDED_CONFORMANCE_CELLS,
  type RecordedCellReplay,
} from "../conformance/recorded.js";
import { formatConformanceReport } from "../conformance/index.js";
import { createBridgeDeltaEventCollector } from "./bridge-delta-assembly.js";
import {
  replayRecordedCells,
  resolveProviderBridgeLaunch,
  type ProviderBridgeLaunch,
  type ReplayProviderProfile,
  type ReplayRecordedCellsOptions,
} from "./parity.js";
import {
  COMMITTED_RECORDINGS_ROOT,
  type BridgeRecording,
  type RecordedCell,
} from "./recording.js";

export const FIRST_PARTY_BRIDGE_MODULES: Readonly<
  Record<
    string,
    { modulePath: string; legacyModulePaths?: string[]; pluginId: string }
  >
> = {
  codex: {
    modulePath: "plugins/provider-codex/src/bridge/bridge.ts",
    pluginId: "provider-codex",
  },
  "claude-code": {
    modulePath: "plugins/provider-claude-code/src/bridge/bridge.ts",
    pluginId: "provider-claude-code",
  },
  acp: {
    modulePath: "plugins/provider-acp/src/host.ts",
    legacyModulePaths: ["plugins/provider-acp/src/bridge/bridge.ts"],
    pluginId: "provider-acp",
  },
  pi: {
    modulePath: "plugins/provider-pi/src/host.ts",
    legacyModulePaths: ["plugins/provider-pi/src/bridge/bridge.ts"],
    pluginId: "provider-pi",
  },
};

const BRIDGE_WORKER_ENTRY =
  "packages/provider-bridge-protocol/src/bridge-worker-entry.ts";

export interface ParityBridgeSpec {
  checkoutRoot: string;
  providerId: string;
  modulePath?: string;
  pluginId?: string;
}

export class UnreplayableProviderError extends Error {
  constructor(providerId: string, reason: string) {
    super(`provider "${providerId}" cannot be replayed: ${reason}`);
    this.name = "UnreplayableProviderError";
  }
}

type FirstPartyReplayProfile = ReplayProviderProfile & {
  bridgeFamily: keyof typeof FIRST_PARTY_BRIDGE_MODULES;
};

export function resolveReplayProfile(
  providerId: string,
): FirstPartyReplayProfile {
  if (providerId === "codex") {
    return {
      dialect: "json-rpc",
      bridgeFamily: "codex",
      env: ({ replayCommand }) => ({
        BB_CODEX_BRIDGE_APP_SERVER_COMMAND: replayCommand[0],
        BB_CODEX_BRIDGE_APP_SERVER_ARGS: JSON.stringify(replayCommand.slice(1)),
      }),
    };
  }
  if (providerId === "claude-code") {
    return {
      dialect: "claude-cli",
      bridgeFamily: "claude-code",
      env: ({ wrapperPath, stateDir }) => ({
        BB_CLAUDE_CODE_EXECUTABLE: wrapperPath,
        CLAUDE_CONFIG_DIR: claudeConfigDir(stateDir),
      }),
      prepareState: seedClaudeForkTranscripts,
    };
  }
  if (providerId.startsWith("acp-")) {
    return {
      dialect: "json-rpc",
      bridgeFamily: "acp",
      env: () => ({}),
      rewriteRuntimeLine: (line, { replayCommand }) =>
        rewriteAcpLaunchSpec(line, replayCommand),
    };
  }
  if (providerId === "pi") {
    return {
      dialect: "pi-rpc",
      bridgeFamily: "pi",
      env: ({ replayCommand, stateDir }) => ({
        BB_PI_BRIDGE_COMMAND: replayCommand[0],
        BB_PI_BRIDGE_ARGS: JSON.stringify(replayCommand.slice(1)),
        BB_PI_BRIDGE_SESSION_DIR: piSessionDir(stateDir),
      }),
      prepareState: seedPiSessionFiles,
    };
  }
  throw new UnreplayableProviderError(providerId, "no replay profile");
}

function claudeConfigDir(stateDir: string): string {
  return join(stateDir, "claude-config");
}

function piSessionDir(stateDir: string): string {
  return join(stateDir, "pi-sessions");
}

function seedPiSessionFiles(args: {
  recording: BridgeRecording;
  stateDir: string;
}): void {
  const sessionDir = piSessionDir(args.stateDir);
  mkdirSync(sessionDir, { recursive: true });
  for (const entry of args.recording.entries) {
    if (entry.dir !== "runtime→bridge") continue;
    const message = parseWire(entry.line);
    if (message === null || message.method !== "thread/fork") continue;
    const params = message.params as
      | { sourceProviderThreadId?: unknown }
      | undefined;
    const sourceThreadId = params?.sourceProviderThreadId;
    if (typeof sourceThreadId !== "string") continue;
    writeFileSync(
      join(
        sessionDir,
        `${sourceThreadId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`,
      ),
      "",
    );
  }
}

function claudeProjectDirName(workspaceDir: string): string {
  return workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
}

function seedClaudeForkTranscripts(args: {
  recording: BridgeRecording;
  stateDir: string;
  workspaceDir: string;
}): void {
  const projectDir = join(
    claudeConfigDir(args.stateDir),
    "projects",
    claudeProjectDirName(args.workspaceDir),
  );
  for (const entry of args.recording.entries) {
    if (entry.dir !== "runtime→bridge") continue;
    const message = parseWire(entry.line);
    if (message === null || message.method !== "thread/fork") continue;
    const params = message.params as
      | {
          sourceProviderThreadId?: unknown;
          sourceProviderCheckpointId?: unknown;
        }
      | undefined;
    const sessionId = params?.sourceProviderThreadId;
    if (typeof sessionId !== "string") continue;
    const checkpointId =
      typeof params?.sourceProviderCheckpointId === "string"
        ? params.sourceProviderCheckpointId
        : randomUUID();
    const userUuid = randomUUID();
    const timestamp = "2026-01-01T00:00:00.000Z";
    const transcript = [
      {
        type: "user",
        uuid: userUuid,
        parentUuid: null,
        sessionId,
        timestamp,
        cwd: args.workspaceDir,
        message: { role: "user", content: "recorded source session" },
      },
      {
        type: "assistant",
        uuid: checkpointId,
        parentUuid: userUuid,
        sessionId,
        timestamp,
        cwd: args.workspaceDir,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ready" }],
        },
      },
    ];
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      `${transcript.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }
}

function rewriteAcpLaunchSpec(line: string, replayCommand: string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return line;
  }
  const message = parsed as {
    params?: { options?: { providerOptions?: Record<string, unknown> } };
  };
  const providerOptions = message.params?.options?.providerOptions;
  const spec = providerOptions?.acpLaunchSpec;
  if (
    providerOptions === undefined ||
    typeof spec !== "object" ||
    spec === null
  ) {
    return line;
  }
  const { modelCli: _modelCli, ...rest } = spec as Record<string, unknown>;
  providerOptions.acpLaunchSpec = {
    ...rest,
    command: replayCommand[0],
    args: replayCommand.slice(1),
    env: {},
  };
  return JSON.stringify(parsed);
}

function parseWire(line: string): { method?: string; params?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as { method?: string; params?: unknown })
      : null;
  } catch {
    return null;
  }
}

export function resolveFirstPartyBridgeModulePath(
  checkoutRoot: string,
  entry: { modulePath: string; legacyModulePaths?: string[] },
): string | null {
  for (const candidate of [
    entry.modulePath,
    ...(entry.legacyModulePaths ?? []),
  ]) {
    if (existsSync(join(checkoutRoot, candidate))) {
      return candidate;
    }
  }
  return null;
}

function resolveModulePath(
  checkoutRoot: string,
  entry: { modulePath: string; legacyModulePaths?: string[] },
): string {
  return (
    resolveFirstPartyBridgeModulePath(checkoutRoot, entry) ?? entry.modulePath
  );
}

export function resolveBridgeLaunch(
  spec: ParityBridgeSpec,
): ProviderBridgeLaunch {
  const checkoutRoot = resolve(spec.checkoutRoot);
  const profile = resolveReplayProfile(spec.providerId);
  const defaults = FIRST_PARTY_BRIDGE_MODULES[profile.bridgeFamily];
  const modulePath =
    spec.modulePath ?? resolveModulePath(checkoutRoot, defaults);
  return resolveProviderBridgeLaunch({
    modulePath: isAbsolute(modulePath)
      ? modulePath
      : join(checkoutRoot, modulePath),
    pluginId: spec.pluginId ?? defaults.pluginId,
    bootstrapPath: join(checkoutRoot, BRIDGE_WORKER_ENTRY),
    cwd: checkoutRoot,
  });
}

export function firstPartyReplayBridge(
  providerId: string,
  checkoutRoot: string,
): { launch: ProviderBridgeLaunch; profile: ReplayProviderProfile } {
  return {
    launch: resolveBridgeLaunch({ checkoutRoot, providerId }),
    profile: resolveReplayProfile(providerId),
  };
}

export interface ReplayFirstPartyRecordedCellsOptions extends Omit<
  ReplayRecordedCellsOptions,
  "bridge" | "recordingsRoot"
> {
  checkoutRoot?: string;
  recordingsRoot?: string;
}

export function replayFirstPartyRecordedCells(
  options: ReplayFirstPartyRecordedCellsOptions,
): Promise<RecordedCellReplay[]> {
  const recordingsRoot = options.recordingsRoot ?? COMMITTED_RECORDINGS_ROOT;
  const checkoutRoot =
    options.checkoutRoot ?? resolve(recordingsRoot, "../../..");
  const {
    checkoutRoot: _checkoutRoot,
    recordingsRoot: _recordingsRoot,
    ...rest
  } = options;
  return replayRecordedCells({
    ...rest,
    recordingsRoot,
    bridge: (cell: RecordedCell) =>
      firstPartyReplayBridge(cell.provider, checkoutRoot),
  });
}

export interface FirstPartyRecordedConformanceOptions {
  servesProvider: (providerId: string) => boolean;
  label: string;
}

export interface FirstPartyRecordedConformanceRun {
  cells: string[];
  failures: string[];
  report: string;
}

export async function runFirstPartyRecordedConformance(
  options: FirstPartyRecordedConformanceOptions,
): Promise<FirstPartyRecordedConformanceRun> {
  const replays = await replayFirstPartyRecordedCells({
    servesProvider: options.servesProvider,
    cells: RECORDED_CONFORMANCE_CELLS,
    createAssembler: (providerId) => {
      const collector = createBridgeDeltaEventCollector(providerId);
      return {
        assembleMessage: (message) => collector.assembleMessage(message),
      };
    },
    timeoutMs: 60_000,
    onStderr: (text) => process.stderr.write(`[bridge] ${text}`),
  });
  const results = replays.flatMap((replay) => checkRecordedCellReplay(replay));
  const report = formatConformanceReport({
    results,
    passed: results.every((result) => result.status === "pass"),
  });
  return {
    cells: replays.map((replay) => replay.cell).sort(),
    failures: results
      .filter((result) => result.status !== "pass")
      .map((result) => `${result.id}: ${result.detail}`),
    report: `${options.label} recorded conformance:\n${report}`,
  };
}
