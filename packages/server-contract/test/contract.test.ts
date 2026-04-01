import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectOptionalFieldPaths } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
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
  updateEnvironmentRequestSchema,
} from "../src/index.js";

const INTENTIONAL_OPTIONAL_SERVER_FIELDS: Record<string, string> = {
  "apiErrorSchema.retryable": "Error payloads may omit retryability when the server has no retry guidance.",
  "createDraftRequestSchema.model": "Queued drafts may inherit the thread's default model.",
  "createDraftRequestSchema.reasoningLevel": "Queued drafts may inherit the thread's default reasoning level.",
  "createDraftRequestSchema.sandboxMode": "Queued drafts may inherit the thread's default sandbox mode.",
  "createDraftRequestSchema.serviceTier": "Queued drafts may inherit the thread's default service tier.",
  "createManagerThreadRequestSchema.name": "Manager creation may omit a custom name and use the server-generated default.",
  "createManagerThreadRequestSchema.reasoningLevel": "Manager creation may omit reasoning level and use the server default.",
  "createThreadRequestSchema.parentThreadId": "Root thread creation omits a parent thread id.",
  "createThreadRequestSchema.reasoningLevel": "Thread creation may omit reasoning level and use the server default.",
  "createThreadRequestSchema.sandboxMode": "Thread creation may omit sandbox mode and use the server default.",
  "createThreadRequestSchema.serviceTier": "Thread creation may omit service tier and use the server default.",
  "createThreadRequestSchema.title": "Thread creation may omit a custom title and use the generated title flow.",
  "environmentActionApiErrorSchema.details": "Some environment action failures do not have structured detail payloads.",
  "environmentActionApiErrorSchema.retryable": "Environment action errors may omit retryability when no retry hint exists.",
  "threadStorageFilesQuerySchema.limit": "Thread storage file listing may omit limit to use the default result count.",
  "threadStorageFilesQuerySchema.query": "Thread storage file listing may omit a search string to list files without filtering.",
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
  "threadListQuerySchema.type": "Thread listing may omit type when not filtering by thread type.",
  "threadTimelineQuerySchema.includeManagerDebugView": "Timeline queries may omit manager debug view unless explicitly requested.",
  "threadTimelineQuerySchema.includeToolGroupMessages": "Timeline queries may omit grouped tool messages unless explicitly requested.",
  "threadTimelineResponseSchema.contextWindowUsage": "Timeline responses omit context window usage when the provider did not report it.",
  "timelineToolDetailsQuerySchema.includeManagerDebugView": "Timeline tool detail queries may omit manager debug view unless explicitly requested.",
  "timelineToolDetailsRequestSchema.includeManagerDebugView": "Timeline tool detail requests may omit manager debug view unless explicitly requested.",
  "updateProjectRequestSchema.name": "Project PATCH requests omit name when leaving it unchanged.",
  "updateProjectSourceRequestSchema.isDefault": "Project source PATCH requests omit isDefault when not changing the default source.",
  "updateProjectSourceRequestSchema.path": "Project source PATCH requests omit path when leaving it unchanged.",
  "updateProjectSourceRequestSchema.repoUrl": "Project source PATCH requests omit repo URL when leaving it unchanged.",
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
      }),
    ).toMatchObject({
      action: "commit",
    });

    expect(() =>
      environmentActionRequestSchema.parse({
        action: "commit",
        threadId: "thr_123",
      }),
    ).toThrow();

    expect(
      updateEnvironmentRequestSchema.parse({
        mergeBaseBranch: null,
      }),
    ).toEqual({
      mergeBaseBranch: null,
    });

    expect(
      createManagerThreadRequestSchema.parse({
        model: "claude-opus-4-6",
        providerId: "codex",
        reasoningLevel: "high",
        name: "Manager",
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
        type: "github_repo",
        repoUrl: "https://github.com/example/repo",
      }),
    ).toMatchObject({
      type: "github_repo",
      repoUrl: "https://github.com/example/repo",
    });

    expect(() =>
      createProjectSourceRequestSchema.parse({
        hostId: "host_123",
        type: "github_repo",
        repoUrl: "https://github.com/example/repo",
      }),
    ).toThrow();

    expect(
      timelineToolDetailsResponseSchema.parse({ messages: [] }),
    ).toEqual({ messages: [] });

    expect(PROJECT_CHANGE_KINDS).toEqual([
      "project-created",
      "project-updated",
      "project-deleted",
      "project-sources-changed",
      "threads-changed",
    ]);
    expect(SYSTEM_CHANGE_KINDS).toEqual([]);
  });

  it("keeps only intentional optional request fields", () => {
    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
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
        name: "Missing model",
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
      publicClient.threads[":id"].drafts.$url({ param: { id: "thr_123" } })
        .pathname,
    ).toBe("/api/v1/threads/thr_123/drafts");
    expect(
      publicClient.projects[":id"].managers.$url({
        param: { id: "proj_123" },
      }).pathname,
    ).toBe("/api/v1/projects/proj_123/managers");
    expect(
      publicClient.threads[":id"].timeline["tool-details"].$url({
        param: { id: "thr_123" },
        query: {
          sourceSeqStart: "1",
          sourceSeqEnd: "2",
        },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/timeline/tool-details");
    expect(
      publicClient.threads[":id"]["thread-storage"].files.$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/thread-storage/files");
    expect(
      publicClient.threads[":id"]["thread-storage"].content.$url({
        param: { id: "thr_123" },
        query: { path: "notes/plan.md" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/thread-storage/content");
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
      createDraftRequestSchema: contract.createDraftRequestSchema,
      createManagerThreadRequestSchema: contract.createManagerThreadRequestSchema,
      createThreadRequestSchema: contract.createThreadRequestSchema,
      environmentActionApiErrorSchema: contract.environmentActionApiErrorSchema,
      environmentStatusResponseSchema: contract.environmentStatusResponseSchema,
      threadStorageFilesQuerySchema: contract.threadStorageFilesQuerySchema,
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
