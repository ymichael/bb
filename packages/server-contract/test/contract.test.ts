import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
        threadId: "thr_123",
        options: { message: "Checkpoint" },
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
    const contractDir = path.dirname(fileURLToPath(import.meta.url));
    const files = [
      "../src/api-types.ts",
      "../src/errors.ts",
    ];

    const optionalLines = files.flatMap((relativePath) => {
      const absolutePath = path.resolve(contractDir, relativePath);
      return readFileSync(absolutePath, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes(".optional()"));
    });

    expect(optionalLines).toEqual([
      "type: threadTypeSchema.optional(),",
      "title: z.string().min(1).optional(),",
      "serviceTier: serviceTierSchema.optional(),",
      "reasoningLevel: reasoningLevelSchema.optional(),",
      "sandboxMode: sandboxModeSchema.optional(),",
      "parentThreadId: z.string().min(1).optional(),",
      "model: z.string().optional(),",
      "serviceTier: serviceTierSchema.optional(),",
      "reasoningLevel: reasoningLevelSchema.optional(),",
      "sandboxMode: sandboxModeSchema.optional(),",
      "model: z.string().optional(),",
      "serviceTier: serviceTierSchema.optional(),",
      "reasoningLevel: reasoningLevelSchema.optional(),",
      "sandboxMode: sandboxModeSchema.optional(),",
      "title: z.string().min(1).nullable().optional(),",
      "mergeBaseBranch: z.string().min(1).nullable().optional(),",
      "parentThreadId: z.string().min(1).nullable().optional(),",
      "title: z.string().min(1).optional(),",
      "query: z.string().min(1).optional(),",
      "limit: z.string().regex(/^\\d+$/).optional(),",
      "projectId: z.string().min(1).optional(),",
      "type: threadTypeSchema.optional(),",
      "parentThreadId: z.string().min(1).optional(),",
      "archived: z.enum([\"true\", \"false\"]).optional(),",
      "limit: z.string().regex(/^\\d+$/).optional(),",
      "includeManagerDebugView: z.enum([\"true\", \"false\"]).optional(),",
      "includeToolGroupMessages: z.enum([\"true\", \"false\"]).optional(),",
      "includeManagerDebugView: z.enum([\"true\", \"false\"]).optional(),",
      "afterSeq: z.string().regex(/^\\d+$/).optional(),",
      "limit: z.string().regex(/^\\d+$/).optional(),",
      "query: z.string().min(1).optional(),",
      "limit: z.string().regex(/^\\d+$/).optional(),",
      "providerId: z.string().min(1).optional(),",
      "hostId: z.string().min(1).optional(),",
      "environmentId: z.string().min(1).optional(),",
      "hostId: z.string().min(1).optional(),",
      "environmentId: z.string().min(1).optional(),",
      "name: z.string().min(1).optional(),",
      "path: z.string().min(1).optional(),",
      "repoUrl: z.string().url().optional(),",
      "message: z.string().min(1).optional(),",
      "autoArchiveOnSuccess: z.boolean().optional(),",
      "mergeBaseBranch: z.string().min(1).optional(),",
      "autoArchiveOnSuccess: z.boolean().optional(),",
      "options: commitOptionsSchema.optional(),",
      "options: squashMergeOptionsSchema.optional(),",
      "commitSha: z.string().optional(),",
      "commitSubject: z.string().optional(),",
      "commitSha: z.string().optional(),",
      "commitSubject: z.string().optional(),",
      "details: environmentActionFailureDetailsSchema.optional(),",
      "includeManagerDebugView: z.boolean().optional(),",
      "contextWindowUsage: threadContextWindowUsageSchema.nullable().optional(),",
      "mimeType: z.string().optional(),",
      "retryable: z.boolean().optional(),",
    ]);
  });
});
