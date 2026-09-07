import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, ProviderRecoveryKind } from "@bb/domain";
import { createAgentRuntime } from "../runtime.js";
import type {
  AgentRuntime,
  AgentRuntimeBridgeLaunch,
  AgentRuntimeExecutionOptions,
  AgentRuntimeOptions,
} from "../types.js";
export {
  waitForRuntimeState,
  waitForRuntimeThreadEvent,
  waitForThreadAgentMessageText,
  waitForThreadTurnCompleted,
  waitForThreadTurnStarted,
} from "./runtime-wait-helpers.js";

export const fullRuntimeOptions = {
  model: "test-model",
  serviceTier: "default",
  reasoningLevel: "medium",
  providerOptions: {},
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
} satisfies AgentRuntimeExecutionOptions;

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const prebuiltTestBridgeDir = fileURLToPath(
  new URL("../../dist/test-bridges/", import.meta.url),
);

export const scriptedEchoBridgeModulePath = join(
  prebuiltTestBridgeDir,
  "scripted-echo-provider.mjs",
);

export interface ScriptedEchoLaunchScript {
  startDelayMs?: number;
  answerStartWithoutIdentity?: boolean;
  archivedSession?: boolean;
  unarchiveFails?: boolean;
  exitAfterArchivedError?: boolean;
  discardFailsOnce?: boolean;
  crashOn?: string;
  exitAfter?: string;
  unsupportedMethods?: string[];
  failMethods?: {
    method: string;
    message: string;
    code?: number;
    times?: number;
    recovery?: { kind: ProviderRecoveryKind; retryable: boolean };
  }[];
  goalClearNotifyDelayMs?: number;
  goalClearReportsCleared?: boolean;
  swallowTurnStart?: boolean;
  sessionRestorable?: boolean;
  warnOnTurn?: boolean;
  toolCallThreadIdHint?: string;
  recoveryThreadIdHint?: string;
  approvalEnforcedBy?: "runtime" | "provider";
  identifyProcess?: boolean;
  failStopForThreadIds?: string[];
  emitIdentityOnSigterm?: boolean;
}

export interface CreateScriptedEchoLaunchOptions {
  pluginId?: string;
  digest?: string;
  scripted?: ScriptedEchoLaunchScript;
  providerOptions?: JsonObject;
  capabilities?: Partial<AgentRuntimeBridgeLaunch["capabilities"]>;
  modulePath?: string;
}

export function createScriptedEchoLaunch(
  options: CreateScriptedEchoLaunchOptions = {},
): AgentRuntimeBridgeLaunch {
  const pluginId = options.pluginId ?? "provider-scripted-echo";
  return {
    pluginId,
    dataDir: mkdtempSync(join(tmpdir(), `bb-${pluginId}-data-`)),
    source: {
      kind: "artifact",
      digest: options.digest ?? "scripted-echo",
      artifactPath: options.modulePath ?? scriptedEchoBridgeModulePath,
    },
    capabilities: {
      providerInstallation: false,
      supportsServiceTier: false,
      permissionModes: ["accept-edits", "auto", "full"],
      supportsThreadArchive: true,
      supportsThreadRename: true,
      fork: "checkpoint",
      ...options.capabilities,
    },
    providerOptions: {
      ...options.providerOptions,
      ...(options.scripted === undefined
        ? {}
        : { scripted: scriptToJson(options.scripted) }),
    },
    envPassthrough: [],
  };
}

function scriptToJson(script: ScriptedEchoLaunchScript): JsonObject {
  return JSON.parse(JSON.stringify(script)) as JsonObject;
}

export function scriptedEchoProcessEnv(
  script: ScriptedEchoLaunchScript,
): Record<string, string> {
  return { SCRIPTED_ECHO_OPTIONS: JSON.stringify(script) };
}

type LaunchBearingMethod =
  | "ensureProvider"
  | "startThread"
  | "prepareThreadRewind"
  | "resumeThread"
  | "archiveThread"
  | "unarchiveThread"
  | "listModels"
  | "providerHealth"
  | "providerUsage"
  | "providerInstallationStatus"
  | "providerInstallationRun";

type WithDefaultBridgeLaunch<TMethod extends (args: never) => unknown> = (
  args: Omit<Parameters<TMethod>[0], "bridgeLaunch"> & {
    bridgeLaunch?: AgentRuntimeBridgeLaunch;
  },
) => ReturnType<TMethod>;

export type LaunchBoundAgentRuntime = Omit<
  AgentRuntime,
  LaunchBearingMethod
> & {
  [TMethod in LaunchBearingMethod]: WithDefaultBridgeLaunch<
    AgentRuntime[TMethod]
  >;
};

export function withBridgeLaunch(
  runtime: AgentRuntime,
  bridgeLaunch: AgentRuntimeBridgeLaunch,
): LaunchBoundAgentRuntime {
  return {
    ...runtime,
    ensureProvider: (args) => runtime.ensureProvider({ bridgeLaunch, ...args }),
    startThread: (args) => runtime.startThread({ bridgeLaunch, ...args }),
    prepareThreadRewind: (args) =>
      runtime.prepareThreadRewind({ bridgeLaunch, ...args }),
    resumeThread: (args) => runtime.resumeThread({ bridgeLaunch, ...args }),
    archiveThread: (args) => runtime.archiveThread({ bridgeLaunch, ...args }),
    unarchiveThread: (args) =>
      runtime.unarchiveThread({ bridgeLaunch, ...args }),
    listModels: (args) => runtime.listModels({ bridgeLaunch, ...args }),
    providerHealth: (args) => runtime.providerHealth({ bridgeLaunch, ...args }),
    providerUsage: (args) => runtime.providerUsage({ bridgeLaunch, ...args }),
    providerInstallationStatus: (args) =>
      runtime.providerInstallationStatus({ bridgeLaunch, ...args }),
    providerInstallationRun: (args) =>
      runtime.providerInstallationRun({ bridgeLaunch, ...args }),
  };
}

export interface CreateScriptedEchoRuntimeArgs {
  runtime: Omit<AgentRuntimeOptions, "onToolCall"> &
    Partial<Pick<AgentRuntimeOptions, "onToolCall">>;
  launch?: CreateScriptedEchoLaunchOptions;
}

export function createScriptedEchoRuntime(
  args: CreateScriptedEchoRuntimeArgs,
): LaunchBoundAgentRuntime {
  const runtime = createAgentRuntime({
    onToolCall: async () => ({ contentItems: [], success: true }),
    ...(args.launch?.modulePath === undefined
      ? { bridgeBundleDir: prebuiltTestBridgeDir }
      : {}),
    ...args.runtime,
  });
  return withBridgeLaunch(runtime, createScriptedEchoLaunch(args.launch));
}

export interface ScriptedEchoProcessLog {
  env: Record<string, string>;
  path: string;
  read(): string[];
}

export function createScriptedEchoProcessLog(): ScriptedEchoProcessLog {
  const path = join(
    mkdtempSync(join(tmpdir(), "bb-scripted-echo-process-log-")),
    "process.log",
  );
  return {
    env: { SCRIPTED_ECHO_PROCESS_LOG_PATH: path },
    path,
    read() {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        return [];
      }
      return raw.split("\n").filter((line) => line.length > 0);
    },
  };
}

export interface RecordedBridgeRequest {
  method: string;
  params: Record<string, unknown> | null;
}

export interface ScriptedEchoRequestRecord {
  env: Record<string, string>;
  path: string;
  read(): RecordedBridgeRequest[];
  last(method: string): RecordedBridgeRequest | undefined;
}

export function createScriptedEchoRequestRecord(): ScriptedEchoRequestRecord {
  const path = join(
    mkdtempSync(join(tmpdir(), "bb-scripted-echo-record-")),
    "requests.jsonl",
  );
  const read = (): RecordedBridgeRequest[] => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RecordedBridgeRequest);
  };
  return {
    env: { SCRIPTED_ECHO_RECORD_PATH: path },
    path,
    read,
    last(method) {
      const requests = read();
      for (let index = requests.length - 1; index >= 0; index -= 1) {
        if (requests[index]?.method === method) {
          return requests[index];
        }
      }
      return undefined;
    },
  };
}
