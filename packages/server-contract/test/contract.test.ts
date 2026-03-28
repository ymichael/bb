import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contract from "../src/index.js";
import {
  PROJECT_CHANGE_KINDS,
  SYSTEM_CHANGE_KINDS,
  createDraftRequestSchema,
  createManagerThreadRequestSchema,
  createProjectSourceRequestSchema,
  createPublicApiClient,
  createThreadRequestSchema,
  environmentActionRequestSchema,
  sendMessageRequestSchema,
  timelineToolDetailsResponseSchema,
} from "../src/index.js";

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return unwrapSchema(schema._def.innerType);
  }
  if (schema instanceof z.ZodEffects) {
    return unwrapSchema(schema._def.schema);
  }
  return schema;
}

function collectOptionalFieldPaths(
  schemas: Record<string, z.ZodTypeAny>,
): string[] {
  const paths = new Set<string>();

  function walk(schema: z.ZodTypeAny, prefix: string): void {
    const unwrapped = unwrapSchema(schema);
    if (unwrapped instanceof z.ZodObject) {
      const shape = unwrapped._def.shape();
      for (const [key, value] of Object.entries(shape)) {
        const path = `${prefix}.${key}`;
        if (value instanceof z.ZodOptional) {
          paths.add(path);
        }
        walk(value, path);
      }
      return;
    }
    if (unwrapped instanceof z.ZodDiscriminatedUnion) {
      for (const option of unwrapped.options.values()) {
        walk(option, prefix);
      }
      return;
    }
    if (unwrapped instanceof z.ZodUnion) {
      for (const option of unwrapped._def.options) {
        walk(option, prefix);
      }
      return;
    }
    if (unwrapped instanceof z.ZodIntersection) {
      walk(unwrapped._def.left, prefix);
      walk(unwrapped._def.right, prefix);
    }
  }

  for (const [name, schema] of Object.entries(schemas)) {
    walk(schema, name);
  }

  return [...paths].sort();
}

describe("server-contract canonical schemas", () => {
  it("parses request contracts", () => {
    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        type: "standard",
        model: "gpt-5",
        input: [{ type: "text", text: "Ship it" }],
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).toMatchObject({
      projectId: "proj_123",
    });

    expect(
      sendMessageRequestSchema.parse({
        input: [{ type: "text", text: "Follow up" }],
        mode: "auto",
      }),
    ).toMatchObject({
      mode: "auto",
    });

    expect(
      environmentActionRequestSchema.parse({
        action: "commit",
        threadId: "thr_123",
        options: { message: "Checkpoint", autoArchiveOnSuccess: false },
      }),
    ).toMatchObject({
      action: "commit",
      threadId: "thr_123",
    });

    expect(
      createManagerThreadRequestSchema.parse({
        model: "claude-opus-4-6",
        providerId: "codex",
        reasoningLevel: "high",
        title: "Manager",
      }),
    ).toMatchObject({
      providerId: "codex",
    });

    expect(
      createProjectSourceRequestSchema.parse({
        hostId: "host_123",
        type: "local_path",
        path: "/tmp/project",
      }),
    ).toMatchObject({
      type: "local_path",
      path: "/tmp/project",
    });

    expect(
      createProjectSourceRequestSchema.parse({
        hostId: "host_123",
        type: "github_repo",
        repoUrl: "https://github.com/example/repo",
      }),
    ).toMatchObject({
      type: "github_repo",
      repoUrl: "https://github.com/example/repo",
    });

    expect(
      timelineToolDetailsResponseSchema.parse({ messages: [] }),
    ).toEqual({ messages: [] });

    expect(PROJECT_CHANGE_KINDS).toEqual([
      "sources-changed",
      "threads-changed",
    ]);
    expect(SYSTEM_CHANGE_KINDS).toEqual([
      "host-connected",
      "host-disconnected",
      "environment-created",
      "environment-deleted",
    ]);
  });

  it("keeps only intentional optional request fields", () => {
    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        type: "standard",
        model: "gpt-5",
        input: [{ type: "text", text: "Ship it" }],
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).toMatchObject({
      environment: {
        type: "host",
      },
    });

    expect(
      sendMessageRequestSchema.parse({
        input: [{ type: "text", text: "Use the thread defaults" }],
        mode: "auto",
      }),
    ).toMatchObject({
      mode: "auto",
    });

    expect(
      createDraftRequestSchema.parse({
        input: [{ type: "text", text: "Queue this with inherited defaults" }],
      }),
    ).toMatchObject({
      input: [{ type: "text", text: "Queue this with inherited defaults" }],
    });

    expect(() =>
      createManagerThreadRequestSchema.parse({
        providerId: "claude-code",
        reasoningLevel: "high",
        title: "Missing model",
      }),
    ).toThrow();
  });
});

describe("server-contract clients", () => {
  it("builds canonical public routes", () => {
    const publicClient = createPublicApiClient("http://localhost:3334");

    expect(
      publicClient.threads[":id"].send.$url({ param: { id: "thr_123" } })
        .pathname,
    ).toBe("/api/v1/threads/thr_123/send");
    expect(
      publicClient.projects[":id"].managers.$url({
        param: { id: "proj_123" },
      }).pathname,
    ).toBe("/api/v1/projects/proj_123/managers");
    expect(
      publicClient.threads[":id"].timeline["tool-details"].$url({
        param: { id: "thr_123" },
        query: {
          turnId: "turn_1",
          sourceSeqStart: "1",
          sourceSeqEnd: "2",
        },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/timeline/tool-details");
  });

  it("keeps route inputs in shared named types instead of inline objects", () => {
    const contractPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/public-api.ts",
    );
    const contractSource = readFileSync(contractPath, "utf8");

    expect(contractSource).not.toMatch(/json:\s*\{/);
    expect(contractSource).not.toMatch(/query:\s*\{/);
    expect(contractSource).not.toMatch(/form:\s*Record</);
  });

  it("keeps contract optional fields on an explicit allowlist", () => {
    const optionalFieldPaths = collectOptionalFieldPaths({
      apiErrorSchema: contract.apiErrorSchema,
      commitActionResponseSchema: contract.commitActionResponseSchema,
      commitOptionsSchema: contract.commitOptionsSchema,
      createDraftRequestSchema: contract.createDraftRequestSchema,
      createManagerThreadRequestSchema: contract.createManagerThreadRequestSchema,
      createThreadRequestSchema: contract.createThreadRequestSchema,
      environmentActionApiErrorSchema: contract.environmentActionApiErrorSchema,
      environmentStatusResponseSchema: contract.environmentStatusResponseSchema,
      projectFilesQuerySchema: contract.projectFilesQuerySchema,
      sendDraftResponseSchema: contract.sendDraftResponseSchema,
      sendMessageRequestSchema: contract.sendMessageRequestSchema,
      squashMergeActionResponseSchema: contract.squashMergeActionResponseSchema,
      systemModelsQuerySchema: contract.systemModelsQuerySchema,
      systemProvidersQuerySchema: contract.systemProvidersQuerySchema,
      threadEventsQuerySchema: contract.threadEventsQuerySchema,
      threadListQuerySchema: contract.threadListQuerySchema,
      threadTimelineQuerySchema: contract.threadTimelineQuerySchema,
      threadTimelineResponseSchema: contract.threadTimelineResponseSchema,
      threadWorkspaceFilesQuerySchema: contract.threadWorkspaceFilesQuerySchema,
      timelineToolDetailsQuerySchema: contract.timelineToolDetailsQuerySchema,
      timelineToolDetailsRequestSchema: contract.timelineToolDetailsRequestSchema,
      updateProjectRequestSchema: contract.updateProjectRequestSchema,
      updateProjectSourceRequestSchema: contract.updateProjectSourceRequestSchema,
      updateThreadRequestSchema: contract.updateThreadRequestSchema,
      uploadedPromptAttachmentSchema: contract.uploadedPromptAttachmentSchema,
    });

    expect(optionalFieldPaths).toEqual([
      "apiErrorSchema.retryable",
      "commitOptionsSchema.message",
      "createDraftRequestSchema.model",
      "createDraftRequestSchema.reasoningLevel",
      "createDraftRequestSchema.sandboxMode",
      "createDraftRequestSchema.serviceTier",
      "createManagerThreadRequestSchema.title",
      "createThreadRequestSchema.parentThreadId",
      "createThreadRequestSchema.reasoningLevel",
      "createThreadRequestSchema.sandboxMode",
      "createThreadRequestSchema.serviceTier",
      "createThreadRequestSchema.title",
      "environmentActionApiErrorSchema.details",
      "environmentActionApiErrorSchema.retryable",
      "environmentStatusResponseSchema.workspace.baseRef",
      "environmentStatusResponseSchema.workspace.currentBranch",
      "environmentStatusResponseSchema.workspace.defaultBranch",
      "environmentStatusResponseSchema.workspace.files",
      "environmentStatusResponseSchema.workspace.mergeBaseBranch",
      "environmentStatusResponseSchema.workspace.mergeBaseBranches",
      "projectFilesQuerySchema.limit",
      "projectFilesQuerySchema.query",
      "sendMessageRequestSchema.model",
      "sendMessageRequestSchema.reasoningLevel",
      "sendMessageRequestSchema.sandboxMode",
      "sendMessageRequestSchema.serviceTier",
      "systemModelsQuerySchema.environmentId",
      "systemModelsQuerySchema.hostId",
      "systemModelsQuerySchema.providerId",
      "systemProvidersQuerySchema.environmentId",
      "systemProvidersQuerySchema.hostId",
      "threadEventsQuerySchema.afterSeq",
      "threadEventsQuerySchema.limit",
      "threadListQuerySchema.archived",
      "threadListQuerySchema.parentThreadId",
      "threadListQuerySchema.projectId",
      "threadListQuerySchema.type",
      "threadTimelineQuerySchema.includeManagerDebugView",
      "threadTimelineQuerySchema.includeToolGroupMessages",
      "threadTimelineQuerySchema.limit",
      "threadTimelineResponseSchema.contextWindowUsage",
      "threadWorkspaceFilesQuerySchema.limit",
      "threadWorkspaceFilesQuerySchema.query",
      "timelineToolDetailsQuerySchema.includeManagerDebugView",
      "timelineToolDetailsRequestSchema.includeManagerDebugView",
      "updateProjectRequestSchema.name",
      "updateProjectSourceRequestSchema.path",
      "updateProjectSourceRequestSchema.repoUrl",
      "updateThreadRequestSchema.mergeBaseBranch",
      "updateThreadRequestSchema.parentThreadId",
      "updateThreadRequestSchema.title",
      "uploadedPromptAttachmentSchema.mimeType",
    ]);
  });
});
