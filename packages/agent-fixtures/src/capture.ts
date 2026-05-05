import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAgentRuntime } from "@bb/agent-runtime";
import type { AgentRuntimeCaptureEntry } from "@bb/agent-runtime/capture";
import {
  buildThreadTimelineFromEvents,
  decodeThreadEventRow,
  formatThreadTimelineText,
} from "@bb/thread-view";
import {
  buildThreadEvent,
  buildThreadEventRow,
  encodeClientTurnRequestIdNumber,
  threadScope,
} from "@bb/domain";
import type {
  ResolvedThreadExecutionOptions,
  ThreadEventRow,
  ToolCallRequest,
  ToolCallResponse,
} from "@bb/domain";
import type { RuntimeThreadExecutionOptions } from "@bb/domain";
import {
  REPLAY_CAPTURE_SCHEMA_VERSION,
  createReplayCaptureId,
  replayRawProviderCaptureEntrySchema,
  type ReplayCaptureTurn,
  type ReplayRawProviderCaptureEntry,
  type ReplayRawProviderEventRecord,
} from "@bb/replay-capture";
import {
  deriveReplayCaptureUserInputPreview,
  serializeReplayRawProviderEventRecords,
  writeFixture,
} from "@bb/replay-capture/writer";
import {
  fixtureManifestSchema,
  type FixtureManifest,
} from "./corpus-schema.js";
import type {
  FixtureCliArgs,
  FixtureGitSnapshot,
  FixtureReplayBundle,
  FixtureRunResult,
  FixtureScenario,
  FixtureScenarioExecutionOptions,
  FixtureScenarioOverride,
  FixtureScenarioToolFixture,
} from "./types.js";

const DEFAULT_PROVIDER_ID = "codex";
const DEFAULT_SCENARIO_ID = "excalidraw-ttd-explanation";
const DEFAULT_PROJECT_ID = "agent-fixtures";
const DEFAULT_THREAD_ID = "agent-fixtures-thread";
const DEFAULT_TIMEOUT_MS = 90_000;
const CAPTURE_CORPUS_ID = "agent-fixtures";

interface BuildExecutionOptionsArgs {
  model?: string;
  execution?: FixtureScenarioExecutionOptions;
}

type FixtureResolvedExecutionOptions = RuntimeThreadExecutionOptions;
type RuntimeRawProviderEventCaptureEntry = Extract<
  AgentRuntimeCaptureEntry,
  { kind: "raw-provider-event" }
>;

const BUILT_IN_SCENARIOS: Record<string, FixtureScenario> = {
  "excalidraw-ttd-explanation": {
    id: "excalidraw-ttd-explanation",
    description:
      "Provider-neutral explanation task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "I'm trying to understand Excalidraw's text-to-diagram flow before changing it. Please trace the flow from the dialog UI through chat history/state updates to the code that turns the final response into scene updates. Call out the main files, the key types, and any tricky state transitions or failure cases. Keep it grounded in the current codebase with specific file references.",
      "What's the safest extension point if I want to tweak the UI without changing the scene-generation logic?",
    ],
  },
  "excalidraw-search-feature": {
    id: "excalidraw-search-feature",
    description:
      "Provider-neutral feature task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "Add a small result summary to the canvas search sidebar: show `N results` when there are matches, show a clear `No matches found` empty state when the query is non-empty and there are none, and keep the existing keyboard navigation behavior intact. Update the relevant tests and validate the focused test file.",
      "Summarize the files you changed and the validation you ran.",
    ],
  },
  "excalidraw-search-bugfix": {
    id: "excalidraw-search-bugfix",
    description:
      "Provider-neutral bug-fix task against the real Excalidraw repo",
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
              text: "High-level map for the command and search area:\n- packages/excalidraw/actions/ contains the registered action definitions and action metadata\n- packages/excalidraw/actions/register.ts and manager.tsx hold action registration and dispatch\n- packages/excalidraw/components/CommandPalette/ contains command palette item shaping, gating, and search UI\n- packages/excalidraw/components/App.tsx wires ActionManager and command palette setup\n- tests around actions and command/search behavior live under packages/excalidraw/tests and adjacent action test files",
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
              text: "High-level map for the share and collaboration area:\n- excalidraw-app/share/ contains the app-level share dialog and platform-specific share handling\n- excalidraw-app/data/ contains collaboration link helpers and room/share link data helpers\n- excalidraw-app/collab/ contains collaboration startup and room session wiring\n- packages/excalidraw contains shared share triggers, clipboard helpers, and command/search UI pieces\n- app-level and package-level tests cover share, collaboration, and command/search behavior",
            },
          ],
        },
      },
    ],
  },
  "excalidraw-command-output-recovery": {
    id: "excalidraw-command-output-recovery",
    description:
      "Provider-targeted delayed shell output task against the real Excalidraw repo",
    workspaceMode: "repo",
    turns: [
      "Run this shell command exactly once from the current working directory: `printf 'FIRST\\n'; sleep 1; printf 'SECOND\\n'; sleep 1; printf 'THIRD\\n'`. Use your real shell tool, preserve the full command output on the completed command item, and then reply with exactly DONE.",
    ],
  },
};

interface PreparedFixtureWorkspace {
  runtimeWorkspacePath: string;
  envWorkspacePath: string;
}

function printHelp(): void {
  const scenarioLines = Object.values(BUILT_IN_SCENARIOS)
    .map((scenario) => `  ${scenario.id.padEnd(24)} ${scenario.description}`)
    .join("\n");
  console.log(`Usage: bb-fixtures capture [options]

Options:
  --provider <id>      Provider id. Default: ${DEFAULT_PROVIDER_ID}
  --scenario <id>      Scenario id. Default: ${DEFAULT_SCENARIO_ID}
  --prompt <text>      Override the first scenario prompt
  --model <id>         Optional model override
  --workspace <path>   Env/source workspace path. Default: current directory
  --output <path>      Output directory. Default: ${join(tmpdir(), "bb-fixtures")}
  --thread-id <id>     Override the bb thread id used for the capture
  --project-id <id>    Override the bb project id used for the capture
  --git-reset-ref <r>  Reset the repo workspace to this git ref before and after capture
  --timeout-ms <ms>    Timeout waiting for turn completion. Default: ${DEFAULT_TIMEOUT_MS}
  --help               Show this message

Built-in scenarios:
${scenarioLines}`);
}

export function parseCliArgs(argv: string[]): FixtureCliArgs {
  const args: FixtureCliArgs = {
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
    "bb-fixtures",
    `${stamp}-${sanitizeSegment(providerId)}-${sanitizeSegment(scenarioId)}`,
  );
}

function createRandomReplayCaptureSuffix(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
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

function getGitSnapshot(workspacePath: string): FixtureGitSnapshot | null {
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
  workspaceFiles: FixtureScenario["workspaceFiles"],
): FixtureScenario["workspaceFiles"] {
  return workspaceFiles?.map((file) => ({ ...file }));
}

function cloneToolFixtures(
  toolFixtures: FixtureScenario["toolFixtures"],
): FixtureScenario["toolFixtures"] {
  return toolFixtures?.map((fixture) => ({
    tool: {
      ...fixture.tool,
      inputSchema: JSON.parse(JSON.stringify(fixture.tool.inputSchema)),
    },
    response: structuredClone(fixture.response),
  }));
}

function applyScenarioOverride(
  scenario: FixtureScenario,
  override: FixtureScenarioOverride | undefined,
): FixtureScenario {
  if (!override) {
    return scenario;
  }

  return {
    ...scenario,
    ...(override.turns ? { turns: override.turns.slice() } : {}),
    ...(override.execution ? { execution: { ...override.execution } } : {}),
    ...(override.workspaceMode
      ? { workspaceMode: override.workspaceMode }
      : {}),
    ...(override.workspaceFiles
      ? { workspaceFiles: cloneWorkspaceFiles(override.workspaceFiles) }
      : {}),
    ...(override.toolFixtures
      ? { toolFixtures: cloneToolFixtures(override.toolFixtures) }
      : {}),
  };
}

function resolveScenario(args: FixtureCliArgs): FixtureScenario {
  const scenarioTemplate = BUILT_IN_SCENARIOS[args.scenarioId];
  if (!scenarioTemplate) {
    throw new Error(`Unknown scenario "${args.scenarioId}"`);
  }

  const baseScenario: FixtureScenario = {
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
  scenario: FixtureScenario;
  workspacePath: string;
}): PreparedFixtureWorkspace {
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
    "# Fixture Scratch Workspace\n",
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

function buildScenarioEnvironmentId(threadId: string): string {
  return `${threadId}-env`;
}

function buildExecutionOptions(
  args: BuildExecutionOptionsArgs,
): FixtureResolvedExecutionOptions {
  const base = {
    model: args.model ?? "provider-default",
    serviceTier: args.execution?.serviceTier ?? "fast",
    reasoningLevel: args.execution?.reasoningLevel ?? "medium",
  };
  const permissionMode = args.execution?.permissionMode ?? "full";
  if (permissionMode === "full") {
    return {
      ...base,
      permissionMode,
      permissionEscalation: null,
    };
  }
  return {
    ...base,
    permissionMode,
    permissionEscalation: "ask",
  };
}

function buildResolvedExecutionOptions(args: {
  execution?: FixtureScenarioExecutionOptions;
  model?: string;
}): ResolvedThreadExecutionOptions {
  return {
    model: args.model ?? "provider-default",
    serviceTier: args.execution?.serviceTier ?? "fast",
    reasoningLevel: args.execution?.reasoningLevel ?? "medium",
    permissionMode: args.execution?.permissionMode ?? "full",
    source: "client/turn/requested",
  };
}

function buildClientRequestRows(args: {
  execution: ResolvedThreadExecutionOptions;
  threadId: string;
  turns: ReplayCaptureTurn[];
}): ThreadEventRow[] {
  return args.turns.map((turn, index) => {
    const isFirstTurn = index === 0;
    return buildThreadEventRow({
      id: `fixture-client-row-${index + 1}`,
      scope: threadScope(),
      threadId: args.threadId,
      seq: 0,
      createdAt: turn.createdAt,
      event: {
        type: "client/turn/requested",
        threadId: args.threadId,
        scope: threadScope(),
        direction: "outbound",
        requestId: encodeClientTurnRequestIdNumber({ value: index + 1 }),
        source: "tell",
        initiator: "user",
        input: turn.userInput,
        target: isFirstTurn ? { kind: "thread-start" } : { kind: "new-turn" },
        request: {
          method: isFirstTurn ? "thread/start" : "turn/start",
          params: {},
        },
        execution: {
          ...args.execution,
          source: "client/turn/requested",
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
  execution: ResolvedThreadExecutionOptions;
  threadId: string;
  turns: ReplayCaptureTurn[];
}): ThreadEventRow[] {
  const clientRows = buildClientRequestRows({
    execution: args.execution,
    threadId: args.threadId,
    turns: args.turns,
  });

  const providerRows = args.translatedCaptures.map((entry, index) => {
    return buildThreadEventRow({
      id: `fixture-row-${index + 1}`,
      scope: entry.event.scope,
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
    .map((entry, index) =>
      buildThreadEventRow({
        id: entry.row.id,
        scope: entry.row.scope,
        threadId: entry.row.threadId,
        seq: index + 1,
        createdAt: entry.row.createdAt,
        event: buildThreadEvent(entry.row),
      }),
    );
}

function writeJson(outputDir: string, fileName: string, value: object): void {
  writeFileSync(
    join(outputDir, fileName),
    JSON.stringify(value, null, 2) + "\n",
  );
}

function buildRawProviderEventRecords(
  bundle: FixtureReplayBundle,
): ReplayRawProviderEventRecord[] {
  return bundle.rawProviderEvents.map((entry, index) => ({
    ordinal: index + 1,
    relativeMs: Math.max(0, entry.capturedAt - bundle.manifest.capturedAt),
    entry,
  }));
}

function writeRawProviderEventRecords(
  outputDir: string,
  records: ReplayRawProviderEventRecord[],
): void {
  writeFileSync(
    join(outputDir, "raw-provider-events.ndjson"),
    serializeReplayRawProviderEventRecords(records),
  );
}

function writeBundleArtifacts(
  outputDir: string,
  bundle: FixtureReplayBundle,
): void {
  writeJson(outputDir, "thread-events.json", bundle.threadEvents);
  writeJson(outputDir, "thread-event-rows.json", bundle.threadEventRows);
  writeJson(outputDir, "timeline-rows.json", bundle.timelineRows);
  writeFileSync(join(outputDir, "timeline.txt"), bundle.timelineText + "\n");
  writeFileSync(
    join(outputDir, "timeline.verbose.txt"),
    bundle.timelineVerboseText + "\n",
  );
}

function cloneCaptureEntry(
  entry: AgentRuntimeCaptureEntry,
): AgentRuntimeCaptureEntry {
  return structuredClone(entry);
}

function isRuntimeRawProviderEventCaptureEntry(
  entry: AgentRuntimeCaptureEntry,
): entry is RuntimeRawProviderEventCaptureEntry {
  return entry.kind === "raw-provider-event";
}

function toReplayRawProviderCaptureEntry(
  entry: RuntimeRawProviderEventCaptureEntry,
): ReplayRawProviderCaptureEntry {
  return replayRawProviderCaptureEntrySchema.parse(entry);
}

function buildToolFixturesByName(
  scenario: FixtureScenario,
): Map<string, FixtureScenarioToolFixture> {
  const byName = new Map<string, FixtureScenarioToolFixture>();
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
  captureId: string;
  runtime: ReturnType<typeof createAgentRuntime>;
  scenario: FixtureScenario;
  providerId: string;
  model?: string;
  threadId: string;
  projectId: string;
  turns: ReplayCaptureTurn[];
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
    environmentId: buildScenarioEnvironmentId(args.threadId),
    threadId: args.threadId,
    projectId: args.projectId,
    providerId: args.providerId,
    options: executionOptions,
    dynamicTools: args.scenario.toolFixtures?.map((fixture) => fixture.tool),
  });

  for (let index = 0; index < args.scenario.turns.length; index += 1) {
    const targetTurnCount = index + 1;
    const requestId = encodeClientTurnRequestIdNumber({ value: index + 1 });
    args.turns.push({
      turnId: `turn_${index}_${args.captureId}`,
      userInput: [{ type: "text", text: args.scenario.turns[index] }],
      createdAt: Date.now(),
    });
    await args.runtime.runTurn({
      threadId: args.threadId,
      clientRequestId: requestId,
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
  captureId: string;
  corpusId: string;
  providerId: string;
  scenario: FixtureScenario;
  model?: string;
  workspacePath: string;
  runtimeWorkspacePath: string;
  envWorkspacePath: string;
  threadId: string;
  projectId: string;
  environmentId: string;
  capturedAt: number;
  completedAt: number;
  gitResetRef?: string;
  rawProviderEventCount: number;
  runtimeWorkspaceGitStart: FixtureGitSnapshot | null;
  runtimeWorkspaceGitEnd: FixtureGitSnapshot | null;
  turns: ReplayCaptureTurn[];
}): FixtureManifest {
  const firstTurn = args.turns[0];
  if (!firstTurn) {
    throw new Error("Cannot build fixture manifest without turns");
  }

  return fixtureManifestSchema.parse({
    schemaVersion: REPLAY_CAPTURE_SCHEMA_VERSION,
    captureId: args.captureId,
    providerId: args.providerId,
    capturedAt: args.capturedAt,
    completedAt: args.completedAt,
    source: "corpus-fixture",
    projectId: args.projectId,
    environmentId: args.environmentId,
    threadId: args.threadId,
    providerThreadId: null,
    title: args.scenario.description,
    kind: "thread-start",
    turns: args.turns,
    userInputPreview: deriveReplayCaptureUserInputPreview(firstTurn.userInput),
    execution: buildResolvedExecutionOptions({
      model: args.model,
      execution: args.scenario.execution,
    }),
    eventCounts: {
      rawProviderEvents: args.rawProviderEventCount,
      droppedRecords: 0,
    },
    errorMessage: null,
    corpusId: args.corpusId,
    scenarioId: args.scenario.id,
    scenarioDescription: args.scenario.description,
    model: args.model ?? null,
    gitSha: getGitSha(args.workspacePath),
    workspacePath: args.workspacePath,
    runtimeWorkspacePath: args.runtimeWorkspacePath,
    envWorkspacePath: args.envWorkspacePath,
    gitResetRef: args.gitResetRef ?? null,
    runtimeWorkspaceGitStart: args.runtimeWorkspaceGitStart,
    runtimeWorkspaceGitEnd: args.runtimeWorkspaceGitEnd,
  });
}

export function buildBundle(args: {
  manifest: FixtureManifest;
  captures: AgentRuntimeCaptureEntry[];
  outputDir?: string;
}): FixtureReplayBundle {
  const rawProviderEvents = args.captures
    .filter(isRuntimeRawProviderEventCaptureEntry)
    .map(toReplayRawProviderCaptureEntry);
  const translatedCaptures = args.captures.filter(
    (
      entry,
    ): entry is Extract<
      AgentRuntimeCaptureEntry,
      { kind: "translated-thread-event" }
    > => entry.kind === "translated-thread-event",
  );
  const toolCallRequests = args.captures.filter(
    (
      entry,
    ): entry is Extract<
      AgentRuntimeCaptureEntry,
      { kind: "tool-call-request" }
    > => entry.kind === "tool-call-request",
  );
  const toolCallResults = args.captures.filter(
    (
      entry,
    ): entry is Extract<
      AgentRuntimeCaptureEntry,
      { kind: "tool-call-result" }
    > => entry.kind === "tool-call-result",
  );
  const providerStderr = args.captures.filter(
    (
      entry,
    ): entry is Extract<
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
    execution: args.manifest.execution,
    threadId: args.manifest.threadId,
    turns: args.manifest.turns,
  });
  const decodedRows = threadEventRows.map((row) => decodeThreadEventRow(row));
  const timelineProjection = buildThreadTimelineFromEvents({
    contextWindowEvents: decodedRows,
    events: decodedRows,
    options: {
      includeDebugRawEvents: false,
      includeNestedRows: false,
      includeOptionalOperations: false,
      includeProviderUnhandledOperations: false,
      systemClientRequestVisibility: "hidden",
      threadStatus: "idle",
      turnMessageDetail: "summary",
      viewMode: "standard",
    },
  });
  const verboseTimelineProjection = buildThreadTimelineFromEvents({
    contextWindowEvents: decodedRows,
    events: decodedRows,
    options: {
      includeDebugRawEvents: false,
      includeNestedRows: true,
      includeOptionalOperations: false,
      includeProviderUnhandledOperations: false,
      systemClientRequestVisibility: "hidden",
      threadStatus: "idle",
      turnMessageDetail: "full",
      viewMode: "standard",
    },
  });
  const timelineRows = timelineProjection.rows;
  const verboseTimelineRows = verboseTimelineProjection.rows;
  const timelineText = formatThreadTimelineText(timelineRows, {
    verbose: false,
    color: false,
  });
  const timelineVerboseText = formatThreadTimelineText(verboseTimelineRows, {
    verbose: true,
    color: false,
  });

  return {
    manifest: args.manifest,
    captures: args.captures,
    outputDir: args.outputDir ?? null,
    rawProviderEvents,
    translatedCaptures,
    toolCallRequests,
    toolCallResults,
    providerStderr,
    processLifecycle,
    threadEvents,
    threadEventRows,
    contextWindowUsage: timelineProjection.contextWindowUsage,
    timelineRows,
    timelineText,
    timelineVerboseRows: verboseTimelineRows,
    timelineVerboseText,
  };
}

export function writeBundle(bundle: FixtureReplayBundle): void {
  if (bundle.outputDir === null) {
    throw new Error("Cannot write fixture bundle without outputDir");
  }
  mkdirSync(bundle.outputDir, { recursive: true });
  writeJson(bundle.outputDir, "manifest.json", bundle.manifest);
  writeRawProviderEventRecords(
    bundle.outputDir,
    buildRawProviderEventRecords(bundle),
  );
  writeBundleArtifacts(bundle.outputDir, bundle);
}

async function writeCapturedBundle(bundle: FixtureReplayBundle): Promise<void> {
  if (bundle.outputDir === null) {
    throw new Error("Cannot write fixture capture without outputDir");
  }
  await writeFixture({
    destinationDir: bundle.outputDir,
    manifest: bundle.manifest,
    rawProviderEventRecords: buildRawProviderEventRecords(bundle),
  });
  writeBundleArtifacts(bundle.outputDir, bundle);
}

export async function runFixtureCapture(
  args: FixtureCliArgs,
): Promise<FixtureRunResult> {
  const scenario = resolveScenario(args);
  const outputDir =
    args.outputDir ?? defaultOutputDir(args.providerId, args.scenarioId);
  const threadId = args.threadId ?? DEFAULT_THREAD_ID;
  const projectId = args.projectId ?? DEFAULT_PROJECT_ID;
  const environmentId = buildScenarioEnvironmentId(threadId);
  const preparedWorkspace = prepareScenarioWorkspace({
    outputDir,
    scenario,
    workspacePath: args.workspacePath,
  });
  const captures: AgentRuntimeCaptureEntry[] = [];
  const turns: ReplayCaptureTurn[] = [];
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
    resetGitWorkspaceToRef(
      preparedWorkspace.runtimeWorkspacePath,
      args.gitResetRef,
    );
  }
  const runtimeWorkspaceGitStart = getGitSnapshot(
    preparedWorkspace.runtimeWorkspacePath,
  );
  try {
    const capturedAt = Date.now();
    const captureId = createReplayCaptureId(
      capturedAt,
      createRandomReplayCaptureSuffix(),
    );
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
        captureId,
        runtime,
        scenario,
        providerId: args.providerId,
        model: args.model,
        threadId,
        projectId,
        turns,
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
      captureId,
      corpusId: CAPTURE_CORPUS_ID,
      providerId: args.providerId,
      scenario,
      model: args.model,
      workspacePath: args.workspacePath,
      runtimeWorkspacePath: preparedWorkspace.runtimeWorkspacePath,
      envWorkspacePath: preparedWorkspace.envWorkspacePath,
      threadId,
      projectId,
      environmentId,
      capturedAt,
      completedAt,
      gitResetRef: args.gitResetRef,
      rawProviderEventCount: captures.filter(
        (entry) => entry.kind === "raw-provider-event",
      ).length,
      runtimeWorkspaceGitStart,
      runtimeWorkspaceGitEnd,
      turns,
    });
    const bundle = buildBundle({
      manifest,
      captures,
      outputDir,
    });
    await writeCapturedBundle(bundle);
    return {
      outputDir,
      bundle,
    };
  } finally {
    if (args.gitResetRef) {
      resetGitWorkspaceToRef(
        preparedWorkspace.runtimeWorkspacePath,
        args.gitResetRef,
      );
    }
  }
}
