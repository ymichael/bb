import {
  provisionHostMock,
  resumeHostMock,
} from "./public-thread-test-harness.js";

import {
  createProjectSource,
  getProjectExecutionDefaults,
  listThreads,
  setExperiments,
  upsertProjectExecutionDefaults,
} from "@bb/db";
import { defaultExperiments, threadSchema } from "@bb/domain";
import { sidebarBootstrapResponseSchema } from "@bb/server-contract";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { availableModelFixture } from "../helpers/available-models.js";
import { registerProviderHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThreadRuntimeState,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { beforeEach, describe, expect, it } from "vitest";

describe("public thread default routes", () => {
  beforeEach(() => {
    provisionHostMock.mockReset();
    resumeHostMock.mockReset();
  });

  it("remembers resolved execution options after thread creation", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-create",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-create",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "workspace-write",
          input: [
            { type: "text", text: "Create with explicit execution options" },
          ],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "unmanaged",
              path: null,
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: {
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
      });
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5-mini",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });
    });
  });

  it("allows managed-worktree threads on a secondary host", async () => {
    await withTestHarness(async (harness) => {
      const { host: localHost } = seedHostSession(harness.deps, {
        id: "host-managed-default",
      });
      seedPrimaryHost(harness.deps, localHost.id);
      const { host: secondaryHost } = seedHostSession(harness.deps, {
        id: "host-managed-secondary",
      });
      setExperiments(harness.db, {
        ...defaultExperiments,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: localHost.id,
        path: "/tmp/default-managed-source",
      });
      const secondarySource = createProjectSource(harness.db, harness.hub, {
        projectId: project.id,
        type: "local_path",
        hostId: secondaryHost.id,
        path: "/tmp/secondary-managed-source",
      });
      if (secondarySource.type !== "local_path") {
        throw new Error("Expected local_path project source");
      }

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          title: "Secondary host thread",
          input: [{ type: "text", text: "Build it on the secondary host" }],
          environment: {
            type: "host",
            hostId: secondaryHost.id,
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "default" },
            },
          },
        }),
      });

      expect(response.status).toBe(201);
      const thread = threadSchema.parse(await readJson(response));
      const environmentResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}?include=environment`,
      );
      await expect(readJson(environmentResponse)).resolves.toMatchObject({
        environment: { hostId: secondaryHost.id },
      });
      expect(secondarySource.path).toBe("/tmp/secondary-managed-source");
    });
  });

  it("does not remember project defaults after CLI-origin thread creation", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-cli-origin",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-cli-origin",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "workspace-write",
          input: [
            { type: "text", text: "Create without mutating project defaults" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toBeNull();
    });
  });

  it("inherits the remembered provider and execution defaults when thread creation omits them", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-inherit",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-inherit",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          input: [{ type: "text", text: "Create with inherited defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: {
          model: "gpt-5",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
      });
    });
  });

  it("uses the explicit provider catalog default when stored defaults belong to another provider", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          "claude-code": {
            models: [
              availableModelFixture({
                model: "claude-opus-catalog-default",
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-provider-mismatch",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-provider-mismatch",
      });

      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "fast",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "claude-code",
          input: [
            { type: "text", text: "Create with mismatched provider defaults" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        options: { model: "claude-opus-catalog-default" },
      });
    });
  });

  it("uses the catalog isDefault model when provider and project defaults are omitted", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const providerResponder = registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          codex: {
            models: [
              availableModelFixture({ model: "gpt-first" }),
              availableModelFixture({
                model: "gpt-provider-default",
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-missing",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-missing",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          input: [{ type: "text", text: "Create without defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        providerId: "codex",
        options: { model: "gpt-provider-default" },
      });
      expect(
        providerResponder.requests.map((request) => request.command),
      ).toMatchObject([
        {
          type: "provider.list_models",
          providerId: "codex",
        },
      ]);
      expect(providerResponder.requests[0].command).not.toHaveProperty("cwd");
    });
  });

  it("creates from displayed execution values when only the provider has a client source", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        restoreCommandCaptureAfterResponse: true,
        modelsByProviderId: {
          codex: {
            models: [
              availableModelFixture({
                model: "gpt-provider-default",
                isDefault: true,
              }),
            ],
            selectedOnlyModels: [],
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-client-provider",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-client-provider",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-provider-default",
          reasoningLevel: "medium",
          permissionMode: "auto",
          executionInputSources: {
            providerId: "client-preference",
          },
          input: [
            { type: "text", text: "Create from the new thread composer" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      expect(queuedStart.command).toMatchObject({
        providerId: "codex",
        options: {
          model: "gpt-provider-default",
          reasoningLevel: "medium",
          permissionMode: "auto",
        },
      });
    });
  });

  it("returns an actionable error when the default model catalog cannot be loaded", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerProviderHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        modelErrorsByProviderId: {
          codex: {
            errorCode: "command_failed",
            errorMessage: "Codex model discovery failed",
          },
        },
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-catalog-error",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-catalog-error",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "cli",
          projectId: project.id,
          input: [{ type: "text", text: "Create without defaults" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(503);
      await expect(readJson(response)).resolves.toEqual({
        code: "model_catalog_unavailable",
        message: expect.stringContaining("Unable to load codex models"),
        details: { providerId: "codex", code: "failed" },
        retryable: true,
      });
      expect(listThreads(harness.db, { projectId: project.id })).toHaveLength(
        0,
      );
    });
  });

  it("rejects thread creation without an origin at the public API boundary", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-missing-origin",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-defaults-missing-origin",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5-mini",
          input: [{ type: "text", text: "Create without origin" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining('expected one of "app"|"cli"'),
      });
    });
  });

  it("does not overwrite project execution defaults after a thread send", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-send-defaults",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-send-defaults",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-send-defaults",
        model: "gpt-5",
      });
      upsertProjectExecutionDefaults(harness.db, {
        projectId: project.id,
        providerId: thread.providerId,
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "auto",
            input: [{ type: "text", text: "Use explicit send defaults" }],
            model: "gpt-5-mini",
            serviceTier: "fast",
            reasoningLevel: "high",
            permissionMode: "workspace-write",
          }),
        },
      );

      expect(response.status).toBe(200);
      const queuedRun = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queuedRun.command).toMatchObject({
        options: {
          model: "gpt-5-mini",
          serviceTier: "fast",
          reasoningLevel: "high",
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
      });
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toEqual({
        providerId: "codex",
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });
    });
  });

  it("does not synthesize project defaults in sidebar bootstrap", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-sidebar",
      });

      const response = await harness.app.request("/api/v1/sidebar-bootstrap");

      expect(response.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(response),
      );
      const sidebarProject = bootstrap.projects.find(
        (candidate) => candidate.id === project.id,
      );
      expect(sidebarProject?.defaultExecutionOptions).toBeNull();
      expect(
        getProjectExecutionDefaults(harness.db, {
          projectId: project.id,
        }),
      ).toBeNull();
    });
  });

  it("excludes side-chat threads from sidebar bootstrap", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-sidebar-side-chat",
      });
      const parentThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Parent",
      });
      const sideChatThread = seedThread(harness.deps, {
        projectId: project.id,
        sourceThreadId: parentThread.id,
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
        title: "Side chat",
      });

      const response = await harness.app.request("/api/v1/sidebar-bootstrap");

      expect(response.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(response),
      );
      const sidebarProject = bootstrap.projects.find(
        (candidate) => candidate.id === project.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).toContain(
        parentThread.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).not.toContain(
        sideChatThread.id,
      );
    });
  });

  it("excludes hidden threads from sidebar bootstrap", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-defaults-sidebar-hidden",
      });
      const visibleThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Visible thread",
      });
      const hiddenThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Hidden worker",
        visibility: "hidden",
      });

      const response = await harness.app.request("/api/v1/sidebar-bootstrap");

      expect(response.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(response),
      );
      const sidebarProject = bootstrap.projects.find(
        (candidate) => candidate.id === project.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).toContain(
        visibleThread.id,
      );
      expect(sidebarProject?.threads.map((thread) => thread.id)).not.toContain(
        hiddenThread.id,
      );
    });
  });
});
