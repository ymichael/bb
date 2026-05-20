// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Environment, Host, ThreadWithRuntime } from "@bb/domain";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installAbortableJsonRoute } from "@/test/abort-signal-test-utils";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import { useEffectiveHost } from "./effective-hosts";
import { useEnvironment } from "./environment-queries";
import {
  useThread,
  useThreadComposerBootstrap,
  useThreadDetailBootstrap,
  useThreadDefaultExecutionOptions,
  useThreadHostFilePreview,
  useThreadQueuedMessages,
  useThreadPendingInteractions,
  useThreadPromptHistory,
  useThreadStatusVersion,
} from "./thread-queries";
import {
  hostsQueryKey,
  systemExecutionOptionsQueryKey,
  threadDefaultExecutionOptionsQueryKey,
  threadHostFilePreviewQueryKey,
  threadQueuedMessagesQueryKey,
  threadPendingInteractionsQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadStatusVersionQueryKey,
} from "./query-keys";

interface TestWrapperProps {
  children: ReactNode;
}

function makeThread(): ThreadWithRuntime {
  return {
    archivedAt: null,
    automationId: null,
    createdAt: 1,
    deletedAt: null,
    environmentId: "environment-1",
    id: "thread-1",
    lastReadAt: null,
    latestAttentionAt: 10,
    parentThreadId: null,
    projectId: "project-1",
    providerId: "provider-1",
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    status: "idle",
    stopRequestedAt: null,
    title: "Thread title",
    titleFallback: "Thread title",
    type: "standard",
    updatedAt: 10,
  };
}

function makeEnvironment(): Environment {
  return {
    baseBranch: null,
    branchName: "bb/test",
    cleanupMode: null,
    cleanupRequestedAt: null,
    createdAt: 1,
    defaultBranch: "main",
    hostId: "host-1",
    id: "environment-1",
    isGitRepo: true,
    isWorktree: false,
    managed: false,
    mergeBaseBranch: null,
    path: "/tmp/thread-detail-bootstrap",
    projectId: "project-1",
    status: "ready",
    updatedAt: 1,
    workspaceProvisionType: "unmanaged",
  };
}

function makeHost(): Host {
  return {
    createdAt: 1,
    id: "host-1",
    lastSeenAt: 1,
    name: "Test Host",
    status: "connected",
    type: "persistent",
    updatedAt: 1,
  };
}

function createWrapper() {
  const harness = createQueryClientTestHarness();

  function Wrapper({ children }: TestWrapperProps) {
    return harness.wrapper({ children });
  }

  return {
    queryClient: harness.queryClient,
    wrapper: Wrapper,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("thread query bootstraps", () => {
  it("primes thread, environment, and host caches from the thread detail bootstrap", async () => {
    const thread = makeThread();
    const environment = makeEnvironment();
    const host = makeHost();
    let includeThreadRequestCount = 0;
    let leanThreadRequestCount = 0;
    let hostListRequestCount = 0;
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thread-1",
        handler: (request) => {
          const url = new URL(request.url);
          if (url.searchParams.get("include") === "environment,host") {
            includeThreadRequestCount += 1;
            return jsonResponse({
              ...thread,
              environment,
              host,
            });
          }
          leanThreadRequestCount += 1;
          return jsonResponse(thread);
        },
      },
      {
        pathname: "/api/v1/hosts",
        handler: () => {
          hostListRequestCount += 1;
          return jsonResponse([host]);
        },
      },
    ]);
    const { queryClient, wrapper } = createWrapper();

    const { result } = renderHook(
      () => {
        const bootstrap = useThreadDetailBootstrap("thread-1");
        const canonicalEnabled = bootstrap.isSuccess || bootstrap.isError;
        const canonicalThread = useThread("thread-1", {
          enabled: canonicalEnabled,
          refetchOnMount: bootstrap.isSuccess ? true : "always",
        });
        const canonicalEnvironment = useEnvironment("environment-1", {
          enabled: canonicalEnabled,
          staleTime: 5_000,
        });
        const effectiveHost = useEffectiveHost("host-1", {
          enabled: canonicalEnabled,
        });
        return {
          bootstrap,
          canonicalEnvironment,
          canonicalThread,
          effectiveHost,
        };
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.bootstrap.status).toBe("success");
      expect(result.current.canonicalThread.data?.id).toBe(thread.id);
      expect(result.current.canonicalEnvironment.data?.id).toBe(environment.id);
      expect(result.current.effectiveHost.data?.id).toBe(host.id);
    });
    expect(queryClient.getQueryData(hostsQueryKey())).toEqual([host]);
    expect(includeThreadRequestCount).toBe(1);
    expect(leanThreadRequestCount).toBe(0);
    expect(hostListRequestCount).toBe(0);

    await queryClient.invalidateQueries({
      queryKey: threadQueryKey(thread.id),
    });
    await waitFor(() => {
      expect(leanThreadRequestCount).toBe(1);
    });
    expect(includeThreadRequestCount).toBe(1);
  });

  it("falls back to the lean thread query when the detail bootstrap fails", async () => {
    const thread = makeThread();
    let includeThreadRequestCount = 0;
    let leanThreadRequestCount = 0;
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thread-1",
        handler: (request) => {
          const url = new URL(request.url);
          if (url.searchParams.get("include") === "environment,host") {
            includeThreadRequestCount += 1;
            return new Response("starting", { status: 503 });
          }
          leanThreadRequestCount += 1;
          return jsonResponse(thread);
        },
      },
    ]);
    const { wrapper } = createWrapper();

    const { result } = renderHook(
      () => {
        const bootstrap = useThreadDetailBootstrap("thread-1");
        const canonicalThread = useThread("thread-1", {
          enabled: bootstrap.isSuccess || bootstrap.isError,
          refetchOnMount: bootstrap.isSuccess ? true : "always",
        });
        return { bootstrap, canonicalThread };
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.bootstrap.status).toBe("error");
      expect(result.current.canonicalThread.data?.id).toBe(thread.id);
    });
    expect(includeThreadRequestCount).toBe(1);
    expect(leanThreadRequestCount).toBe(1);
  });

  it("primes composer caches from the thread composer bootstrap", async () => {
    const defaultExecutionOptions = {
      model: "gpt-5.5",
      permissionMode: "workspace-write",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    };
    const queuedMessages = [
      {
        id: "qmsg-1",
        content: [{ type: "text", text: "queued message" }],
        createdAt: 1,
        model: "gpt-5.5",
        permissionMode: "workspace-write",
        reasoningLevel: "medium",
        serviceTier: "default",
        updatedAt: 1,
      },
    ];
    const promptHistory = [
      {
        id: "event-1",
        createdAt: 2,
        input: [{ type: "text", text: "accepted prompt" }],
      },
    ];
    const executionOptions = {
      providers: [
        {
          id: "codex",
          displayName: "Codex",
          available: true,
          capabilities: {
            supportsArchive: true,
            supportsRename: true,
            supportsServiceTier: true,
            supportedPermissionModes: ["full", "workspace-write", "readonly"],
          },
        },
      ],
      models: [
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          displayName: "GPT-5.5",
          description: "Frontier model",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "medium",
              description: "Balanced",
            },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    };
    let bootstrapRequestCount = 0;
    let fallbackRequestCount = 0;
    let executionOptionsHostlessRequestCount = 0;
    let executionOptionsScopedRequestCount = 0;
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thread-1/composer-bootstrap",
        handler: () => {
          bootstrapRequestCount += 1;
          return jsonResponse({
            defaultExecutionOptions,
            queuedMessages,
            executionOptions,
            pendingInteractions: [],
            promptHistory,
          });
        },
      },
      {
        pathname: "/api/v1/threads/thread-1/default-execution-options",
        handler: () => {
          fallbackRequestCount += 1;
          return jsonResponse(defaultExecutionOptions);
        },
      },
      {
        pathname: "/api/v1/threads/thread-1/queued-messages",
        handler: () => {
          fallbackRequestCount += 1;
          return jsonResponse(queuedMessages);
        },
      },
      {
        pathname: "/api/v1/threads/thread-1/prompt-history",
        handler: () => {
          fallbackRequestCount += 1;
          return jsonResponse(promptHistory);
        },
      },
      {
        pathname: "/api/v1/threads/thread-1/interactions",
        handler: () => {
          fallbackRequestCount += 1;
          return jsonResponse([]);
        },
      },
      {
        pathname: "/api/v1/system/execution-options",
        handler: (request) => {
          const environmentId = new URL(request.url).searchParams.get(
            "environmentId",
          );
          if (environmentId === "environment-1") {
            executionOptionsScopedRequestCount += 1;
          } else {
            executionOptionsHostlessRequestCount += 1;
          }
          return jsonResponse(executionOptions);
        },
      },
    ]);
    const { queryClient, wrapper } = createWrapper();

    const { result } = renderHook(
      () => {
        const bootstrap = useThreadComposerBootstrap("thread-1", {
          environmentId: "environment-1",
        });
        const canonicalEnabled = bootstrap.isSuccess || bootstrap.isError;
        const seededStaleTime = bootstrap.isSuccess ? 10_000 : undefined;
        const defaultExecution = useThreadDefaultExecutionOptions("thread-1", {
          enabled: canonicalEnabled,
          refetchOnMount: bootstrap.isSuccess ? false : "always",
          staleTime: seededStaleTime,
        });
        const queuedMessageList = useThreadQueuedMessages("thread-1", {
          enabled: canonicalEnabled,
          refetchOnMount: bootstrap.isSuccess ? false : "always",
          staleTime: seededStaleTime,
        });
        const history = useThreadPromptHistory("thread-1", {
          enabled: canonicalEnabled,
          refetchOnMount: bootstrap.isSuccess ? false : "always",
          staleTime: seededStaleTime,
        });
        const interactions = useThreadPendingInteractions("thread-1", {
          enabled: canonicalEnabled,
          refetchOnMount: bootstrap.isSuccess ? false : "always",
          staleTime: seededStaleTime,
        });
        const creationOptions = useThreadCreationOptions({
          enabled: canonicalEnabled,
          environmentId: "environment-1",
          initialModel: "gpt-5.5",
          initialProviderId: "codex",
          resetKey: "thread-1",
          scope: "component-local",
        });
        return {
          bootstrap,
          creationOptions,
          defaultExecution,
          queuedMessageList,
          history,
          interactions,
        };
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.bootstrap.status).toBe("success");
      expect(result.current.defaultExecution.data?.model).toBe("gpt-5.5");
      expect(result.current.queuedMessageList.data).toEqual(queuedMessages);
      expect(result.current.creationOptions.selectedProviderId).toBe("codex");
      expect(result.current.creationOptions.modelOptions).toEqual([
        {
          label: "GPT-5.5",
          value: "gpt-5.5",
        },
      ]);
      expect(result.current.history.data).toEqual(promptHistory);
      expect(result.current.interactions.data).toEqual([]);
    });
    expect(
      queryClient.getQueryData(
        threadDefaultExecutionOptionsQueryKey("thread-1"),
      ),
    ).toEqual(defaultExecutionOptions);
    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(queuedMessages);
    expect(
      queryClient.getQueryData(threadPromptHistoryQueryKey("thread-1")),
    ).toEqual(promptHistory);
    expect(
      queryClient.getQueryData(threadPendingInteractionsQueryKey("thread-1")),
    ).toEqual([]);
    expect(
      queryClient.getQueryData(
        systemExecutionOptionsQueryKey({
          environmentId: "environment-1",
          providerId: "codex",
        }),
      ),
    ).toEqual(executionOptions);
    expect(bootstrapRequestCount).toBe(1);
    expect(fallbackRequestCount).toBe(0);
    expect(executionOptionsHostlessRequestCount).toBe(0);
    expect(executionOptionsScopedRequestCount).toBe(0);

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: systemExecutionOptionsQueryKey({
          environmentId: "environment-1",
          providerId: "codex",
        }),
      });
    });

    await waitFor(() => {
      expect(executionOptionsScopedRequestCount).toBe(1);
    });
    expect(executionOptionsHostlessRequestCount).toBe(0);
  });
});

describe("thread prompt history query", () => {
  it("passes AbortSignal through thread prompt history requests", async () => {
    const route = installAbortableJsonRoute({
      pathname: "/api/v1/threads/thread-1/prompt-history",
      body: [],
    });
    const { wrapper } = createWrapper();
    const { unmount } = renderHook(() => useThreadPromptHistory("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(route.getSignal()).toBeInstanceOf(AbortSignal);
    });

    unmount();

    await waitFor(() => {
      expect(route.getSignal()?.aborted).toBe(true);
    });
  });
});

describe("thread status version query", () => {
  it("polls every two seconds and stops when unmounted", async () => {
    vi.useFakeTimers();
    let requestCount = 0;
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thread-1/status-version",
        handler: () => {
          requestCount += 1;
          return jsonResponse({
            source: "folder",
            hash: `status-hash-${requestCount}`,
          });
        },
      },
    ]);
    const { queryClient, wrapper } = createWrapper();

    const { result, unmount } = renderHook(
      () => useThreadStatusVersion("thread-1"),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(requestCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(requestCount).toBe(2);
    expect(
      queryClient.getQueryData(threadStatusVersionQueryKey("thread-1")),
    ).toEqual({ source: "folder", hash: "status-hash-2" });

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(requestCount).toBe(2);
  });
});

describe("thread host file preview query", () => {
  it("loads host file content lazily through the thread-scoped route", async () => {
    const hostPath = "/Users/me/notes/plan.md";
    // Use an object holder so TS doesn't narrow the outer variable away
    // (the assignment lives inside the fetch callback, which TS can't
    // follow back into the test body).
    const requestUrlRef: { current: URL | null } = { current: null };
    installFetchRoutes([
      {
        pathname: "/api/v1/threads/thread-1/host-files/content",
        handler: (request) => {
          requestUrlRef.current = new URL(request.url);
          return new Response("# Plan\n", {
            headers: { "content-type": "text/markdown" },
          });
        },
      },
    ]);
    const { queryClient, wrapper } = createWrapper();

    const { result } = renderHook(
      () => useThreadHostFilePreview("thread-1", "env-1", hostPath),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(requestUrlRef.current?.searchParams.get("path")).toBe(hostPath);
    expect(result.current.data).toMatchObject({
      kind: "text",
      path: hostPath,
      name: "plan.md",
      content: "# Plan\n",
    });
    expect(
      queryClient.getQueryData(
        threadHostFilePreviewQueryKey("thread-1", "env-1", hostPath),
      ),
    ).toEqual(result.current.data);
  });

  it("does not fetch host file content until enabled with a path", () => {
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/threads/thread-1/host-files/content",
        handler: () => new Response("unused"),
      },
    ]);
    const { wrapper } = createWrapper();

    renderHook(
      () =>
        useThreadHostFilePreview("thread-1", "env-1", null, {
          enabled: true,
        }),
      { wrapper },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch host file content without a thread environment", () => {
    const fetchMock = installFetchRoutes([
      {
        pathname: "/api/v1/threads/thread-1/host-files/content",
        handler: () => new Response("unused"),
      },
    ]);
    const { wrapper } = createWrapper();

    renderHook(
      () =>
        useThreadHostFilePreview("thread-1", null, "/Users/me/notes/plan.md", {
          enabled: true,
        }),
      { wrapper },
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
