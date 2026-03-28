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

const INTENTIONAL_OPTIONAL_SERVER_FIELDS: Record<string, string> = {
  "apiErrorSchema.retryable": "Error payloads may omit retryability when the server has no retry guidance.",
  "createDraftRequestSchema.model": "Queued drafts may inherit the thread's default model.",
  "createDraftRequestSchema.reasoningLevel": "Queued drafts may inherit the thread's default reasoning level.",
  "createDraftRequestSchema.sandboxMode": "Queued drafts may inherit the thread's default sandbox mode.",
  "createDraftRequestSchema.serviceTier": "Queued drafts may inherit the thread's default service tier.",
  "createManagerThreadRequestSchema.title": "Manager creation may omit a custom title and use the server-generated default.",
  "createThreadRequestSchema.parentThreadId": "Root thread creation omits a parent thread id.",
  "createThreadRequestSchema.reasoningLevel": "Thread creation may omit reasoning level and use the server default.",
  "createThreadRequestSchema.sandboxMode": "Thread creation may omit sandbox mode and use the server default.",
  "createThreadRequestSchema.serviceTier": "Thread creation may omit service tier and use the server default.",
  "createThreadRequestSchema.title": "Thread creation may omit a custom title and use the generated title flow.",
  "environmentActionApiErrorSchema.details": "Some environment action failures do not have structured detail payloads.",
  "environmentActionApiErrorSchema.retryable": "Environment action errors may omit retryability when no retry hint exists.",
  "environmentStatusResponseSchema.workspace.baseRef": "Workspace status omits base ref when the workspace cannot resolve one.",
  "environmentStatusResponseSchema.workspace.currentBranch": "Workspace status omits current branch when the checkout is detached or unknown.",
  "environmentStatusResponseSchema.workspace.defaultBranch": "Workspace status omits default branch when the workspace cannot resolve one.",
  "environmentStatusResponseSchema.workspace.files": "Workspace status omits changed file details when the daemon does not return them.",
  "environmentStatusResponseSchema.workspace.mergeBaseBranch": "Workspace status omits merge-base branch when the workspace cannot resolve one.",
  "environmentStatusResponseSchema.workspace.mergeBaseBranches": "Workspace status omits merge-base branch choices when the workspace cannot list them.",
  "projectFilesQuerySchema.limit": "Project file search may omit limit to use the server-side default result count.",
  "projectFilesQuerySchema.query": "Project file search may omit a search string to list files without filtering.",
  "sendMessageRequestSchema.model": "Follow-up sends may inherit the thread's default model.",
  "sendMessageRequestSchema.reasoningLevel": "Follow-up sends may inherit the thread's default reasoning level.",
  "sendMessageRequestSchema.sandboxMode": "Follow-up sends may inherit the thread's default sandbox mode.",
  "sendMessageRequestSchema.serviceTier": "Follow-up sends may inherit the thread's default service tier.",
  "systemModelsQuerySchema.environmentId": "System model lookup may target a host indirectly through an environment id.",
  "systemModelsQuerySchema.hostId": "System model lookup may target a specific host directly.",
  "systemModelsQuerySchema.providerId": "System model lookup may omit provider id to list models for every provider on the chosen host.",
  "systemProvidersQuerySchema.environmentId": "System provider lookup may target a host indirectly through an environment id.",
  "systemProvidersQuerySchema.hostId": "System provider lookup may target a specific host directly.",
  "threadEventsQuerySchema.afterSeq": "Thread event listing may omit afterSeq to start from the beginning.",
  "threadEventsQuerySchema.limit": "Thread event listing may omit limit to use the server-side default page size.",
  "threadListQuerySchema.archived": "Thread listing may omit archived to include both archived and unarchived threads.",
  "threadListQuerySchema.parentThreadId": "Thread listing may omit parentThreadId when not filtering by parent.",
  "threadListQuerySchema.projectId": "Thread listing may omit projectId when not filtering by project.",
  "threadListQuerySchema.type": "Thread listing may omit type when not filtering by thread type.",
  "threadTimelineQuerySchema.includeManagerDebugView": "Timeline queries may omit manager debug view unless explicitly requested.",
  "threadTimelineQuerySchema.includeToolGroupMessages": "Timeline queries may omit grouped tool messages unless explicitly requested.",
  "threadTimelineQuerySchema.limit": "Timeline queries may omit limit to use the server-side default page size.",
  "threadTimelineResponseSchema.contextWindowUsage": "Timeline responses omit context window usage when the provider did not report it.",
  "threadWorkspaceFilesQuerySchema.limit": "Workspace file listing may omit limit to use the default result count.",
  "threadWorkspaceFilesQuerySchema.query": "Workspace file listing may omit a search string to list files without filtering.",
  "timelineToolDetailsQuerySchema.includeManagerDebugView": "Timeline tool detail queries may omit manager debug view unless explicitly requested.",
  "timelineToolDetailsRequestSchema.includeManagerDebugView": "Timeline tool detail requests may omit manager debug view unless explicitly requested.",
  "updateProjectRequestSchema.name": "Project PATCH requests omit name when leaving it unchanged.",
  "updateProjectSourceRequestSchema.path": "Project source PATCH requests omit path when leaving it unchanged.",
  "updateProjectSourceRequestSchema.repoUrl": "Project source PATCH requests omit repo URL when leaving it unchanged.",
  "updateThreadRequestSchema.mergeBaseBranch": "Thread PATCH requests omit mergeBaseBranch when leaving it unchanged or use null to clear it.",
  "updateThreadRequestSchema.parentThreadId": "Thread PATCH requests omit parentThreadId when leaving it unchanged or use null to clear it.",
  "updateThreadRequestSchema.title": "Thread PATCH requests omit title when leaving it unchanged or use null to clear it.",
  "uploadedPromptAttachmentSchema.mimeType": "Uploaded attachments may omit mime type when the client could not determine one.",
};

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

    expect(optionalFieldPaths).toEqual(
      Object.keys(INTENTIONAL_OPTIONAL_SERVER_FIELDS).sort(),
    );
    expect(
      Object.values(INTENTIONAL_OPTIONAL_SERVER_FIELDS).every(
        (reason) => reason.trim().length > 0,
      ),
    ).toBe(true);
  });
});
