import type {
  DynamicTool,
  ThreadExecutionOptions,
  ThreadEvent,
  ThreadEventRow,
  ToolCallResponse,
} from "@bb/domain";
import type {
  ThreadContextWindowUsage,
  TimelineRow,
} from "@bb/server-contract";
import type { AgentRuntimeCaptureEntry } from "@bb/agent-runtime/capture";
import type {
  GitSnapshot,
  ReplayRawProviderCaptureEntry,
  ReplayRawProviderEventRecord,
} from "@bb/replay-capture/schema";
import type { FixtureManifest } from "./corpus-schema.js";

export interface FixtureScenarioExecutionOptions {
  permissionMode?: ThreadExecutionOptions["permissionMode"];
  reasoningLevel?: ThreadExecutionOptions["reasoningLevel"];
  serviceTier?: ThreadExecutionOptions["serviceTier"];
}

export interface FixtureScenarioWorkspaceFile {
  path: string;
  content: string;
}

export interface FixtureScenarioToolFixture {
  tool: DynamicTool;
  response: ToolCallResponse;
}

export interface FixtureScenarioOverride {
  turns?: string[];
  execution?: FixtureScenarioExecutionOptions;
  workspaceMode?: "repo" | "scratch";
  workspaceFiles?: FixtureScenarioWorkspaceFile[];
  toolFixtures?: FixtureScenarioToolFixture[];
}

export interface FixtureScenario {
  id: string;
  description: string;
  turns: string[];
  execution?: FixtureScenarioExecutionOptions;
  workspaceMode?: "repo" | "scratch";
  workspaceFiles?: FixtureScenarioWorkspaceFile[];
  toolFixtures?: FixtureScenarioToolFixture[];
  providerOverrides?: Record<string, FixtureScenarioOverride>;
}

export interface FixtureCliArgs {
  providerId: string;
  scenarioId: string;
  outputDir?: string;
  workspacePath: string;
  model?: string;
  prompt?: string;
  threadId?: string;
  projectId?: string;
  gitResetRef?: string;
  timeoutMs: number;
}

export interface FixtureReplayArgs {
  fixtureRoot: string;
  corpusId?: string;
  providerId?: string;
  taskId?: string;
  outputRoot?: string;
}

export type FixtureGitSnapshot = GitSnapshot;

export interface FixtureBundle {
  manifest: FixtureManifest;
  rawProviderEventRecords: ReplayRawProviderEventRecord[];
  rawProviderEvents: ReplayRawProviderCaptureEntry[];
}

export interface FixtureCorpusEntry extends FixtureBundle {
  corpusId: string;
  providerId: string;
  taskId: string;
  fixturePath: string;
  manifestPath: string;
  rawProviderEventsPath: string;
}

export interface FixtureReplayBundle {
  manifest: FixtureManifest;
  captures: AgentRuntimeCaptureEntry[];
  outputDir: string | null;
  rawProviderEvents: ReplayRawProviderCaptureEntry[];
  translatedCaptures: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "translated-thread-event" }
  >[];
  toolCallRequests: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "tool-call-request" }
  >[];
  toolCallResults: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "tool-call-result" }
  >[];
  providerStderr: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "provider-stderr" }
  >[];
  processLifecycle: Array<
    Extract<
      AgentRuntimeCaptureEntry,
      { kind: "provider-process-error" | "provider-process-exit" }
    >
  >;
  threadEvents: ThreadEvent[];
  threadEventRows: ThreadEventRow[];
  contextWindowUsage: ThreadContextWindowUsage | null;
  timelineRows: TimelineRow[];
  timelineText: string;
  timelineVerboseRows: TimelineRow[];
  timelineVerboseText: string;
}

export interface FixtureRunResult {
  outputDir: string;
  bundle: FixtureReplayBundle;
}

export interface CorpusContext {
  fixtureRoot: string;
  corpusId: string;
  taskId: string;
  scenarioId: string;
  scenarioDescription: string;
  model: string | null;
  gitSha: string | null;
  gitResetRef: string | null;
  workspacePath: string;
  runtimeWorkspacePath: string;
  envWorkspacePath: string;
  runtimeWorkspaceGitStart: FixtureGitSnapshot | null;
  runtimeWorkspaceGitEnd: FixtureGitSnapshot | null;
}

export interface PromoteCaptureToFixtureArgs {
  captureId: string;
  replayRoot: string;
  corpusContext: CorpusContext;
}

export interface PromoteCaptureToFixtureResult {
  destDir: string;
  manifest: FixtureManifest;
}

export interface PromoteCaptureCliArgs {
  captureId: string;
  replayRoot: string;
  fixtureRoot: string;
  corpusId: string;
  taskId: string | null;
}

export interface FixtureReplayResult {
  fixture: FixtureCorpusEntry;
  bundle: FixtureReplayBundle;
  outputDir?: string;
}

export interface FixtureReplayResults {
  fixtures: FixtureReplayResult[];
}
