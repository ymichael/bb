// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Environment, Host, ThreadWithRuntime } from "@bb/domain";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import { useEffectiveHost } from "./effective-hosts";
import { useEnvironment } from "./environment-queries";
import {
  useThread,
  useThreadDetailBootstrap,
} from "./thread-queries";
import { hostsQueryKey, threadQueryKey } from "./query-keys";

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

    await queryClient.invalidateQueries({ queryKey: threadQueryKey(thread.id) });
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
});
