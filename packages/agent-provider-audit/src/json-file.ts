import { readFileSync } from "node:fs";
import { turnRequestTargetSchema } from "@bb/domain";
import type { TurnRequestTarget } from "@bb/domain";
import { z } from "zod";
import type { ProviderAuditClientRequest } from "./types.js";

const JSON_RPC_VERSION = "2.0" as const;

const providerAuditJsonRpcParamsSchema = z.record(z.string(), z.unknown());

const providerAuditJsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  method: z.string(),
  params: providerAuditJsonRpcParamsSchema.optional(),
}).passthrough();

const providerAuditBridgeEnvelopeSchema = z.object({
  method: z.string(),
  params: providerAuditJsonRpcParamsSchema.optional(),
}).passthrough();

export const providerAuditRawEventSchema = z.union([
  providerAuditJsonRpcEnvelopeSchema,
  providerAuditBridgeEnvelopeSchema.transform((value) => ({
    jsonrpc: JSON_RPC_VERSION,
    method: value.method,
    ...(value.params ? { params: value.params } : {}),
  })),
]);

const providerAuditGitSnapshotSchema = z.object({
  headSha: z.string().nullable(),
  isClean: z.boolean(),
  statusLines: z.array(z.string()),
});

export const providerAuditManifestSchema = z.object({
  providerId: z.string(),
  scenarioId: z.string(),
  scenarioDescription: z.string(),
  model: z.string().nullable(),
  source: z.literal("live-capture"),
  capturedAt: z.number(),
  completedAt: z.number(),
  gitSha: z.string().nullable(),
  workspacePath: z.string(),
  runtimeWorkspacePath: z.string(),
  envWorkspacePath: z.string(),
  outputDir: z.string(),
  threadId: z.string(),
  projectId: z.string(),
  turns: z.array(z.string()),
  gitResetRef: z.string().nullable(),
  runtimeWorkspaceGitStart: providerAuditGitSnapshotSchema.nullable(),
  runtimeWorkspaceGitEnd: providerAuditGitSnapshotSchema.nullable(),
});

const CLIENT_TURN_REQUESTED_TYPE = "client/turn/requested";
const THREAD_START_TARGET = { kind: "thread-start" } satisfies TurnRequestTarget;
const NEW_TURN_TARGET = { kind: "new-turn" } satisfies TurnRequestTarget;

const providerAuditClientRequestFileSchema = z.object({
  id: z.string(),
  turnIndex: z.number(),
  type: z.enum(["client/thread/start", "client/turn/requested"]),
  target: turnRequestTargetSchema.optional(),
  requestMethod: z.enum(["thread/start", "turn/start"]),
  text: z.string(),
  createdAt: z.number(),
});
type ProviderAuditClientRequestFile = z.infer<
  typeof providerAuditClientRequestFileSchema
>;

function normalizeProviderAuditClientRequest(
  request: ProviderAuditClientRequestFile,
): ProviderAuditClientRequest {
  return {
    ...request,
    type: CLIENT_TURN_REQUESTED_TYPE,
    target:
      request.target ??
      (request.type === "client/thread/start"
        ? THREAD_START_TARGET
        : NEW_TURN_TARGET),
  };
}

export const providerAuditClientRequestSchema =
  providerAuditClientRequestFileSchema.transform(
    normalizeProviderAuditClientRequest,
  );

export const providerAuditRawProviderEventCaptureEntrySchema = z.object({
  kind: z.literal("raw-provider-event"),
  captureId: z.string(),
  capturedAt: z.number(),
  providerId: z.string(),
  rawLine: z.string(),
  rawEvent: providerAuditRawEventSchema,
  sourceThreadId: z.string().optional(),
});

interface ReadJsonFileArgs<TSchema extends z.ZodTypeAny> {
  filePath: string;
  schema: TSchema;
}

export function readJsonFile<TSchema extends z.ZodTypeAny>(
  args: ReadJsonFileArgs<TSchema>,
): z.infer<TSchema> {
  const parsedJson = JSON.parse(readFileSync(args.filePath, "utf8"));
  return args.schema.parse(parsedJson);
}
