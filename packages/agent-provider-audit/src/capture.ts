import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  createAgentRuntime,
  getProviderVisibilityMetadata,
  type AgentRuntimeCaptureEntry,
} from "@bb/agent-runtime";
import {
  buildTimelineRows,
  decodeRow,
  formatTimelineAsText,
  toViewMessages,
} from "@bb/core-ui";
import {
  buildThreadEvent,
  buildThreadEventRow,
} from "@bb/domain";
import type { ThreadEventRow, ToolCallRequest, ToolCallResponse } from "@bb/domain";
import type {
  ProviderAuditBundle,
  ProviderAuditClientRequest,
  ProviderAuditCliArgs,
  ProviderAuditDebugRawEvent,
  ProviderAuditGitSnapshot,
  ProviderAuditManifest,
  ProviderAuditObservedToolCallSummary,
  ProviderAuditReport,
  ProviderAuditRawEventKindSummary,
  ProviderAuditRunResult,
  ProviderAuditScenario,
  ProviderAuditScenarioExecutionOptions,
  ProviderAuditScenarioOverride,
  ProviderAuditScenarioToolFixture,
  ProviderAuditUntranslatedRawEvent,
} from "./types.js";

const DEFAULT_PROVIDER_ID = "codex";
const DEFAULT_SCENARIO_ID = "excalidraw-ttd-explanation";
const DEFAULT_PROJECT_ID = "provider-audit";
const DEFAULT_THREAD_ID = "provider-audit-thread";
const DEFAULT_TIMEOUT_MS = 90_000;

interface BuildExecutionOptionsArgs {
  model?: string;
  execution?: ProviderAuditScenarioExecutionOptions;
}

interface ProviderAuditResolvedExecutionOptions {
  model: string;
  serviceTier: NonNullable<ProviderAuditScenarioExecutionOptions["serviceTier"]>;
  reasoningLevel: NonNullable<ProviderAuditScenarioExecutionOptions["reasoningLevel"]>;
  sandboxMode: NonNullable<ProviderAuditScenarioExecutionOptions["sandboxMode"]>;
}

const BUILT_IN_SCENARIOS: Record<string, ProviderAuditScenario> = {
  "excalidraw-ttd-explanation": {
    id: "excalidraw-ttd-explanation",
    description: "Provider-neutral explanation task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "I'm trying to understand Excalidraw's text-to-diagram flow before changing it. Please trace the flow from the dialog UI through chat history/state updates to the code that turns the final response into scene updates. Call out the main files, the key types, and any tricky state transitions or failure cases. Keep it grounded in the current codebase with specific file references.",
      "What's the safest extension point if I want to tweak the UI without changing the scene-generation logic?",
    ],
  },
  "excalidraw-search-feature": {
    id: "excalidraw-search-feature",
    description: "Provider-neutral feature task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "Add a small result summary to the canvas search sidebar: show `N results` when there are matches, show a clear `No matches found` empty state when the query is non-empty and there are none, and keep the existing keyboard navigation behavior intact. Update the relevant tests and validate the focused test file.",
      "Summarize the files you changed and the validation you ran.",
    ],
  },
  "excalidraw-search-bugfix": {
    id: "excalidraw-search-bugfix",
    description: "Provider-neutral bug-fix task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "There's a usability bug in the canvas search sidebar: if I navigate to a later match and then change the query so fewer matches remain, focus can end up pointing at nothing. Fix it so a query change resets focus to the first match when matches exist, and add a regression test validating the behavior.",
      "Explain why the regression would have failed before your change.",
    ],
  },
  "excalidraw-collab-startup-explanation": {
    id: "excalidraw-collab-startup-explanation",
    description:
      "Provider-neutral collaboration startup explanation task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "I'm trying to understand Excalidraw's collaboration startup flow before changing it. Please trace the path from the collaboration UI into room initialization, socket setup, first scene load, and the state changes that flip the app into collaboration mode. Call out the main files, the key types or state, and any tricky fallback or failure paths. Keep it grounded in the current codebase with specific file references.",
      "What's the safest extension point if I want to instrument room startup without changing behavior?",
    ],
  },
  "excalidraw-eyedropper-preview-bugfix": {
    id: "excalidraw-eyedropper-preview-bugfix",
    description:
      "Provider-neutral eyedropper preview bug-fix task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "There's a positioning bug in the eyedropper preview: near the viewport edges, the preview can end up off-screen instead of flipping to the other side of the pointer. Please fix the positioning so the preview stays visible inside the viewport and add focused coverage for the edge cases.",
      "Explain how the old positioning logic failed and how your regression coverage would have caught it.",
    ],
  },
  "excalidraw-magicframe-feature": {
    id: "excalidraw-magicframe-feature",
    description:
      "Provider-neutral Magic Frame feature task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "Make the Magic Frame AI workflow discoverable from the command or search experience on desktop. It should show up only when the existing AI feature is actually available, behave like the rest of the tool entries, and include focused coverage for the availability gating and action wiring.",
      "Summarize the user-visible behavior and the validation you ran.",
    ],
  },
  "excalidraw-eyedropper-browser-compat": {
    id: "excalidraw-eyedropper-browser-compat",
    description:
      "Provider-targeted eyedropper browser compatibility task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "I want to make Excalidraw's eyedropper experience friendlier on browsers with uneven platform support. Please inspect the current repo behavior and use the built-in WebSearch and WebFetch tools directly to verify the current browser/platform docs around the EyeDropper API before you recommend a change. Keep a todo list as you go and avoid delegating this research to a subagent.",
      "Implement that improvement with focused validation and keep the existing behavior for unsupported browsers intact.",
      "Summarize the external references you relied on and the files you changed.",
    ],
  },
  "excalidraw-command-palette-map": {
    id: "excalidraw-command-palette-map",
    description:
      "Provider-targeted command palette mapping task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "Use the available repo_outline helper first for the command and search area. Then use the built-in ls, find, and grep tools instead of bash while you inventory the relevant directories, trace the path from command registration to availability gating and action dispatch, and call out the safest insertion point for another gated action.",
      "Based on that map, add one small discoverability improvement for an existing gated action and include focused coverage.",
      "Summarize the directories you explored, the behavior change, and the validation you ran.",
    ],
    toolFixtures: [
      {
        tool: {
          name: "repo_outline",
          description:
            "Provide a compact high-level map of the relevant Excalidraw repo area so the agent can choose what to inspect next.",
          inputSchema: {
            type: "object",
            properties: {
              area: {
                type: "string",
                description: "The product area or concern to outline.",
              },
            },
            required: ["area"],
            additionalProperties: false,
          },
        },
        response: {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text:
                "High-level map for the command and search area:\n- packages/excalidraw/actions/ contains the registered action definitions and action metadata\n- packages/excalidraw/actions/register.ts and manager.tsx hold action registration and dispatch\n- packages/excalidraw/components/CommandPalette/ contains command palette item shaping, gating, and search UI\n- packages/excalidraw/components/App.tsx wires ActionManager and command palette setup\n- tests around actions and command/search behavior live under packages/excalidraw/tests and adjacent action test files",
            },
          ],
        },
      },
    ],
  },
  "excalidraw-share-web-compat": {
    id: "excalidraw-share-web-compat",
    description:
      "Provider-targeted share dialog web compatibility task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "Use the available repo_outline helper first for the share and collaboration area. Then inspect the actual code and implement one small discoverability improvement to the share dialog for unsupported browsers with focused validation. Keep the change minimal and move quickly.",
      "Summarize the helper output you used, the files you changed, and any outside references you consulted.",
    ],
    toolFixtures: [
      {
        tool: {
          name: "repo_outline",
          description:
            "Provide a compact high-level map of the relevant Excalidraw repo area so the agent can choose what to inspect next.",
          inputSchema: {
            type: "object",
            properties: {
              area: {
                type: "string",
                description: "The product area or concern to outline.",
              },
            },
            required: ["area"],
            additionalProperties: false,
          },
        },
        response: {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text:
                "High-level map for the share and collaboration area:\n- excalidraw-app/share/ contains the app-level share dialog and platform-specific share handling\n- excalidraw-app/data/ contains collaboration link helpers and room/share link data helpers\n- excalidraw-app/collab/ contains collaboration startup and room session wiring\n- packages/excalidraw contains shared share triggers, clipboard helpers, and command/search UI pieces\n- app-level and package-level tests cover share, collaboration, and command/search behavior",
            },
          ],
        },
      },
    ],
  },
};

interface PreparedAuditWorkspace {
  runtimeWorkspacePath: string;
  envWorkspacePath: string;
}

function printHelp(): void {
  const scenarioLines = Object.values(BUILT_IN_SCENARIOS)
    .map((scenario) => `  ${scenario.id.padEnd(24)} ${scenario.description}`)
    .join("\n");
  console.log(`Usage: bb-provider-audit [options]

Options:
  --provider <id>      Provider id. Default: ${DEFAULT_PROVIDER_ID}
  --scenario <id>      Scenario id. Default: ${DEFAULT_SCENARIO_ID}
  --prompt <text>      Override the first scenario prompt
  --model <id>         Optional model override
  --workspace <path>   Env/source workspace path. Default: current directory
  --output <path>      Output directory. Default: ${join(tmpdir(), "bb-provider-audit")}
  --thread-id <id>     Override the bb thread id used for the capture
  --project-id <id>    Override the bb project id used for the capture
  --git-reset-ref <r>  Reset the repo workspace to this git ref before and after capture
  --timeout-ms <ms>    Timeout waiting for turn completion. Default: ${DEFAULT_TIMEOUT_MS}
  --help               Show this message

Built-in scenarios:
${scenarioLines}`);
}

export function parseCliArgs(argv: string[]): ProviderAuditCliArgs {
  const args: ProviderAuditCliArgs = {
    providerId: DEFAULT_PROVIDER_ID,
    scenarioId: DEFAULT_SCENARIO_ID,
    workspacePath: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    if (token === "--") {
      continue;
    }
    if (token === "--provider" && next) {
      args.providerId = next;
      index += 1;
      continue;
    }
    if (token === "--scenario" && next) {
      args.scenarioId = next;
      index += 1;
      continue;
    }
    if (token === "--output" && next) {
      args.outputDir = resolve(next);
      index += 1;
      continue;
    }
    if (token === "--workspace" && next) {
      args.workspacePath = resolve(next);
      index += 1;
      continue;
    }
    if (token === "--model" && next) {
      args.model = next;
      index += 1;
      continue;
    }
    if (token === "--prompt" && next) {
      args.prompt = next;
      index += 1;
      continue;
    }
    if (token === "--thread-id" && next) {
      args.threadId = next;
      index += 1;
      continue;
    }
    if (token === "--project-id" && next) {
      args.projectId = next;
      index += 1;
      continue;
    }
    if (token === "--git-reset-ref" && next) {
      args.gitResetRef = next;
      index += 1;
      continue;
    }
    if (token === "--timeout-ms" && next) {
      args.timeoutMs = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function defaultOutputDir(providerId: string, scenarioId: string): string {
  const stamp = new Date().toISOString().replace(/[:]/g, "-");
  return join(
    tmpdir(),
    "bb-provider-audit",
    `${stamp}-${sanitizeSegment(providerId)}-${sanitizeSegment(scenarioId)}`,
  );
}

function getGitSha(workspacePath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function getGitStatusLines(workspacePath: string): string[] | null {
  try {
    const output = execFileSync(
      "git",
      ["status", "--short", "--untracked-files=all"],
      {
        cwd: workspacePath,
        encoding: "utf8",
      },
    ).trim();
    return output.length === 0 ? [] : output.split("\n");
  } catch {
    return null;
  }
}

function getGitSnapshot(workspacePath: string): ProviderAuditGitSnapshot | null {
  const headSha = getGitSha(workspacePath);
  const statusLines = getGitStatusLines(workspacePath);
  if (headSha === null || statusLines === null) {
    return null;
  }
  return {
    headSha,
    isClean: statusLines.length === 0,
    statusLines,
  };
}

function resetGitWorkspaceToRef(workspacePath: string, gitRef: string): void {
  try {
    execFileSync("git", ["reset", "--hard", gitRef], {
      cwd: workspacePath,
      encoding: "utf8",
      stdio: "pipe",
    });
    execFileSync("git", ["clean", "-fd"], {
      cwd: workspacePath,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to reset git workspace ${workspacePath} to ${gitRef}: ${detail}`,
    );
  }
}

function loadDotEnv(workspacePath: string): Record<string, string> {
  try {
    const content = readFileSync(join(workspacePath, ".env"), "utf8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex < 0) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim();
      if (key.length === 0) continue;
      if (process.env[key] === undefined) {
        env[key] = value;
      }
    }
    return env;
  } catch {
    return {};
  }
}

function cloneWorkspaceFiles(
  workspaceFiles: ProviderAuditScenario["workspaceFiles"],
): ProviderAuditScenario["workspaceFiles"] {
  return workspaceFiles?.map((file) => ({ ...file }));
}

function cloneToolFixtures(
  toolFixtures: ProviderAuditScenario["toolFixtures"],
): ProviderAuditScenario["toolFixtures"] {
  return toolFixtures?.map((fixture) => ({
    tool: {
      ...fixture.tool,
      inputSchema: JSON.parse(JSON.stringify(fixture.tool.inputSchema)),
    },
    response: structuredClone(fixture.response),
  }));
}

function applyScenarioOverride(
  scenario: ProviderAuditScenario,
  override: ProviderAuditScenarioOverride | undefined,
): ProviderAuditScenario {
  if (!override) {
    return scenario;
  }

  return {
    ...scenario,
    ...(override.turns ? { turns: override.turns.slice() } : {}),
    ...(override.execution
      ? { execution: { ...override.execution } }
      : {}),
    ...(override.workspaceMode ? { workspaceMode: override.workspaceMode } : {}),
    ...(override.workspaceFiles
      ? { workspaceFiles: cloneWorkspaceFiles(override.workspaceFiles) }
      : {}),
    ...(override.toolFixtures
      ? { toolFixtures: cloneToolFixtures(override.toolFixtures) }
      : {}),
  };
}

function resolveScenario(args: ProviderAuditCliArgs): ProviderAuditScenario {
  const scenarioTemplate = BUILT_IN_SCENARIOS[args.scenarioId];
  if (!scenarioTemplate) {
    throw new Error(`Unknown scenario "${args.scenarioId}"`);
  }

  const baseScenario: ProviderAuditScenario = {
    ...scenarioTemplate,
    turns: scenarioTemplate.turns.slice(),
    execution: scenarioTemplate.execution
      ? { ...scenarioTemplate.execution }
      : undefined,
    workspaceFiles: cloneWorkspaceFiles(scenarioTemplate.workspaceFiles),
    toolFixtures: cloneToolFixtures(scenarioTemplate.toolFixtures),
    providerOverrides: undefined,
  };
  const providerScenario = applyScenarioOverride(
    baseScenario,
    scenarioTemplate.providerOverrides?.[args.providerId],
  );

  return {
    ...providerScenario,
    turns:
      args.prompt && providerScenario.turns.length > 0
        ? [args.prompt, ...providerScenario.turns.slice(1)]
        : providerScenario.turns.slice(),
  };
}

function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs: number; label: string },
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const check = () => {
      if (predicate()) {
        resolvePromise();
        return;
      }
      if (Date.now() - startedAt > options.timeoutMs) {
        rejectPromise(
          new Error(
            `Timeout after ${options.timeoutMs}ms waiting for ${options.label}`,
          ),
        );
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function ensureDirectoryForFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function prepareScenarioWorkspace(args: {
  outputDir: string;
  scenario: ProviderAuditScenario;
  workspacePath: string;
}): PreparedAuditWorkspace {
  if (args.scenario.workspaceMode !== "scratch") {
    return {
      runtimeWorkspacePath: args.workspacePath,
      envWorkspacePath: args.workspacePath,
    };
  }

  const runtimeWorkspacePath = join(args.outputDir, "workspace");
  mkdirSync(runtimeWorkspacePath, { recursive: true });

  writeFileSync(
    join(runtimeWorkspacePath, "README.md"),
    "# Provider Audit Scratch Workspace\n",
  );

  for (const file of args.scenario.workspaceFiles ?? []) {
    const filePath = join(runtimeWorkspacePath, file.path);
    ensureDirectoryForFile(filePath);
    writeFileSync(filePath, file.content);
  }

  return {
    runtimeWorkspacePath,
    envWorkspacePath: args.workspacePath,
  };
}

function buildExecutionOptions(
  args: BuildExecutionOptionsArgs,
): ProviderAuditResolvedExecutionOptions {
  return {
    model: args.model ?? "provider-default",
    serviceTier: args.execution?.serviceTier ?? "fast",
    reasoningLevel: args.execution?.reasoningLevel ?? "medium",
    sandboxMode: args.execution?.sandboxMode ?? "danger-full-access",
  };
}

function buildClientRequestRows(args: {
  clientRequests: ProviderAuditClientRequest[];
  execution?: ProviderAuditScenarioExecutionOptions;
  model?: string;
  threadId: string;
}): ThreadEventRow[] {
  const execution = buildExecutionOptions({
    model: args.model,
    execution: args.execution,
  });

  return args.clientRequests.map((request) => {
    return buildThreadEventRow({
      id: request.id,
      threadId: args.threadId,
      seq: 0,
      createdAt: request.createdAt,
      event: {
        type: request.type,
        threadId: args.threadId,
        direction: "outbound",
        source: "tell",
        initiator: "user",
        input: [{ type: "text", text: request.text }],
        request: {
          method: request.requestMethod,
          params: {},
        },
        execution: {
          ...execution,
          source: request.type,
        },
      },
    });
  });
}

function buildThreadEventRows(args: {
  translatedCaptures: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "translated-thread-event" }
  >[];
  clientRequests: ProviderAuditClientRequest[];
  execution?: ProviderAuditScenarioExecutionOptions;
  model?: string;
  threadId: string;
}): ThreadEventRow[] {
  const clientRows = buildClientRequestRows({
    clientRequests: args.clientRequests,
    execution: args.execution,
    model: args.model,
    threadId: args.threadId,
  });

  const providerRows = args.translatedCaptures.map((entry, index) => {
    return buildThreadEventRow({
      id: `audit-row-${index + 1}`,
      threadId: entry.event.threadId,
      seq: 0,
      createdAt: entry.capturedAt,
      event: entry.event,
    });
  });

  return [...clientRows, ...providerRows]
    .map((row, index) => ({
      row,
      index,
      priority: row.type.startsWith("client/") ? 0 : 1,
    }))
    .sort((left, right) => {
      if (left.row.createdAt !== right.row.createdAt) {
        return left.row.createdAt - right.row.createdAt;
      }
      if (left.priority !== right.priority) {
        return left.priority - right.priority;
      }
      return left.index - right.index;
    })
    .map((entry, index) => buildThreadEventRow({
      id: entry.row.id,
      threadId: entry.row.threadId,
      seq: index + 1,
      createdAt: entry.row.createdAt,
      event: buildThreadEvent(entry.row),
    }));
}

function buildRawEventKindSummaries(
  rawProviderEvents: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "raw-provider-event" }
  >[],
): ProviderAuditRawEventKindSummary[] {
  if (rawProviderEvents.length === 0) {
    return [];
  }

  const visibility = getProviderVisibilityMetadata(rawProviderEvents[0].providerId);
  const countsByKindAndClassification = new Map<string, ProviderAuditRawEventKindSummary>();

  for (const entry of rawProviderEvents) {
    const parsedRawEvent = visibility.parseRawEvent(entry.rawEvent);
    const description = visibility.describeParsedRawEvent(parsedRawEvent);
    const mapKey = `${description.coverage}:${description.kind}`;
    const existing = countsByKindAndClassification.get(mapKey);
    if (existing) {
      existing.count += 1;
      continue;
    }
    countsByKindAndClassification.set(mapKey, {
      kind: description.kind,
      classification: description.coverage,
      count: 1,
    });
  }

  return [...countsByKindAndClassification.values()].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }
    return left.classification.localeCompare(right.classification);
  });
}

function buildUntranslatedRawProviderEvents(
  rawProviderEvents: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "raw-provider-event" }
  >[],
  translatedCaptures: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "translated-thread-event" }
  >[],
): ProviderAuditUntranslatedRawEvent[] {
  if (rawProviderEvents.length === 0) {
    return [];
  }

  const visibility = getProviderVisibilityMetadata(rawProviderEvents[0].providerId);
  const translatedCountByRawCaptureId = new Map<string, number>();
  for (const entry of translatedCaptures) {
    if (!entry.rawCaptureId) continue;
    translatedCountByRawCaptureId.set(
      entry.rawCaptureId,
      (translatedCountByRawCaptureId.get(entry.rawCaptureId) ?? 0) + 1,
    );
  }

  return rawProviderEvents
    .filter((entry) => !translatedCountByRawCaptureId.has(entry.captureId))
    .map((entry) => {
      const parsedRawEvent = visibility.parseRawEvent(entry.rawEvent);
      const description = visibility.describeParsedRawEvent(parsedRawEvent);
      return {
        captureId: entry.captureId,
        method: entry.rawEvent.method,
        kind: description.kind,
        capturedAt: entry.capturedAt,
        classification: description.coverage,
      };
    });
}

function buildObservedToolCalls(
  rawProviderEvents: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "raw-provider-event" }
  >[],
): ProviderAuditObservedToolCallSummary[] {
  if (rawProviderEvents.length === 0) {
    return [];
  }

  const visibility = getProviderVisibilityMetadata(rawProviderEvents[0].providerId);
  const countsByToolKey = new Map<string, ProviderAuditObservedToolCallSummary>();

  for (const entry of rawProviderEvents) {
    const parsedRawEvent = visibility.parseRawEvent(entry.rawEvent);
    const observedToolCalls = visibility.extractObservedToolCallsFromParsed(parsedRawEvent);
    for (const observedToolCall of observedToolCalls) {
      const existing = countsByToolKey.get(observedToolCall.key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      countsByToolKey.set(observedToolCall.key, {
        key: observedToolCall.key,
        displayName: observedToolCall.displayName,
        coverage: observedToolCall.coverage,
        count: 1,
      });
    }
  }

  return [...countsByToolKey.values()].sort((left, right) => {
    if (left.key !== right.key) {
      return left.key.localeCompare(right.key);
    }
    return left.coverage.localeCompare(right.coverage);
  });
}

function buildDebugRawEvents(
  viewMessages: ProviderAuditBundle["auditViewMessages"],
): ProviderAuditDebugRawEvent[] {
  return viewMessages
    .filter((message) => message.kind === "debug/raw-event")
    .map((message) => ({
      messageId: message.id,
      rawType: message.rawType,
      reason: message.reason,
      sourceSeqStart: message.sourceSeqStart,
      sourceSeqEnd: message.sourceSeqEnd,
    }));
}

function buildAuditReport(args: {
  rawProviderEvents: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "raw-provider-event" }
  >[];
  translatedCaptures: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "translated-thread-event" }
  >[];
  viewMessages: ProviderAuditBundle["viewMessages"];
  auditViewMessages: ProviderAuditBundle["auditViewMessages"];
  timelineRows: ProviderAuditBundle["timelineRows"];
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
  processLifecycle: ProviderAuditBundle["processLifecycle"];
}): ProviderAuditReport {
  const rawEventKinds = buildRawEventKindSummaries(args.rawProviderEvents);
  const untranslatedRawProviderEvents = buildUntranslatedRawProviderEvents(
    args.rawProviderEvents,
    args.translatedCaptures,
  );
  const unexpectedUntranslatedRawProviderEvents = untranslatedRawProviderEvents.filter(
    (entry) => entry.classification !== "noise",
  );
  const debugRawEvents = buildDebugRawEvents(args.auditViewMessages);
  const observedToolCalls = buildObservedToolCalls(args.rawProviderEvents);
  const normalizedRawEventCount = rawEventKinds
    .filter((entry) => entry.classification === "normalized")
    .reduce((total, entry) => total + entry.count, 0);
  const noiseRawEventCount = rawEventKinds
    .filter((entry) => entry.classification === "noise")
    .reduce((total, entry) => total + entry.count, 0);
  const unknownRawEventCount = rawEventKinds
    .filter((entry) => entry.classification === "unknown")
    .reduce((total, entry) => total + entry.count, 0);
  const wellKnownObservedToolCallCount = observedToolCalls
    .filter((entry) => entry.coverage === "well-known")
    .reduce((total, entry) => total + entry.count, 0);
  const acceptedFallbackObservedToolCallCount = observedToolCalls
    .filter((entry) => entry.coverage === "accepted-fallback")
    .reduce((total, entry) => total + entry.count, 0);
  const unknownObservedToolCallCount = observedToolCalls
    .filter((entry) => entry.coverage === "unknown")
    .reduce((total, entry) => total + entry.count, 0);
  const wellKnownToolNames =
    args.rawProviderEvents.length > 0
      ? [...getProviderVisibilityMetadata(args.rawProviderEvents[0].providerId).wellKnownToolNames]
      : [];
  const attentionNeeded: string[] = [];

  if (unexpectedUntranslatedRawProviderEvents.length > 0) {
    attentionNeeded.push(
      `${unexpectedUntranslatedRawProviderEvents.length} raw provider event(s) expected translation but produced no ThreadEvent`,
    );
  }
  if (debugRawEvents.length > 0) {
    attentionNeeded.push(
      `${debugRawEvents.length} provider-agnostic event(s) still fall back to debug/raw-event output`,
    );
  }
  if (args.toolCallResults.some((entry) => entry.success === false)) {
    attentionNeeded.push("At least one provider tool call failed in the runtime hook");
  }
  if (unknownObservedToolCallCount > 0) {
    attentionNeeded.push(
      `${unknownObservedToolCallCount} observed tool call(s) are not yet classified as well-known or accepted fallback`,
    );
  }

  return {
    summary: {
      rawProviderEventCount: args.rawProviderEvents.length,
      translatedThreadEventCount: args.translatedCaptures.length,
      viewMessageCount: args.viewMessages.length,
      timelineRowCount: args.timelineRows.length,
      debugRawEventCount: debugRawEvents.length,
      unexpectedUntranslatedRawEventCount:
        unexpectedUntranslatedRawProviderEvents.length,
      toolCallRequestCount: args.toolCallRequests.length,
      toolCallResultCount: args.toolCallResults.length,
      providerStderrCount: args.providerStderr.length,
      processLifecycleCount: args.processLifecycle.length,
      normalizedRawEventCount,
      noiseRawEventCount,
      unknownRawEventCount,
      wellKnownObservedToolCallCount,
      acceptedFallbackObservedToolCallCount,
      unknownObservedToolCallCount,
    },
    rawProviderMethods: [
      ...new Set(args.rawProviderEvents.map((entry) => entry.rawEvent.method)),
    ],
    rawProviderEventKinds: [...new Set(rawEventKinds.map((entry) => entry.kind))],
    rawEventKinds,
    translatedEventTypes: [
      ...new Set(args.translatedCaptures.map((entry) => entry.event.type)),
    ],
    untranslatedRawProviderEvents,
    unexpectedUntranslatedRawProviderEvents,
    debugRawEvents,
    toolCalls: {
      requestCount: args.toolCallRequests.length,
      resultCount: args.toolCallResults.length,
      failedCount: args.toolCallResults.filter((entry) => entry.success === false)
        .length,
    },
    wellKnownToolNames,
    observedToolCalls,
    providerStderr: {
      lineCount: args.providerStderr.length,
      sample: args.providerStderr.slice(0, 20),
    },
    processLifecycle: args.processLifecycle,
    attentionNeeded,
  };
}

function writeJson(outputDir: string, fileName: string, value: object): void {
  writeFileSync(join(outputDir, fileName), JSON.stringify(value, null, 2) + "\n");
}

function cloneCaptureEntry(entry: AgentRuntimeCaptureEntry): AgentRuntimeCaptureEntry {
  return structuredClone(entry);
}

function buildToolFixturesByName(
  scenario: ProviderAuditScenario,
): Map<string, ProviderAuditScenarioToolFixture> {
  const byName = new Map<string, ProviderAuditScenarioToolFixture>();
  for (const fixture of scenario.toolFixtures ?? []) {
    byName.set(fixture.tool.name, fixture);
  }
  return byName;
}

function buildDefaultToolResponse(request: ToolCallRequest): ToolCallResponse {
  return {
    contentItems: [
      {
        type: "inputText",
        text: `tool:${request.tool} ok`,
      },
    ],
    success: true,
  };
}

async function runScenario(args: {
  runtime: ReturnType<typeof createAgentRuntime>;
  scenario: ProviderAuditScenario;
  providerId: string;
  model?: string;
  threadId: string;
  projectId: string;
  clientRequests: ProviderAuditClientRequest[];
  translatedCaptures: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "translated-thread-event" }
  >[];
  timeoutMs: number;
}): Promise<void> {
  const executionOptions = buildExecutionOptions({
    model: args.model,
    execution: args.scenario.execution,
  });

  await args.runtime.startThread({
    environmentId: `${args.threadId}-env`,
    threadId: args.threadId,
    projectId: args.projectId,
    providerId: args.providerId,
    options: executionOptions,
    dynamicTools: args.scenario.toolFixtures?.map((fixture) => fixture.tool),
  });

  for (let index = 0; index < args.scenario.turns.length; index += 1) {
    const targetTurnCount = index + 1;
    args.clientRequests.push({
      id: `audit-client-row-${index + 1}`,
      turnIndex: index,
      type: index === 0 ? "client/thread/start" : "client/turn/requested",
      requestMethod: index === 0 ? "thread/start" : "turn/start",
      text: args.scenario.turns[index],
      createdAt: Date.now(),
    });
    await args.runtime.runTurn({
      threadId: args.threadId,
      input: [{ type: "text", text: args.scenario.turns[index] }],
      options: buildExecutionOptions({
        model: args.model,
        execution: args.scenario.execution,
      }),
    });
    await waitForCondition(
      () =>
        args.translatedCaptures.filter(
          (entry) => entry.event.type === "turn/completed",
        ).length >= targetTurnCount,
      {
        timeoutMs: args.timeoutMs,
        label: `turn ${targetTurnCount} completion`,
      },
    );
  }
}

function buildManifest(args: {
  providerId: string;
  scenario: ProviderAuditScenario;
  model?: string;
  workspacePath: string;
  runtimeWorkspacePath: string;
  envWorkspacePath: string;
  outputDir: string;
  threadId: string;
  projectId: string;
  capturedAt: number;
  completedAt: number;
  gitResetRef?: string;
  runtimeWorkspaceGitStart: ProviderAuditGitSnapshot | null;
  runtimeWorkspaceGitEnd: ProviderAuditGitSnapshot | null;
}): ProviderAuditManifest {
  return {
    providerId: args.providerId,
    scenarioId: args.scenario.id,
    scenarioDescription: args.scenario.description,
    model: args.model ?? null,
    source: "live-capture",
    capturedAt: args.capturedAt,
    completedAt: args.completedAt,
    gitSha: getGitSha(args.workspacePath),
    workspacePath: args.workspacePath,
    runtimeWorkspacePath: args.runtimeWorkspacePath,
    envWorkspacePath: args.envWorkspacePath,
    outputDir: args.outputDir,
    threadId: args.threadId,
    projectId: args.projectId,
    turns: args.scenario.turns,
    gitResetRef: args.gitResetRef ?? null,
    runtimeWorkspaceGitStart: args.runtimeWorkspaceGitStart,
    runtimeWorkspaceGitEnd: args.runtimeWorkspaceGitEnd,
  };
}

export function buildBundle(args: {
  manifest: ProviderAuditManifest;
  captures: AgentRuntimeCaptureEntry[];
  clientRequests: ProviderAuditClientRequest[];
  execution?: ProviderAuditScenarioExecutionOptions;
  model?: string;
}): ProviderAuditBundle {
  const rawProviderEvents = args.captures.filter(
    (entry): entry is Extract<
      AgentRuntimeCaptureEntry,
      { kind: "raw-provider-event" }
    > => entry.kind === "raw-provider-event",
  );
  const translatedCaptures = args.captures.filter(
    (entry): entry is Extract<
      AgentRuntimeCaptureEntry,
      { kind: "translated-thread-event" }
    > => entry.kind === "translated-thread-event",
  );
  const toolCallRequests = args.captures.filter(
    (entry): entry is Extract<
      AgentRuntimeCaptureEntry,
      { kind: "tool-call-request" }
    > => entry.kind === "tool-call-request",
  );
  const toolCallResults = args.captures.filter(
    (entry): entry is Extract<
      AgentRuntimeCaptureEntry,
      { kind: "tool-call-result" }
    > => entry.kind === "tool-call-result",
  );
  const providerStderr = args.captures.filter(
    (entry): entry is Extract<
      AgentRuntimeCaptureEntry,
      { kind: "provider-stderr" }
    > => entry.kind === "provider-stderr",
  );
  const processLifecycle = args.captures.filter(
    (
      entry,
    ): entry is Extract<
      AgentRuntimeCaptureEntry,
      { kind: "provider-process-error" | "provider-process-exit" }
    > =>
      entry.kind === "provider-process-error" ||
      entry.kind === "provider-process-exit",
  );
  const threadEvents = translatedCaptures.map((entry) => entry.event);
  const threadEventRows = buildThreadEventRows({
    translatedCaptures,
    clientRequests: args.clientRequests,
    execution: args.execution,
    model: args.model,
    threadId: args.manifest.threadId,
  });
  const decodedRows = threadEventRows.map((row) => decodeRow(row));
  const viewMessages = toViewMessages(decodedRows, { threadStatus: "idle" });
  const auditViewMessages = toViewMessages(decodedRows, {
    threadStatus: "idle",
    includeDebugRawEvents: true,
  });
  const timelineRows = buildTimelineRows(viewMessages);
  const timelineText = formatTimelineAsText(timelineRows, {
    verbose: false,
    color: false,
  });
  const timelineVerboseText = formatTimelineAsText(timelineRows, {
    verbose: true,
    color: false,
  });
  const auditReport = buildAuditReport({
    rawProviderEvents,
    translatedCaptures,
    viewMessages,
    auditViewMessages,
    timelineRows,
    toolCallRequests,
    toolCallResults,
    providerStderr,
    processLifecycle,
  });

  return {
    manifest: args.manifest,
    captures: args.captures,
    clientRequests: args.clientRequests,
    rawProviderEvents,
    translatedCaptures,
    toolCallRequests,
    toolCallResults,
    providerStderr,
    processLifecycle,
    threadEvents,
    threadEventRows,
    viewMessages,
    auditViewMessages,
    timelineRows,
    timelineText,
    timelineVerboseText,
    auditReport,
  };
}

export function writeBundle(bundle: ProviderAuditBundle): void {
  mkdirSync(bundle.manifest.outputDir, { recursive: true });
  writeJson(bundle.manifest.outputDir, "manifest.json", bundle.manifest);
  writeJson(bundle.manifest.outputDir, "client-requests.json", bundle.clientRequests);
  writeJson(
    bundle.manifest.outputDir,
    "raw-provider-events.json",
    bundle.rawProviderEvents,
  );
  writeJson(bundle.manifest.outputDir, "thread-events.json", bundle.threadEvents);
  writeJson(
    bundle.manifest.outputDir,
    "thread-event-rows.json",
    bundle.threadEventRows,
  );
  writeJson(bundle.manifest.outputDir, "view-messages.json", bundle.viewMessages);
  writeJson(
    bundle.manifest.outputDir,
    "view-messages.audit.json",
    bundle.auditViewMessages,
  );
  writeJson(bundle.manifest.outputDir, "timeline-rows.json", bundle.timelineRows);
  writeJson(bundle.manifest.outputDir, "audit-report.json", bundle.auditReport);
  writeFileSync(
    join(bundle.manifest.outputDir, "timeline.txt"),
    bundle.timelineText + "\n",
  );
  writeFileSync(
    join(bundle.manifest.outputDir, "timeline.verbose.txt"),
    bundle.timelineVerboseText + "\n",
  );
}

export async function runProviderAuditCapture(
  args: ProviderAuditCliArgs,
): Promise<ProviderAuditRunResult> {
  const scenario = resolveScenario(args);
  const outputDir = args.outputDir ?? defaultOutputDir(args.providerId, args.scenarioId);
  const threadId = args.threadId ?? DEFAULT_THREAD_ID;
  const projectId = args.projectId ?? DEFAULT_PROJECT_ID;
  const preparedWorkspace = prepareScenarioWorkspace({
    outputDir,
    scenario,
    workspacePath: args.workspacePath,
  });
  const captures: AgentRuntimeCaptureEntry[] = [];
  const clientRequests: ProviderAuditClientRequest[] = [];
  const translatedCaptures: Extract<
    AgentRuntimeCaptureEntry,
    { kind: "translated-thread-event" }
  >[] = [];
  const toolFixturesByName = buildToolFixturesByName(scenario);
  if (args.gitResetRef) {
    if (scenario.workspaceMode === "scratch") {
      throw new Error(
        "--git-reset-ref can only be used with repo-backed scenarios",
      );
    }
    resetGitWorkspaceToRef(preparedWorkspace.runtimeWorkspacePath, args.gitResetRef);
  }
  const runtimeWorkspaceGitStart = getGitSnapshot(
    preparedWorkspace.runtimeWorkspacePath,
  );
  try {
    const capturedAt = Date.now();
    const runtime = createAgentRuntime({
      workspacePath: preparedWorkspace.runtimeWorkspacePath,
      env: loadDotEnv(preparedWorkspace.envWorkspacePath),
      onEvent: () => {},
      onCapture: (entry) => {
        const clonedEntry = cloneCaptureEntry(entry);
        captures.push(clonedEntry);
        if (clonedEntry.kind === "translated-thread-event") {
          translatedCaptures.push(clonedEntry);
        }
      },
      onToolCall: async (request) => {
        const fixture = toolFixturesByName.get(request.tool);
        if (fixture) {
          return structuredClone(fixture.response);
        }
        return buildDefaultToolResponse(request);
      },
    });
    try {
      await runScenario({
        runtime,
        scenario,
        providerId: args.providerId,
        model: args.model,
        threadId,
        projectId,
        clientRequests,
        translatedCaptures,
        timeoutMs: args.timeoutMs,
      });
    } finally {
      await runtime.shutdown();
    }

    const completedAt = Date.now();
    const runtimeWorkspaceGitEnd = getGitSnapshot(
      preparedWorkspace.runtimeWorkspacePath,
    );
    const manifest = buildManifest({
      providerId: args.providerId,
      scenario,
      model: args.model,
      workspacePath: args.workspacePath,
      runtimeWorkspacePath: preparedWorkspace.runtimeWorkspacePath,
      envWorkspacePath: preparedWorkspace.envWorkspacePath,
      outputDir,
      threadId,
      projectId,
      capturedAt,
      completedAt,
      gitResetRef: args.gitResetRef,
      runtimeWorkspaceGitStart,
      runtimeWorkspaceGitEnd,
    });
    const bundle = buildBundle({
      manifest,
      captures,
      clientRequests,
      execution: scenario.execution,
      model: args.model,
    });
    writeBundle(bundle);
    return {
      outputDir,
      bundle,
    };
  } finally {
    if (args.gitResetRef) {
      resetGitWorkspaceToRef(preparedWorkspace.runtimeWorkspacePath, args.gitResetRef);
    }
  }
}
