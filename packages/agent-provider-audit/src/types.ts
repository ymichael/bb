import type {
  DynamicTool,
  TurnRequestTarget,
  ThreadExecutionOptions,
  ThreadEvent,
  ThreadEventRow,
  ToolCallResponse,
} from "@bb/domain";
import type {
  ThreadContextWindowUsage,
  TimelineRow,
} from "@bb/server-contract";
import type {
  ProviderObservedToolCallCoverage,
  ProviderRawEventCoverage,
} from "@bb/agent-runtime";
import type { AgentRuntimeCaptureEntry } from "@bb/agent-runtime/capture";

export interface ProviderAuditScenarioExecutionOptions {
  permissionMode?: ThreadExecutionOptions["permissionMode"];
  reasoningLevel?: ThreadExecutionOptions["reasoningLevel"];
  serviceTier?: ThreadExecutionOptions["serviceTier"];
}

export interface ProviderAuditScenarioWorkspaceFile {
  path: string;
  content: string;
}

export interface ProviderAuditScenarioToolFixture {
  tool: DynamicTool;
  response: ToolCallResponse;
}

export interface ProviderAuditScenarioOverride {
  turns?: string[];
  execution?: ProviderAuditScenarioExecutionOptions;
  workspaceMode?: "repo" | "scratch";
  workspaceFiles?: ProviderAuditScenarioWorkspaceFile[];
  toolFixtures?: ProviderAuditScenarioToolFixture[];
}

export interface ProviderAuditScenario {
  id: string;
  description: string;
  turns: string[];
  execution?: ProviderAuditScenarioExecutionOptions;
  workspaceMode?: "repo" | "scratch";
  workspaceFiles?: ProviderAuditScenarioWorkspaceFile[];
  toolFixtures?: ProviderAuditScenarioToolFixture[];
  providerOverrides?: Record<string, ProviderAuditScenarioOverride>;
}

export interface ProviderAuditCliArgs {
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

export interface ProviderAuditImportFixturesArgs {
  sourceRoot: string;
  fixtureRoot: string;
  corpusId: string;
}

export interface ProviderAuditImportDevReplaysArgs {
  replayRoot: string;
  fixtureRoot: string;
  corpusId: string;
  captureIds: string[];
}

export interface ProviderAuditReplayFixturesArgs {
  fixtureRoot: string;
  corpusId?: string;
  providerId?: string;
  taskId?: string;
  outputRoot?: string;
}

export interface ProviderAuditGitSnapshot {
  headSha: string | null;
  isClean: boolean;
  statusLines: string[];
}

export interface ProviderAuditManifest {
  providerId: string;
  scenarioId: string;
  scenarioDescription: string;
  model: string | null;
  source: "live-capture";
  capturedAt: number;
  completedAt: number;
  gitSha: string | null;
  workspacePath: string;
  runtimeWorkspacePath: string;
  envWorkspacePath: string;
  outputDir: string;
  threadId: string;
  projectId: string;
  turns: string[];
  gitResetRef: string | null;
  runtimeWorkspaceGitStart: ProviderAuditGitSnapshot | null;
  runtimeWorkspaceGitEnd: ProviderAuditGitSnapshot | null;
}

export interface ProviderAuditClientRequest {
  id: string;
  turnIndex: number;
  type: "client/turn/requested";
  target: TurnRequestTarget;
  requestMethod: "thread/start" | "turn/start";
  text: string;
  createdAt: number;
}

export interface ProviderAuditUntranslatedRawEvent {
  captureId: string;
  method: string;
  kind: string;
  capturedAt: number;
  classification: ProviderRawEventCoverage;
}

export interface ProviderAuditDebugRawEvent {
  messageId: string;
  rawType: string;
  reason: "ignored-noise" | "duplicate-event" | "unhandled";
  sourceSeqStart: number;
  sourceSeqEnd: number;
}

export interface ProviderAuditToolCallSummary {
  requestCount: number;
  resultCount: number;
  failedCount: number;
}

export interface ProviderAuditRawEventKindSummary {
  kind: string;
  classification: ProviderRawEventCoverage;
  count: number;
}

export interface ProviderAuditObservedToolCallSummary {
  key: string;
  displayName: string;
  coverage: ProviderObservedToolCallCoverage;
  count: number;
}

export interface ProviderAuditStderrSummary {
  lineCount: number;
  sample: Extract<AgentRuntimeCaptureEntry, { kind: "provider-stderr" }>[];
}

export interface ProviderAuditReport {
  summary: {
    rawProviderEventCount: number;
    translatedThreadEventCount: number;
    semanticTimelineRowCount: number;
    renderedTimelineRowCount: number;
    debugRawEventCount: number;
    unexpectedUntranslatedRawEventCount: number;
    toolCallRequestCount: number;
    toolCallResultCount: number;
    providerStderrCount: number;
    processLifecycleCount: number;
    normalizedRawEventCount: number;
    noiseRawEventCount: number;
    unknownRawEventCount: number;
    wellKnownObservedToolCallCount: number;
    acceptedFallbackObservedToolCallCount: number;
    unknownObservedToolCallCount: number;
  };
  rawProviderMethods: string[];
  rawProviderEventKinds: string[];
  rawEventKinds: ProviderAuditRawEventKindSummary[];
  translatedEventTypes: ThreadEvent["type"][];
  untranslatedRawProviderEvents: ProviderAuditUntranslatedRawEvent[];
  unexpectedUntranslatedRawProviderEvents: ProviderAuditUntranslatedRawEvent[];
  debugRawEvents: ProviderAuditDebugRawEvent[];
  toolCalls: ProviderAuditToolCallSummary;
  wellKnownToolNames: string[];
  observedToolCalls: ProviderAuditObservedToolCallSummary[];
  providerStderr: ProviderAuditStderrSummary;
  processLifecycle: Array<
    Extract<
      AgentRuntimeCaptureEntry,
      { kind: "provider-process-error" | "provider-process-exit" }
    >
  >;
  attentionNeeded: string[];
}

export interface ProviderAuditBundle {
  manifest: ProviderAuditManifest;
  captures: AgentRuntimeCaptureEntry[];
  clientRequests: ProviderAuditClientRequest[];
  rawProviderEvents: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "raw-provider-event" }
  >[];
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
  auditReport: ProviderAuditReport;
}

export interface ProviderAuditFixtureBundle {
  corpusId: string;
  providerId: string;
  taskId: string;
  fixturePath: string;
  manifestPath: string;
  manifest: ProviderAuditManifest;
  clientRequests: ProviderAuditClientRequest[];
  rawProviderEvents: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "raw-provider-event" }
  >[];
}

export interface ProviderAuditRunResult {
  outputDir: string;
  bundle: ProviderAuditBundle;
}

export interface ProviderAuditImportFixtureResult {
  corpusId: string;
  providerId: string;
  taskId: string;
  fixturePath: string;
}

export interface ProviderAuditImportFixturesResult {
  corpusId: string;
  fixtureRoot: string;
  fixtures: ProviderAuditImportFixtureResult[];
}

export interface ProviderAuditReplayFixtureResult {
  fixture: ProviderAuditFixtureBundle;
  bundle: ProviderAuditBundle;
  outputDir?: string;
}

export interface ProviderAuditReplayFixturesResult {
  fixtures: ProviderAuditReplayFixtureResult[];
}

export interface ProviderAuditCoverageFixtureIds {
  fixtureIds: string[];
}

export interface ProviderAuditCoverageRawEventSummary extends ProviderAuditCoverageFixtureIds {
  kind: string;
  classification: ProviderRawEventCoverage;
  totalCount: number;
}

export interface ProviderAuditCoverageTranslatedEventTypeSummary extends ProviderAuditCoverageFixtureIds {
  type: ThreadEvent["type"];
}

export interface ProviderAuditCoverageToolCallSummary extends ProviderAuditCoverageFixtureIds {
  key: string;
  displayName: string;
  coverage: ProviderObservedToolCallCoverage;
  totalCount: number;
}

export interface ProviderAuditProviderCoverageSummary {
  providerId: string;
  fixtureIds: string[];
  wellKnownToolNames: string[];
  rawEventKinds: ProviderAuditCoverageRawEventSummary[];
  translatedEventTypes: ProviderAuditCoverageTranslatedEventTypeSummary[];
  observedToolCalls: ProviderAuditCoverageToolCallSummary[];
}

export interface ProviderAuditFixtureCoverageSummary {
  providers: ProviderAuditProviderCoverageSummary[];
}

export interface ProviderAuditUnexpectedUntranslatedFixtureIssue {
  fixtureId: string;
  unexpectedUntranslatedRawEventCount: number;
}

export interface ProviderAuditUnknownRawEventKindIssue {
  providerId: string;
  kind: string;
  totalCount: number;
  fixtureIds: string[];
}

export interface ProviderAuditProviderUnhandledEventIssue {
  providerId: string;
  fixtureIds: string[];
}

export interface ProviderAuditUnknownObservedToolCallIssue {
  providerId: string;
  key: string;
  displayName: string;
  totalCount: number;
  fixtureIds: string[];
}

export interface ProviderAuditCoverageIssues {
  unexpectedUntranslatedFixtures: ProviderAuditUnexpectedUntranslatedFixtureIssue[];
  providersWithUnhandledEvents: ProviderAuditProviderUnhandledEventIssue[];
  unknownRawEventKinds: ProviderAuditUnknownRawEventKindIssue[];
  unknownObservedToolCalls: ProviderAuditUnknownObservedToolCallIssue[];
}

export interface ProviderAuditLadleFixture {
  id: string;
  corpusId: string;
  providerId: string;
  taskId: string;
  scenarioDescription: string;
  threadStatus: string;
  semanticTimelineRowCount: number;
  renderedTimelineRowCount: number;
  timelineRows: TimelineRow[];
}

export interface ProviderAuditLadleStoryData {
  fixtures: ProviderAuditLadleFixture[];
}

export interface ProviderAuditBuildLadleStoryDataArgs {
  replayed: ProviderAuditReplayFixturesResult;
}

export interface ProviderAuditExportLadleDataArgs extends ProviderAuditReplayFixturesArgs {
  outputPath: string;
}

export interface ProviderAuditExportLadleStoryDataArgs {
  outputPath: string;
  storyData: ProviderAuditLadleStoryData;
}

export interface ProviderAuditExportLadleDataResult {
  fixtureCount: number;
  outputPath: string;
}
