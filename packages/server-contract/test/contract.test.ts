import { collectOptionalFieldPaths } from "@bb/test-helpers";
import { describe, expect, it } from "vitest";
import publicApiSource from "../src/public-api.ts?raw";
import * as contract from "../src/index.js";
import {
  PROJECT_CHANGE_KINDS,
  SYSTEM_CHANGE_KINDS,
  automationSchema,
  createAutomationRequestSchema,
  createHostJoinRequestSchema,
  createHostJoinResponseSchema,
  createLocalPersistentHostJoinRequest,
  createPersistentHostJoinRequest,
  createDraftRequestSchema,
  createManagerThreadRequestSchema,
  createProjectSourceRequestSchema,
  createPublicApiClient,
  createThreadRequestSchema,
  environmentActionRequestSchema,
  baseBranchSpecSchema,
  gitBranchNameSchema,
  resolvePendingInteractionRequestSchema,
  sendDraftRequestSchema,
  sendMessageRequestSchema,
  threadListResponseSchema,
  threadPendingInteractionsResponseSchema,
  timelineTurnSummaryDetailsResponseSchema,
  updateEnvironmentRequestSchema,
  updateAutomationRequestSchema,
  unmanagedBranchSpecSchema,
} from "../src/index.js";

const INTENTIONAL_OPTIONAL_SERVER_FIELDS: Record<string, string> = {
  "apiErrorSchema.retryable":
    "Error payloads may omit retryability when the server has no retry guidance.",
  "createAutomationRequestSchema.action.threadRequest.environment.workspace.branch":
    "Unmanaged workspaces may omit branch when the daemon should not check out before starting the thread.",
  "createAutomationRequestSchema.action.threadRequest.parentThreadId":
    "Automation creation may omit parentThreadId when the scheduled thread stays a root thread.",
  "createAutomationRequestSchema.action.threadRequest.permissionMode":
    "Automation creation may omit permissionMode and inherit the scheduled thread default.",
  "createAutomationRequestSchema.action.threadRequest.reasoningLevel":
    "Automation creation may omit reasoningLevel and inherit the scheduled thread default.",
  "createAutomationRequestSchema.action.threadRequest.serviceTier":
    "Automation creation may omit serviceTier and inherit the scheduled thread default.",
  "createAutomationRequestSchema.action.threadRequest.title":
    "Automation creation may omit title and use the generated thread title flow.",
  "createAutomationRequestSchema.autoArchive":
    "Automation creation may omit autoArchive and use the server default.",
  "createAutomationRequestSchema.enabled":
    "Automation creation may omit enabled and use the server default.",
  "createHostJoinRequestSchema.hostId":
    "Host join initiation may omit hostId when the server should generate a new persistent host id.",
  "createHostJoinRequestSchema.hostType":
    "Host join initiation may omit hostType and let the server choose the default persistent host policy.",
  "createDraftRequestSchema.model":
    "Queued drafts may inherit the thread's default model.",
  "createDraftRequestSchema.reasoningLevel":
    "Queued drafts may inherit the thread's default reasoning level.",
  "createDraftRequestSchema.permissionMode":
    "Queued drafts may inherit the thread's default permission mode.",
  "createDraftRequestSchema.serviceTier":
    "Queued drafts may inherit the thread's default service tier.",
  "updateAutomationRequestSchema.action":
    "Automation PATCH requests omit action when leaving it unchanged.",
  "updateAutomationRequestSchema.action.threadRequest.environment.workspace.branch":
    "Unmanaged workspaces may omit branch when the daemon should not check out before starting the thread.",
  "updateAutomationRequestSchema.action.threadRequest.parentThreadId":
    "Automation action updates may omit parentThreadId when the scheduled thread stays a root thread.",
  "updateAutomationRequestSchema.action.threadRequest.permissionMode":
    "Automation action updates may omit permissionMode and inherit the scheduled thread default.",
  "updateAutomationRequestSchema.action.threadRequest.reasoningLevel":
    "Automation action updates may omit reasoningLevel and inherit the scheduled thread default.",
  "updateAutomationRequestSchema.action.threadRequest.serviceTier":
    "Automation action updates may omit serviceTier and inherit the scheduled thread default.",
  "updateAutomationRequestSchema.action.threadRequest.title":
    "Automation action updates may omit title and use the generated thread title flow.",
  "updateAutomationRequestSchema.autoArchive":
    "Automation PATCH requests omit autoArchive when leaving it unchanged.",
  "updateAutomationRequestSchema.name":
    "Automation PATCH requests omit name when leaving it unchanged.",
  "updateAutomationRequestSchema.trigger":
    "Automation PATCH requests omit trigger when leaving it unchanged.",
  "createManagerThreadRequestSchema.model":
    "Manager creation may omit model and inherit remembered manager defaults for the resolved provider or the server manager default.",
  "createManagerThreadRequestSchema.name":
    "Manager creation may omit a custom name and use the server-generated default.",
  "createManagerThreadRequestSchema.providerId":
    "Manager creation may omit providerId and use remembered manager defaults or the server manager default.",
  "createManagerThreadRequestSchema.permissionMode":
    "Manager creation may omit permission mode and use the server default.",
  "createManagerThreadRequestSchema.reasoningLevel":
    "Manager creation may omit reasoning level and use the server default.",
  "createManagerThreadRequestSchema.serviceTier":
    "Manager creation may omit service tier and use the server default.",
  "createThreadRequestSchema.environment.workspace.branch":
    "Unmanaged workspaces may omit branch when the daemon should not check out before starting the thread.",
  "createThreadRequestSchema.model":
    "Thread creation may omit model and inherit the project/provider default.",
  "createThreadRequestSchema.parentThreadId":
    "Root thread creation omits a parent thread id.",
  "createThreadRequestSchema.providerId":
    "Thread creation may omit providerId and use the project's remembered provider choice.",
  "createThreadRequestSchema.permissionMode":
    "Thread creation may omit permission mode and use the server default.",
  "createThreadRequestSchema.reasoningLevel":
    "Thread creation may omit reasoning level and use the server default.",
  "createThreadRequestSchema.serviceTier":
    "Thread creation may omit service tier and use the server default.",
  "createThreadRequestSchema.title":
    "Thread creation may omit a custom title and use the generated title flow.",
  "environmentActionApiErrorSchema.details":
    "Some environment action failures do not have structured detail payloads.",
  "environmentActionApiErrorSchema.retryable":
    "Environment action errors may omit retryability when no retry hint exists.",
  "threadStorageFilesQuerySchema.limit":
    "Thread storage file listing may omit limit to use the default result count.",
  "threadStorageFilesQuerySchema.query":
    "Thread storage file listing may omit a search string to list files without filtering.",
  "projectFilesQuerySchema.limit":
    "Project file search may omit limit to use the server-side default result count.",
  "projectFilesQuerySchema.query":
    "Project file search may omit a search string to list files without filtering.",
  "sendMessageRequestSchema.model":
    "Follow-up sends may inherit the thread's default model.",
  "sendMessageRequestSchema.permissionMode":
    "Follow-up sends may inherit the thread's current permission mode.",
  "sendMessageRequestSchema.reasoningLevel":
    "Follow-up sends may inherit the thread's default reasoning level.",
  "sendMessageRequestSchema.senderThreadId":
    "Immediate agent-to-agent CLI sends include the current thread; user-originated sends and queued drafts omit live sender context.",
  "sendMessageRequestSchema.serviceTier":
    "Follow-up sends may inherit the thread's default service tier.",
  "systemExecutionOptionsQuerySchema.environmentId":
    "System execution option lookup may target a host indirectly through an environment id.",
  "systemExecutionOptionsQuerySchema.hostId":
    "System execution option lookup may target a specific host directly.",
  "systemExecutionOptionsQuerySchema.providerId":
    "System execution option lookup may omit provider id to use the chosen host's default provider.",
  "systemProvidersQuerySchema.environmentId":
    "System provider lookup may target a host indirectly through an environment id.",
  "systemProvidersQuerySchema.hostId":
    "System provider lookup may target a specific host directly.",
  "threadEventsQuerySchema.afterSeq":
    "Thread event listing may omit afterSeq to start from the beginning.",
  "threadEventsQuerySchema.limit":
    "Thread event listing may omit limit to use the server-side default page size.",
  "threadListQuerySchema.archived":
    "Thread listing may omit archived to include both archived and unarchived threads.",
  "threadListQuerySchema.limit":
    "Thread listing may omit limit to return all matching threads without pagination.",
  "threadListQuerySchema.managed":
    "Thread listing may omit managed to include both managed and unmanaged threads.",
  "threadListQuerySchema.offset":
    "Thread listing may omit offset to start from the first row.",
  "threadListQuerySchema.parentThreadId":
    "Thread listing may omit parentThreadId when not filtering by parent.",
  "threadListQuerySchema.type":
    "Thread listing may omit type when not filtering by thread type.",
  "threadTimelineQuerySchema.managerTimelineView":
    "Timeline queries may omit managerTimelineView unless explicitly requesting the standard manager timeline.",
  "threadTimelineQuerySchema.includeNestedRows":
    "Timeline queries may omit nested rows unless explicitly requested.",
  "threadTimelineQuerySchema.segmentLimit":
    "Timeline queries may omit segmentLimit to use the server-side default page size.",
  "threadTimelineQuerySchema.beforeAnchorSeq":
    "Timeline queries omit beforeAnchorSeq when requesting the latest page.",
  "threadTimelineQuerySchema.beforeAnchorId":
    "Timeline queries omit beforeAnchorId when requesting the latest page.",
  "threadTimelineQuerySchema.summaryOnly":
    "Timeline queries may omit summaryOnly; CLI sets it to skip row generation, web client always wants rows.",
  "threadTimelineResponseSchema.contextWindowUsage":
    "Timeline responses omit context window usage when the provider did not report it.",
  "timelineTurnSummaryDetailsQuerySchema.managerTimelineView":
    "Turn summary detail queries may omit managerTimelineView unless explicitly requesting the standard manager timeline.",
  "timelineTurnSummaryDetailsRequestSchema.managerTimelineView":
    "Turn summary detail requests may omit managerTimelineView unless explicitly requesting the standard manager timeline.",
  "updateProjectRequestSchema.name":
    "Project PATCH requests omit name when leaving it unchanged.",
  "updateProjectSourceRequestSchema.isDefault":
    "Project source PATCH requests omit isDefault when not changing the default source.",
  "updateProjectSourceRequestSchema.path":
    "Project source PATCH requests omit path when leaving it unchanged.",
  "updateProjectSourceRequestSchema.repoUrl":
    "Project source PATCH requests omit repo URL when leaving it unchanged.",
  "updateThreadRequestSchema.parentThreadId":
    "Thread PATCH requests omit parentThreadId when leaving it unchanged or use null to clear it.",
  "updateThreadRequestSchema.title":
    "Thread PATCH requests omit title when leaving it unchanged or use null to clear it.",
  "uploadedPromptAttachmentSchema.mimeType":
    "Uploaded attachments may omit mime type when the client could not determine one.",
};

describe("git branch name contract", () => {
  it("accepts valid branch names", () => {
    const validNames = [
      "main",
      "release/1.2",
      "feature.foo",
      "user_name",
      "bb/thread-123",
    ];

    for (const name of validNames) {
      expect(gitBranchNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("rejects names git may parse ambiguously or refuses as refs", () => {
    const invalidNames = [
      "",
      "   ",
      "-release",
      "/release",
      ".release",
      "bar/.hidden",
      "bad\nbranch",
      "bad\u007fbranch",
      "bad branch",
      "bad\tbranch",
      "bad..branch",
      "bad@{branch",
      "bad\\branch",
      "bad:branch",
      "bad~branch",
      "bad^branch",
      "bad?branch",
      "bad*branch",
      "bad[branch",
      "bad/",
      "bad.lock",
      "bad.lock/branch",
      "bad//branch",
      "bad.",
      "@",
      "HEAD",
      "FETCH_HEAD",
    ];

    for (const name of invalidNames) {
      expect(gitBranchNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("uses the shared validator for managed and unmanaged branch specs", () => {
    expect(
      baseBranchSpecSchema.safeParse({
        kind: "named",
        name: "release/1.2",
      }).success,
    ).toBe(true);
    expect(
      baseBranchSpecSchema.safeParse({ kind: "named", name: "-release" })
        .success,
    ).toBe(false);
    expect(
      unmanagedBranchSpecSchema.safeParse({
        kind: "existing",
        name: "release/1.2",
      }).success,
    ).toBe(true);
    expect(
      unmanagedBranchSpecSchema.safeParse({
        kind: "existing",
        name: "release 1.2",
      }).success,
    ).toBe(false);
  });
});

describe("server-contract canonical schemas", () => {
  it("parses request contracts", () => {
    expect(
      createAutomationRequestSchema.parse({
        name: "Daily summary",
        trigger: {
          cron: "0 8 * * 1-5",
          timezone: "America/Los_Angeles",
          triggerType: "schedule",
        },
        action: {
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Summarize yesterday's work" }],
            environment: {
              type: "host",
              hostId: "host_abc",
              workspace: {
                type: "managed-clone",
                baseBranch: { kind: "default" },
              },
            },
          },
        },
      }),
    ).toMatchObject({
      name: "Daily summary",
    });

    expect(
      automationSchema.parse({
        id: "auto_123",
        projectId: "proj_123",
        name: "Daily summary",
        enabled: true,
        trigger: {
          cron: "0 8 * * 1-5",
          timezone: "America/Los_Angeles",
          triggerType: "schedule",
        },
        action: {
          actionType: "scheduled-thread",
          threadRequest: {
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Summarize yesterday's work" }],
            environment: {
              type: "host",
              hostId: "host_abc",
              workspace: {
                type: "managed-clone",
                baseBranch: { kind: "default" },
              },
            },
          },
        },
        autoArchive: false,
        nextRunAt: 123,
        lastRunAt: null,
        runCount: 0,
        isValid: true,
        validationIssues: [],
        createdAt: 1,
        updatedAt: 2,
      }),
    ).toMatchObject({
      id: "auto_123",
      projectId: "proj_123",
    });

    expect(
      createHostJoinRequestSchema.parse({
        hostType: "persistent",
      }),
    ).toMatchObject({
      hostType: "persistent",
    });

    expect(createHostJoinRequestSchema.parse({})).toEqual({});

    expect(
      createHostJoinRequestSchema.parse({
        hostId: "host_local",
        hostType: "persistent",
        joinMode: "local",
      }),
    ).toMatchObject({
      hostId: "host_local",
      hostType: "persistent",
      joinMode: "local",
    });

    expect(() =>
      createHostJoinRequestSchema.parse({
        joinMode: "local",
      }),
    ).toThrow();

    expect(
      createPersistentHostJoinRequest({ hostId: "host_persistent" }),
    ).toEqual({
      hostId: "host_persistent",
      hostType: "persistent",
    });
    expect(createPersistentHostJoinRequest({ hostId: null })).toEqual({
      hostType: "persistent",
    });
    expect(
      createLocalPersistentHostJoinRequest({ hostId: "host_local" }),
    ).toEqual({
      hostId: "host_local",
      hostType: "persistent",
      joinMode: "local",
    });
    expect(createLocalPersistentHostJoinRequest({ hostId: null })).toEqual({
      hostType: "persistent",
      joinMode: "local",
    });

    expect(
      createHostJoinRequestSchema.parse({
        hostType: "ephemeral",
        provider: "e2b",
        externalId: "sandbox_123",
      }),
    ).toMatchObject({
      hostType: "ephemeral",
      provider: "e2b",
      externalId: "sandbox_123",
    });

    expect(() =>
      createHostJoinRequestSchema.parse({
        hostType: "ephemeral",
        externalId: "sandbox_missing_provider",
      }),
    ).toThrow(/provider/u);

    expect(
      createHostJoinResponseSchema.parse({
        expiresAt: 123456789,
        hostId: "host_123",
        joinCode: "bbde_example",
        joinCommand:
          "BB_SERVER_URL=http://localhost:3334 pnpm start:host-daemon",
      }),
    ).toMatchObject({
      hostId: "host_123",
    });

    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        origin: "app",
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
      updateAutomationRequestSchema.parse({
        enabled: true,
      }),
    ).toEqual({
      enabled: true,
    });

    expect(
      updateAutomationRequestSchema.parse({
        autoArchive: true,
      }),
    ).toEqual({
      autoArchive: true,
    });

    expect(() =>
      updateAutomationRequestSchema.parse({
        autoArchive: true,
        enabled: true,
      }),
    ).toThrow();

    expect(
      sendMessageRequestSchema.parse({
        input: [{ type: "text", text: "Follow up" }],
        mode: "auto",
      }),
    ).toMatchObject({
      mode: "auto",
    });

    expect(sendDraftRequestSchema.parse({ mode: "auto" })).toEqual({
      mode: "auto",
    });
    expect(() => sendDraftRequestSchema.parse({})).toThrow();

    expect(
      threadListResponseSchema.parse([
        {
          id: "thr_123",
          projectId: "proj_123",
          environmentId: null,
          automationId: null,
          providerId: "codex",
          type: "standard",
          title: "Pending thread",
          titleFallback: "Pending thread",
          status: "idle",
          parentThreadId: null,
          archivedAt: null,
          stopRequestedAt: null,
          deletedAt: null,
          lastReadAt: null,
          latestAttentionAt: 2,
          createdAt: 1,
          updatedAt: 2,
          runtime: {
            displayStatus: "idle",
            hostReconnectGraceExpiresAt: null,
          },
          hasPendingInteraction: true,
          environmentHostId: "host_123",
          environmentBranchName: "bb/test",
          environmentWorkspaceDisplayKind: "managed-worktree",
        },
      ]),
    ).toMatchObject([
      {
        id: "thr_123",
        hasPendingInteraction: true,
        environmentHostId: "host_123",
        environmentBranchName: "bb/test",
        environmentWorkspaceDisplayKind: "managed-worktree",
      },
    ]);

    expect(
      threadPendingInteractionsResponseSchema.parse([
        {
          id: "pi_123",
          threadId: "thr_123",
          turnId: "turn_123",
          providerId: "codex",
          providerThreadId: "provider-thread-123",
          providerRequestId: "request-123",
          status: "pending",
          payload: {
            subject: {
              kind: "command",
              itemId: "item_123",
              command: "git push",
              cwd: "/tmp/project",
              actions: [],
              sessionGrant: null,
            },
            reason: "Needs approval",
            availableDecisions: ["allow_once", "deny"],
          },
          resolution: null,
          statusReason: null,
          createdAt: 1,
          resolvedAt: null,
        },
      ]),
    ).toHaveLength(1);

    expect(
      resolvePendingInteractionRequestSchema.parse({
        decision: "allow_for_session",
        grantedPermissions: null,
      }),
    ).toMatchObject({
      decision: "allow_for_session",
    });

    expect(
      resolvePendingInteractionRequestSchema.parse({
        decision: "deny",
      }),
    ).toMatchObject({
      decision: "deny",
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

    expect(() =>
      contract.environmentActionResponseSchema.parse({
        action: "commit",
        commitSha: "sha",
        commitSubject: "subject",
        message: "",
        ok: true,
      }),
    ).toThrow();

    expect(() =>
      contract.environmentActionResponseSchema.parse({
        action: "squash_merge",
        commitSha: "sha",
        commitSubject: "subject",
        merged: true,
        message: "",
        ok: true,
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
        model: "claude-opus-4-7",
        providerId: "codex",
        origin: "app",
        reasoningLevel: "high",
        name: "Manager",
        environment: { type: "host", hostId: "host_123" },
      }),
    ).toMatchObject({
      providerId: "codex",
      environment: { type: "host", hostId: "host_123" },
    });

    expect(
      createProjectSourceRequestSchema.parse({
        hostId: "host_123",
        type: "local_path",
        path: " /tmp/project/ ",
      }),
    ).toMatchObject({
      type: "local_path",
      path: "/tmp/project",
    });

    expect(() =>
      createProjectSourceRequestSchema.parse({
        hostId: "host_123",
        type: "local_path",
        path: "relative/project",
      }),
    ).toThrow("Project path must be an absolute path.");

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

    expect(() =>
      contract.updateProjectSourceRequestSchema.parse({
        type: "local_path",
        path: " C:\\Users\\michael\\bb\\ ",
      }),
    ).toThrow("Native Windows paths are not supported");

    expect(() =>
      contract.updateProjectSourceRequestSchema.parse({
        type: "local_path",
        path: "relative/path",
      }),
    ).toThrow("Project path must be an absolute path.");

    expect(
      timelineTurnSummaryDetailsResponseSchema.parse({ rows: [] }),
    ).toEqual({
      rows: [],
    });

    expect(PROJECT_CHANGE_KINDS).toEqual([
      "project-created",
      "project-updated",
      "project-deleted",
      "project-sources-changed",
      "threads-changed",
      "automations-changed",
      "nudges-changed",
    ]);
    expect(SYSTEM_CHANGE_KINDS).toEqual([]);
  });

  it("keeps only intentional optional request fields", () => {
    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        origin: "app",
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

    expect(
      createManagerThreadRequestSchema.parse({
        origin: "cli",
        reasoningLevel: "high",
        name: "Missing model",
        environment: { type: "host", hostId: "host_123" },
      }),
    ).toMatchObject({
      origin: "cli",
    });

    expect(() =>
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        input: [{ type: "text", text: "Ship it" }],
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).toThrow();

    expect(() =>
      createManagerThreadRequestSchema.parse({
        reasoningLevel: "high",
        name: "Missing origin",
        environment: { type: "host", hostId: "host_123" },
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
      publicClient.threads[":id"]["composer-bootstrap"].$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/composer-bootstrap");
    expect(publicClient.system["execution-options"].$url().pathname).toBe(
      "/api/v1/system/execution-options",
    );
    expect(
      publicClient.projects[":id"].managers.$url({
        param: { id: "proj_123" },
      }).pathname,
    ).toBe("/api/v1/projects/proj_123/managers");
    expect(
      publicClient.projects[":id"].automations.$url({
        param: { id: "proj_123" },
      }).pathname,
    ).toBe("/api/v1/projects/proj_123/automations");
    expect(
      publicClient.projects[":id"].automations[":automationId"].$url({
        param: { id: "proj_123", automationId: "auto_123" },
      }).pathname,
    ).toBe("/api/v1/projects/proj_123/automations/auto_123");
    expect(
      publicClient.threads[":id"].timeline["turn-summary-details"].$url({
        param: { id: "thr_123" },
        query: {
          turnId: "turn_123",
          sourceSeqStart: "1",
          sourceSeqEnd: "2",
        },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/timeline/turn-summary-details");
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
    expect(
      publicClient.threads[":id"]["host-files"].content.$url({
        param: { id: "thr_123" },
        query: { path: "/Users/me/notes/plan.md" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/host-files/content");
    expect(
      publicClient.threads[":id"].interactions.$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/interactions");
    expect(
      publicClient.threads[":id"].interactions[":interactionId"].resolve.$url({
        param: { id: "thr_123", interactionId: "pi_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/interactions/pi_123/resolve");
  });

  it("keeps route inputs in shared named types instead of inline objects", () => {
    expect(publicApiSource).not.toMatch(/json:\s*\{/);
    expect(publicApiSource).not.toMatch(/query:\s*\{/);
    expect(publicApiSource).not.toMatch(/form:\s*Record</);
  });

  it("bounds public file list search queries", () => {
    const maxQuery = "a".repeat(contract.FILE_LIST_QUERY_MAX_LENGTH);
    const longQuery = `${maxQuery}a`;

    expect(
      contract.projectFilesQuerySchema.parse({
        query: maxQuery,
        environmentId: "",
      }),
    ).toMatchObject({ query: maxQuery, environmentId: null });
    expect(() =>
      contract.projectFilesQuerySchema.parse({
        query: longQuery,
        environmentId: "",
      }),
    ).toThrow();
    expect(
      contract.threadStorageFilesQuerySchema.parse({ query: maxQuery }),
    ).toMatchObject({ query: maxQuery });
    expect(() =>
      contract.threadStorageFilesQuerySchema.parse({ query: longQuery }),
    ).toThrow();
    expect(
      contract.threadHostFileContentQuerySchema.parse({
        path: "/Users/me/notes/plan.md",
      }),
    ).toEqual({ path: "/Users/me/notes/plan.md" });
  });

  it("rejects zero timeline pagination cursor sequences", () => {
    expect(() =>
      contract.timelinePaginationCursorSchema.parse({
        anchorSeq: 0,
        anchorId: "row-1",
      }),
    ).toThrow();
    expect(() =>
      contract.threadTimelineQuerySchema.parse({
        beforeAnchorSeq: "0",
        beforeAnchorId: "row-1",
      }),
    ).toThrow();
  });

  it("requires manager assignment timeline system rows to carry status", () => {
    const baseRow = {
      id: "row-1",
      threadId: "thr_123",
      turnId: null,
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      startedAt: 1,
      createdAt: 1,
      kind: "system",
      title: "Thread assigned to manager",
      detail: null,
    };
    const managerAssignmentRow = {
      ...baseRow,
      systemKind: "operation",
      operationKind: "manager-assignment",
      status: "completed",
      completedAt: 1,
      managerAssignment: {
        action: "assign",
        previousManagerThreadId: null,
        previousManagerThreadTitle: null,
        nextManagerThreadId: "thr_manager",
        nextManagerThreadTitle: "Manager",
      },
    };

    expect(
      contract.timelineManagerAssignmentSystemRowSchema.parse(
        managerAssignmentRow,
      ),
    ).toMatchObject({
      status: "completed",
    });
    expect(() =>
      contract.timelineManagerAssignmentSystemRowSchema.parse({
        ...managerAssignmentRow,
        status: null,
      }),
    ).toThrow();
    expect(
      contract.timelineSystemRowSchema.parse({
        ...baseRow,
        systemKind: "debug",
        status: null,
      }),
    ).toMatchObject({
      status: null,
    });
  });

  it("keeps contract optional fields on an explicit allowlist", () => {
    const optionalFieldPaths = collectOptionalFieldPaths({
      apiErrorSchema: contract.apiErrorSchema,
      commitActionResponseSchema: contract.commitActionResponseSchema,
      createDraftRequestSchema: contract.createDraftRequestSchema,
      createAutomationRequestSchema: contract.createAutomationRequestSchema,
      createHostJoinRequestSchema: contract.createHostJoinRequestSchema,
      createManagerThreadRequestSchema:
        contract.createManagerThreadRequestSchema,
      createThreadRequestSchema: contract.createThreadRequestSchema,
      environmentActionApiErrorSchema: contract.environmentActionApiErrorSchema,
      environmentStatusResponseSchema: contract.environmentStatusResponseSchema,
      threadStorageFilesQuerySchema: contract.threadStorageFilesQuerySchema,
      projectFilesQuerySchema: contract.projectFilesQuerySchema,
      sendDraftRequestSchema: contract.sendDraftRequestSchema,
      sendDraftResponseSchema: contract.sendDraftResponseSchema,
      sendMessageRequestSchema: contract.sendMessageRequestSchema,
      squashMergeActionResponseSchema: contract.squashMergeActionResponseSchema,
      systemExecutionOptionsQuerySchema:
        contract.systemExecutionOptionsQuerySchema,
      systemProvidersQuerySchema: contract.systemProvidersQuerySchema,
      threadEventsQuerySchema: contract.threadEventsQuerySchema,
      threadListQuerySchema: contract.threadListQuerySchema,
      threadPendingInteractionsResponseSchema:
        contract.threadPendingInteractionsResponseSchema,
      threadTimelineQuerySchema: contract.threadTimelineQuerySchema,
      threadTimelineResponseSchema: contract.threadTimelineResponseSchema,
      timelineTurnSummaryDetailsQuerySchema:
        contract.timelineTurnSummaryDetailsQuerySchema,
      timelineTurnSummaryDetailsRequestSchema:
        contract.timelineTurnSummaryDetailsRequestSchema,
      resolvePendingInteractionRequestSchema:
        contract.resolvePendingInteractionRequestSchema,
      updateAutomationRequestSchema: contract.updateAutomationRequestSchema,
      updateProjectRequestSchema: contract.updateProjectRequestSchema,
      updateProjectSourceRequestSchema:
        contract.updateProjectSourceRequestSchema,
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
