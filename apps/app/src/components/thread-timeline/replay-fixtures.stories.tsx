import type { Story } from "@ladle/react";
import { z } from "zod";
import type { FixtureBundle, FixtureManifest } from "@bb/agent-fixtures";
import { parseFixtureBundleFromJson } from "@bb/agent-fixtures/load-browser";
import type {
  TimelineFileChange,
  TimelineRow,
  TimelineRowBase,
  TimelineRowStatus,
  TimelineToolArgs,
} from "@bb/server-contract";
import { jsonValueSchema, type JsonObject, type JsonValue } from "@bb/domain";
import { TimelineRowsStory } from "./timeline-story-fixtures.js";

export default {
  title: "Thread Timeline/Replay Fixtures",
};

type FixtureId =
  | "dev-replays/claude-code/cap_mom0xkzo_3atb06ph"
  | "dev-replays/codex/cap_mol1xza1_zclp97wz"
  | "excalidraw/claude-code/collab-startup-explanation"
  | "excalidraw/claude-code/eyedropper-browser-compat"
  | "excalidraw/claude-code/eyedropper-preview-bugfix"
  | "excalidraw/claude-code/magicframe-feature"
  | "excalidraw/claude-code/search-bugfix"
  | "excalidraw/claude-code/search-feature"
  | "excalidraw/claude-code/ttd-explanation"
  | "excalidraw/codex/collab-startup-explanation"
  | "excalidraw/codex/command-output-recovery"
  | "excalidraw/codex/eyedropper-preview-bugfix"
  | "excalidraw/codex/magicframe-feature"
  | "excalidraw/codex/search-bugfix"
  | "excalidraw/codex/search-feature"
  | "excalidraw/codex/share-web-compat"
  | "excalidraw/codex/ttd-explanation"
  | "excalidraw/pi/collab-startup-explanation"
  | "excalidraw/pi/command-palette-map"
  | "excalidraw/pi/eyedropper-preview-bugfix"
  | "excalidraw/pi/magicframe-feature"
  | "excalidraw/pi/search-bugfix"
  | "excalidraw/pi/search-feature"
  | "excalidraw/pi/ttd-explanation";

type FixtureProviderId = FixtureManifest["providerId"];
type FixtureTurn = FixtureManifest["turns"][number];
type FixtureTurnInput = FixtureTurn["userInput"][number];

interface FixtureStoryEntry {
  bundle: FixtureBundle;
  id: string;
  rows: TimelineRow[];
}

interface FixtureReplayProps {
  fixtureId: FixtureId;
}

interface ReplayBuildState {
  nextSourceSeq: number;
  rows: TimelineRow[];
  threadId: string;
}

interface RowBaseArgs {
  id: string;
  createdAt: number;
  turnId?: string | null;
}

interface AddSystemRowArgs {
  detail: string | null;
  id: string;
  status: TimelineRowStatus | null;
  title: string;
  createdAt: number;
}

interface AddAssistantRowArgs {
  id: string;
  text: string;
  createdAt: number;
}

interface AddCommandRowArgs {
  id: string;
  command: string;
  output: string;
  status: TimelineRowStatus;
  createdAt: number;
  exitCode?: number | null;
}

interface AddToolRowArgs {
  id: string;
  label: string;
  output: string;
  status: TimelineRowStatus;
  toolArgs: TimelineToolArgs;
  toolName: string;
  createdAt: number;
}

interface AddFileChangeRowsArgs {
  changes: readonly TimelineFileChange[];
  id: string;
  status: TimelineRowStatus;
  createdAt: number;
}

interface PiToolStart {
  args: JsonObject | null;
  toolName: string;
}

interface ProviderProjectionState {
  piToolStartsById: Map<string, PiToolStart>;
}

interface ProjectProviderEventArgs {
  build: ReplayBuildState;
  event: FixtureBundle["rawProviderEvents"][number];
  provider: FixtureProviderId;
  projection: ProviderProjectionState;
}

interface ProjectCodexItemArgs {
  build: ReplayBuildState;
  event: FixtureBundle["rawProviderEvents"][number];
}

interface ProjectClaudeSdkMessageArgs {
  build: ReplayBuildState;
  event: FixtureBundle["rawProviderEvents"][number];
  message: ClaudeSdkMessage;
}

interface ProjectPiSdkMessageArgs {
  build: ReplayBuildState;
  event: FixtureBundle["rawProviderEvents"][number];
  message: PiSdkMessage;
  projection: ProviderProjectionState;
}

interface FixturePathParts {
  fixtureId: string;
  kind: "manifest" | "events";
}

const FIXTURE_PATH_MARKER = "packages/agent-fixtures/fixtures/";

const manifestModules = import.meta.glob<object>(
  "../../../../../packages/agent-fixtures/fixtures/**/manifest.json",
  { eager: true, import: "default" },
);

const eventModules = import.meta.glob<string>(
  "../../../../../packages/agent-fixtures/fixtures/**/raw-provider-events.ndjson",
  { eager: true, query: "?raw", import: "default" },
);

const rawItemEventSchema = z
  .object({
    method: z.enum(["item/started", "item/completed"]),
    params: z
      .object({
        item: z
          .object({
            id: z.string().optional(),
            type: z.string(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const rawErrorEventSchema = z
  .object({
    method: z.literal("error"),
    params: z
      .object({
        message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const sdkMessageEnvelopeSchema = z
  .object({
    method: z.literal("sdk/message"),
    params: z
      .object({
        message: jsonValueSchema,
      })
      .passthrough(),
  })
  .passthrough();

const textBlockSchema = z
  .object({
    content: jsonValueSchema.optional(),
    id: z.string().optional(),
    input: jsonValueSchema.optional(),
    is_error: z.boolean().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    type: z.string(),
  })
  .passthrough();

const codexCommandItemSchema = z
  .object({
    id: z.string(),
    type: z.literal("commandExecution"),
    command: z.string().optional(),
    aggregatedOutput: z.string().optional(),
    cwd: z.string().nullable().optional(),
    exitCode: z.number().nullable().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const codexToolItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    tool: z.string().optional(),
    name: z.string().optional(),
    result: jsonValueSchema.optional(),
    status: z.string().optional(),
  })
  .passthrough();

const rawFileChangeSchema = z
  .object({
    path: z.string(),
    diff: z.string().nullable().optional(),
    kind: z
      .union([
        z.string(),
        z
          .object({
            type: z.string(),
            move_path: z.string().nullable().optional(),
          })
          .passthrough(),
      ])
      .nullable()
      .optional(),
  })
  .passthrough();

const codexFileChangeItemSchema = z
  .object({
    id: z.string(),
    type: z.literal("fileChange"),
    changes: z.array(rawFileChangeSchema),
    status: z.string().optional(),
  })
  .passthrough();

const claudeSdkMessageSchema = z
  .object({
    type: z.string(),
    message: z
      .object({
        content: z.array(textBlockSchema).optional(),
      })
      .passthrough()
      .optional(),
    content: z.array(textBlockSchema).optional(),
  })
  .passthrough();

const piSdkMessageSchema = z
  .object({
    type: z.string(),
    assistantMessageEvent: z
      .object({
        content: z.string().optional(),
        delta: z.string().optional(),
        type: z.string(),
      })
      .passthrough()
      .optional(),
    messages: z
      .array(
        z
          .object({
            role: z.string(),
            content: z.array(textBlockSchema).optional(),
            errorMessage: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    args: jsonValueSchema.optional(),
    result: jsonValueSchema.optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

type RawFileChange = z.infer<typeof rawFileChangeSchema>;
type ClaudeSdkMessage = z.infer<typeof claudeSdkMessageSchema>;
type PiSdkMessage = z.infer<typeof piSdkMessageSchema>;

function createFixtureStory(fixtureId: FixtureId): Story {
  const FixtureStory: Story = () => <FixtureReplay fixtureId={fixtureId} />;
  FixtureStory.storyName = fixtureId;
  return FixtureStory;
}

function parseFixturePath(path: string): FixturePathParts | null {
  const markerIndex = path.indexOf(FIXTURE_PATH_MARKER);
  if (markerIndex < 0) {
    return null;
  }

  const fixturePath = path.slice(markerIndex + FIXTURE_PATH_MARKER.length);
  if (fixturePath.endsWith("/manifest.json")) {
    return {
      fixtureId: fixturePath.replace(/\/manifest\.json$/u, ""),
      kind: "manifest",
    };
  }
  if (fixturePath.endsWith("/raw-provider-events.ndjson")) {
    return {
      fixtureId: fixturePath.replace(/\/raw-provider-events\.ndjson$/u, ""),
      kind: "events",
    };
  }
  return null;
}

function buildFixtureEntries(): Map<string, FixtureStoryEntry> {
  const eventsByFixtureId = new Map<string, string>();
  for (const [path, eventsNdjson] of Object.entries(eventModules)) {
    const parsedPath = parseFixturePath(path);
    if (parsedPath?.kind === "events") {
      eventsByFixtureId.set(parsedPath.fixtureId, eventsNdjson);
    }
  }

  const entries = new Map<string, FixtureStoryEntry>();
  for (const [path, manifestJson] of Object.entries(manifestModules)) {
    const parsedPath = parseFixturePath(path);
    if (parsedPath?.kind !== "manifest") {
      continue;
    }
    const eventsNdjson = eventsByFixtureId.get(parsedPath.fixtureId);
    if (!eventsNdjson) {
      continue;
    }
    const bundle = parseFixtureBundleFromJson({ manifestJson, eventsNdjson });
    entries.set(parsedPath.fixtureId, {
      bundle,
      id: parsedPath.fixtureId,
      rows: projectFixtureTimelineRows(bundle),
    });
  }
  return entries;
}

const fixtureEntries = buildFixtureEntries();

function getFixtureEntry(fixtureId: FixtureId): FixtureStoryEntry {
  const entry = fixtureEntries.get(fixtureId);
  if (!entry) {
    throw new Error(`Missing replay fixture story data: ${fixtureId}`);
  }
  return entry;
}

function rowBase(state: ReplayBuildState, args: RowBaseArgs): TimelineRowBase {
  const seq = state.nextSourceSeq;
  state.nextSourceSeq += 1;
  return {
    id: args.id,
    threadId: state.threadId,
    turnId: args.turnId ?? null,
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    startedAt: args.createdAt,
    createdAt: args.createdAt,
  };
}

function addRow(state: ReplayBuildState, row: TimelineRow): void {
  state.rows.push(row);
}

function addSystemRow(state: ReplayBuildState, args: AddSystemRowArgs): void {
  addRow(state, {
    ...rowBase(state, {
      id: args.id,
      createdAt: args.createdAt,
    }),
    kind: "system",
    systemKind: args.status === "error" ? "error" : "operation",
    title: args.title,
    detail: args.detail,
    status: args.status,
  });
}

function addAssistantRow(
  state: ReplayBuildState,
  args: AddAssistantRowArgs,
): void {
  if (args.text.trim().length === 0) {
    return;
  }
  addRow(state, {
    ...rowBase(state, {
      id: args.id,
      createdAt: args.createdAt,
    }),
    kind: "conversation",
    role: "assistant",
    text: args.text.trim(),
    attachments: null,
    userRequest: null,
  });
}

function addCommandRow(state: ReplayBuildState, args: AddCommandRowArgs): void {
  addRow(state, {
    ...rowBase(state, {
      id: args.id,
      createdAt: args.createdAt,
    }),
    kind: "work",
    workKind: "command",
    status: args.status,
    callId: args.id,
    command: args.command,
    cwd: "",
    source: "fixture-replay",
    output: args.output,
    exitCode: args.exitCode ?? (args.status === "completed" ? 0 : null),
    completedAt: args.status === "pending" ? null : args.createdAt,
    approvalStatus: null,
    activityIntents: [],
  });
}

function addToolRow(state: ReplayBuildState, args: AddToolRowArgs): void {
  addRow(state, {
    ...rowBase(state, {
      id: args.id,
      createdAt: args.createdAt,
    }),
    kind: "work",
    workKind: "tool",
    status: args.status,
    callId: args.id,
    toolName: args.toolName,
    toolArgs: args.toolArgs,
    label: args.label,
    output: args.output,
    completedAt: args.status === "pending" ? null : args.createdAt,
    approvalStatus: null,
    activityIntents: [],
  });
}

function addFileChangeRows(
  state: ReplayBuildState,
  args: AddFileChangeRowsArgs,
): void {
  args.changes.forEach((change, index) => {
    addRow(state, {
      ...rowBase(state, {
        id: `${args.id}-${index + 1}`,
        createdAt: args.createdAt,
      }),
      kind: "work",
      workKind: "file-change",
      status: args.status,
      callId: `${args.id}-${index + 1}`,
      change,
      stdout: null,
      stderr: null,
      approvalStatus: null,
    });
  });
}

function buildSummaryDetail(bundle: FixtureBundle): string {
  const manifest = bundle.manifest;
  const parts = [
    `provider: ${manifest.providerId}`,
    `raw events: ${bundle.rawProviderEvents.length}`,
    `turns: ${manifest.turns.length}`,
    manifest.model ? `model: ${manifest.model}` : null,
    manifest.runtimeWorkspaceGitEnd?.statusLines.length
      ? `git changes: ${manifest.runtimeWorkspaceGitEnd.statusLines.length}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.join("\n");
}

function addManifestRows(state: ReplayBuildState, bundle: FixtureBundle): void {
  addSystemRow(state, {
    id: `${bundle.manifest.captureId}-summary`,
    title: bundle.manifest.scenarioDescription,
    detail: buildSummaryDetail(bundle),
    status: bundle.manifest.errorMessage ? "error" : "completed",
    createdAt: bundle.manifest.capturedAt,
  });

  bundle.manifest.turns.forEach((turn, index) => {
    addRow(state, {
      ...rowBase(state, {
        id: `${bundle.manifest.captureId}-turn-${index + 1}-request`,
        createdAt: turn.createdAt,
        turnId: turn.turnId,
      }),
      kind: "conversation",
      role: "user",
      text: turnText(turn),
      attachments: null,
      userRequest: {
        kind: "message",
        status: "accepted",
      },
    });
  });
}

function turnText(turn: FixtureTurn): string {
  return turn.userInput.map(turnInputText).join("\n\n");
}

function turnInputText(input: FixtureTurnInput): string {
  switch (input.type) {
    case "text":
      return input.text;
    case "image":
      return `[image: ${input.url}]`;
    case "localImage":
      return `[local image: ${input.path}]`;
    case "localFile":
      return `[file: ${input.path}]`;
  }
}

function projectFixtureTimelineRows(bundle: FixtureBundle): TimelineRow[] {
  const build: ReplayBuildState = {
    nextSourceSeq: 1,
    rows: [],
    threadId: bundle.manifest.threadId,
  };
  const projection: ProviderProjectionState = {
    piToolStartsById: new Map<string, PiToolStart>(),
  };

  addManifestRows(build, bundle);
  for (const event of bundle.rawProviderEvents) {
    projectProviderEvent({
      build,
      event,
      provider: bundle.manifest.providerId,
      projection,
    });
  }
  return build.rows;
}

function projectProviderEvent({
  build,
  event,
  provider,
  projection,
}: ProjectProviderEventArgs): void {
  if (provider === "codex") {
    projectCodexItem({ build, event });
    return;
  }

  const errorEvent = rawErrorEventSchema.safeParse(event.rawEvent);
  if (errorEvent.success) {
    addSystemRow(build, {
      id: event.captureId,
      title: "Provider error",
      detail: errorEvent.data.params?.message ?? null,
      status: "error",
      createdAt: event.capturedAt,
    });
    return;
  }

  const sdkEnvelope = sdkMessageEnvelopeSchema.safeParse(event.rawEvent);
  if (!sdkEnvelope.success) {
    return;
  }

  if (provider === "claude-code") {
    const message = claudeSdkMessageSchema.safeParse(
      sdkEnvelope.data.params.message,
    );
    if (message.success) {
      projectClaudeSdkMessage({ build, event, message: message.data });
    }
    return;
  }

  if (provider === "pi") {
    const message = piSdkMessageSchema.safeParse(
      sdkEnvelope.data.params.message,
    );
    if (message.success) {
      projectPiSdkMessage({
        build,
        event,
        message: message.data,
        projection,
      });
    }
  }
}

function projectCodexItem({ build, event }: ProjectCodexItemArgs): void {
  const itemEvent = rawItemEventSchema.safeParse(event.rawEvent);
  if (!itemEvent.success || itemEvent.data.method !== "item/completed") {
    return;
  }

  const commandItem = codexCommandItemSchema.safeParse(
    itemEvent.data.params.item,
  );
  if (commandItem.success) {
    addCommandRow(build, {
      id: commandItem.data.id,
      command: commandItem.data.command ?? "command",
      output: commandItem.data.aggregatedOutput ?? "",
      status: workStatus(commandItem.data.status),
      exitCode: commandItem.data.exitCode,
      createdAt: event.capturedAt,
    });
    return;
  }

  const fileChangeItem = codexFileChangeItemSchema.safeParse(
    itemEvent.data.params.item,
  );
  if (fileChangeItem.success) {
    addFileChangeRows(build, {
      id: fileChangeItem.data.id,
      changes: fileChangeItem.data.changes.map(toTimelineFileChange),
      status: workStatus(fileChangeItem.data.status),
      createdAt: event.capturedAt,
    });
    return;
  }

  const item = codexToolItemSchema.safeParse(itemEvent.data.params.item);
  if (item.success && shouldRenderCodexToolItem(item.data.type)) {
    addToolRow(build, {
      id: item.data.id,
      label: item.data.name ?? item.data.tool ?? item.data.type,
      output: stringifyToolOutput(item.data.result),
      status: workStatus(item.data.status),
      toolArgs: null,
      toolName: item.data.name ?? item.data.tool ?? item.data.type,
      createdAt: event.capturedAt,
    });
  }
}

function projectClaudeSdkMessage({
  build,
  event,
  message,
}: ProjectClaudeSdkMessageArgs): void {
  if (message.type === "assistant" && message.message?.content) {
    const text = textFromBlocks(message.message.content);
    if (text) {
      addAssistantRow(build, {
        id: `${event.captureId}-assistant`,
        text,
        createdAt: event.capturedAt,
      });
    }

    message.message.content.forEach((block, index) => {
      if (block.type !== "tool_use") {
        return;
      }
      const toolName = block.name ?? "tool";
      addToolRow(build, {
        id: block.id ?? `${event.captureId}-tool-${index + 1}`,
        label: toolName,
        output: "",
        status: "completed",
        toolArgs: toJsonObject(block.input),
        toolName,
        createdAt: event.capturedAt,
      });
    });
    return;
  }

  if (message.type === "user" && message.message?.content) {
    message.message.content.forEach((block, index) => {
      if (block.type !== "tool_result") {
        return;
      }
      const output = block.text ?? stringifyToolOutput(block.content);
      addToolRow(build, {
        id: `${event.captureId}-tool-result-${index + 1}`,
        label: "Tool result",
        output,
        status: block.is_error ? "error" : "completed",
        toolArgs: null,
        toolName: "ToolResult",
        createdAt: event.capturedAt,
      });
    });
  }
}

function projectPiSdkMessage({
  build,
  event,
  message,
  projection,
}: ProjectPiSdkMessageArgs): void {
  switch (message.type) {
    case "agent_end": {
      const lastAssistant = [...(message.messages ?? [])]
        .reverse()
        .find((candidate) => candidate.role === "assistant");
      if (lastAssistant?.errorMessage) {
        addSystemRow(build, {
          id: `${event.captureId}-pi-error`,
          title: "Pi assistant error",
          detail: lastAssistant.errorMessage,
          status: "error",
          createdAt: event.capturedAt,
        });
        return;
      }
      const text = lastAssistant?.content
        ? textFromBlocks(lastAssistant.content)
        : null;
      if (text) {
        addAssistantRow(build, {
          id: `${event.captureId}-assistant`,
          text,
          createdAt: event.capturedAt,
        });
      }
      return;
    }
    case "tool_execution_start": {
      if (message.toolCallId && message.toolName) {
        projection.piToolStartsById.set(message.toolCallId, {
          args: toJsonObject(message.args),
          toolName: message.toolName,
        });
      }
      return;
    }
    case "tool_execution_end": {
      if (!message.toolCallId || !message.toolName) {
        return;
      }
      const started = projection.piToolStartsById.get(message.toolCallId);
      const status: TimelineRowStatus = message.isError ? "error" : "completed";
      if (message.toolName === "bash") {
        addCommandRow(build, {
          id: message.toolCallId,
          command: optionalString(started?.args?.command) ?? "bash",
          output: stringifyToolOutput(message.result),
          status,
          exitCode: message.isError ? 1 : 0,
          createdAt: event.capturedAt,
        });
        return;
      }
      if (message.toolName === "edit" || message.toolName === "write") {
        const change = fileChangeFromToolArgs(started?.args);
        if (change) {
          addFileChangeRows(build, {
            id: message.toolCallId,
            changes: [change],
            status,
            createdAt: event.capturedAt,
          });
          return;
        }
      }
      addToolRow(build, {
        id: message.toolCallId,
        label: message.toolName,
        output: stringifyToolOutput(message.result),
        status,
        toolArgs: started?.args ?? null,
        toolName: message.toolName,
        createdAt: event.capturedAt,
      });
      return;
    }
    default:
      return;
  }
}

function shouldRenderCodexToolItem(type: string): boolean {
  return (
    type === "mcpToolCall" ||
    type === "toolCall" ||
    type === "webSearch" ||
    type === "webFetch"
  );
}

function workStatus(status: string | undefined): TimelineRowStatus {
  switch (status) {
    case "inProgress":
    case "pending":
      return "pending";
    case "failed":
    case "error":
      return "error";
    case "interrupted":
    case "declined":
      return "interrupted";
    default:
      return "completed";
  }
}

function toTimelineFileChange(change: RawFileChange): TimelineFileChange {
  const kind =
    typeof change.kind === "string" ? change.kind : (change.kind?.type ?? null);
  const movePath =
    typeof change.kind === "object" && change.kind !== null
      ? (change.kind.move_path ?? null)
      : null;
  const diff = change.diff ?? null;
  return {
    path: change.path,
    kind,
    movePath,
    diff,
    diffStats: diffStats(diff),
  };
}

function fileChangeFromToolArgs(args: JsonObject | null | undefined) {
  const path = optionalString(args?.path);
  if (!path) {
    return null;
  }
  const oldText = optionalString(args?.oldText);
  const newText =
    optionalString(args?.newText) ?? optionalString(args?.content);
  const diff =
    newText !== null ? `@@ -1 +1 @@\n-${oldText ?? ""}\n+${newText}\n` : null;
  return {
    path,
    kind: oldText === null ? "add" : "update",
    movePath: null,
    diff,
    diffStats: diffStats(diff),
  };
}

function diffStats(diff: string | null): TimelineFileChange["diffStats"] {
  if (!diff) {
    return {
      added: 0,
      removed: 0,
    };
  }
  const lines = diff.split("\n");
  return {
    added: lines.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++"),
    ).length,
    removed: lines.filter(
      (line) => line.startsWith("-") && !line.startsWith("---"),
    ).length,
  };
}

function textFromBlocks(blocks: readonly z.infer<typeof textBlockSchema>[]) {
  const text = blocks
    .map((block) => block.text)
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

function stringifyToolOutput(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

function optionalString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonObject(value: JsonValue | undefined): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function FixtureReplay({ fixtureId }: FixtureReplayProps) {
  const entry = getFixtureEntry(fixtureId);
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="rounded-md border border-border/70 bg-background p-3">
          <div className="truncate text-sm font-semibold">
            {entry.bundle.manifest.scenarioDescription}
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {fixtureId}
          </div>
        </div>
        <TimelineRowsStory rows={entry.rows} autoExpand />
      </div>
    </div>
  );
}

export const DevReplaysClaudeCodeCapMom0xkzo3atb06ph = createFixtureStory(
  "dev-replays/claude-code/cap_mom0xkzo_3atb06ph",
);
export const DevReplaysCodexCapMol1xza1Zclp97wz = createFixtureStory(
  "dev-replays/codex/cap_mol1xza1_zclp97wz",
);
export const ExcalidrawClaudeCodeCollabStartupExplanation = createFixtureStory(
  "excalidraw/claude-code/collab-startup-explanation",
);
export const ExcalidrawClaudeCodeEyedropperBrowserCompat = createFixtureStory(
  "excalidraw/claude-code/eyedropper-browser-compat",
);
export const ExcalidrawClaudeCodeEyedropperPreviewBugfix = createFixtureStory(
  "excalidraw/claude-code/eyedropper-preview-bugfix",
);
export const ExcalidrawClaudeCodeMagicframeFeature = createFixtureStory(
  "excalidraw/claude-code/magicframe-feature",
);
export const ExcalidrawClaudeCodeSearchBugfix = createFixtureStory(
  "excalidraw/claude-code/search-bugfix",
);
export const ExcalidrawClaudeCodeSearchFeature = createFixtureStory(
  "excalidraw/claude-code/search-feature",
);
export const ExcalidrawClaudeCodeTtdExplanation = createFixtureStory(
  "excalidraw/claude-code/ttd-explanation",
);
export const ExcalidrawCodexCollabStartupExplanation = createFixtureStory(
  "excalidraw/codex/collab-startup-explanation",
);
export const ExcalidrawCodexCommandOutputRecovery = createFixtureStory(
  "excalidraw/codex/command-output-recovery",
);
export const ExcalidrawCodexEyedropperPreviewBugfix = createFixtureStory(
  "excalidraw/codex/eyedropper-preview-bugfix",
);
export const ExcalidrawCodexMagicframeFeature = createFixtureStory(
  "excalidraw/codex/magicframe-feature",
);
export const ExcalidrawCodexSearchBugfix = createFixtureStory(
  "excalidraw/codex/search-bugfix",
);
export const ExcalidrawCodexSearchFeature = createFixtureStory(
  "excalidraw/codex/search-feature",
);
export const ExcalidrawCodexShareWebCompat = createFixtureStory(
  "excalidraw/codex/share-web-compat",
);
export const ExcalidrawCodexTtdExplanation = createFixtureStory(
  "excalidraw/codex/ttd-explanation",
);
export const ExcalidrawPiCollabStartupExplanation = createFixtureStory(
  "excalidraw/pi/collab-startup-explanation",
);
export const ExcalidrawPiCommandPaletteMap = createFixtureStory(
  "excalidraw/pi/command-palette-map",
);
export const ExcalidrawPiEyedropperPreviewBugfix = createFixtureStory(
  "excalidraw/pi/eyedropper-preview-bugfix",
);
export const ExcalidrawPiMagicframeFeature = createFixtureStory(
  "excalidraw/pi/magicframe-feature",
);
export const ExcalidrawPiSearchBugfix = createFixtureStory(
  "excalidraw/pi/search-bugfix",
);
export const ExcalidrawPiSearchFeature = createFixtureStory(
  "excalidraw/pi/search-feature",
);
export const ExcalidrawPiTtdExplanation = createFixtureStory(
  "excalidraw/pi/ttd-explanation",
);
