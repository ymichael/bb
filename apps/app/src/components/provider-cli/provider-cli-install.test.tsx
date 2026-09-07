// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ProviderCliInstallEvent } from "@bb/host-daemon-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { appToast } from "@/components/ui/app-toast";
import {
  allSystemExecutionOptionsQueryKeyPrefix,
  hostProviderCliStatusQueryKey,
} from "@/hooks/queries/query-keys";
import type { ProviderCliActionableIssue } from "./provider-cli-install";
import {
  buildProviderCliIssue,
  useProviderCliInstallRunner,
} from "./provider-cli-install";
import {
  PROVIDER_CLI_FAILURE_LOG_MAX_BYTES,
  PROVIDER_CLI_FAILURE_MAX_ENTRIES,
  registerProviderCliInstallQueryClient,
  resetProviderCliInstallStoreForTests,
} from "./provider-cli-install-store";

interface DeferredInstall {
  args: Parameters<typeof sdk.hosts.installProviderCli>[0];
  reject: (error: unknown) => void;
  resolve: (events: ProviderCliInstallEvent[]) => void;
}

vi.mock("@/components/dialogs/ProviderCliInstallLogDialog", () => ({
  ProviderCliInstallLogDialog: () => null,
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/sdk", () => {
  return {
    sdk: {
      hosts: {
        installProviderCli: vi.fn(),
      },
    },
  };
});

const installHostProviderCliMock = vi.mocked(sdk.hosts.installProviderCli);
const appToastMock = vi.mocked(appToast);

let pendingInstalls: DeferredInstall[] = [];
let queryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderRunner() {
  return renderHook(() => useProviderCliInstallRunner(), { wrapper: Wrapper });
}

function issueForProvider(
  provider: "codex" | "claude-code",
): ProviderCliActionableIssue {
  const displayName = provider === "codex" ? "Codex" : "Claude Code";
  const executableName = provider === "codex" ? "codex" : "claude";
  const action = {
    kind: "update" as const,
    label: "Update" as const,
    command: `${executableName} update`,
  };

  return {
    provider,
    status: {
      displayName,
      executableName,
      executablePath: `/usr/local/bin/${executableName}`,
      installed: true,
      installSource: "npmGlobal",
      currentVersion: "1.0.0",
      latestVersion: "1.0.1",
      minimumSupportedVersion: null,
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      installAction: action,
      needsUpdate: true,
      versionUnsupported: false,
    },
    action,
    title: `${displayName} update available`,
    description: "1.0.0 -> 1.0.1",
    fingerprint: `${provider}:outdated`,
  };
}

function completeInstall(
  install: DeferredInstall,
  event: ProviderCliInstallEvent,
): void {
  install.resolve([event]);
}

function installAt(index: number): DeferredInstall {
  const install = pendingInstalls[index];
  if (install === undefined) {
    throw new Error(`Expected pending install at index ${index}`);
  }
  return install;
}

beforeEach(() => {
  pendingInstalls = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  resetProviderCliInstallStoreForTests();
  registerProviderCliInstallQueryClient(queryClient);
  installHostProviderCliMock.mockImplementation(
    (args) =>
      new Promise<ProviderCliInstallEvent[]>((resolve, reject) => {
        pendingInstalls.push({ args, reject, resolve });
      }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("buildProviderCliIssue", () => {
  it("keeps an external update visible when bb cannot apply it", () => {
    const actionable = issueForProvider("claude-code");
    const issue = buildProviderCliIssue({
      provider: "claude-code",
      status: {
        ...actionable.status,
        installSource: "external",
        installAction: null,
      },
    });

    expect(issue).toMatchObject({
      provider: "claude-code",
      action: null,
      title: "Claude Code update available",
    });
  });

  it("describes an update without inventing a target for an unknown channel", () => {
    const actionable = issueForProvider("claude-code");
    const issue = buildProviderCliIssue({
      provider: "claude-code",
      status: {
        ...actionable.status,
        latestVersion: null,
      },
    });

    expect(issue).toMatchObject({
      description: "1.0.0; newer release available",
      title: "Claude Code update available",
    });
  });
});

describe("useProviderCliInstallRunner", () => {
  it("queues a second provider CLI setup behind the active one", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderRunner();

    act(() => {
      result.current.startInstall({
        hostId: "host_1",
        issue: issueForProvider("codex"),
      });
    });

    expect(installHostProviderCliMock).toHaveBeenCalledTimes(1);
    expect(installHostProviderCliMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "codex",
        actionKind: "update",
      }),
    );

    act(() => {
      result.current.startInstall({
        hostId: "host_1",
        issue: issueForProvider("claude-code"),
      });
    });

    expect(installHostProviderCliMock).toHaveBeenCalledTimes(1);
    expect(appToastMock.message).not.toHaveBeenCalled();
    expect(appToastMock.loading).not.toHaveBeenCalled();
    expect(result.current.queuedJobKeys.has("host_1:claude-code")).toBe(true);

    await act(async () => {
      completeInstall(installAt(0), {
        type: "completed",
        provider: "codex",
        success: true,
        exitCode: 0,
        signal: null,
      });
    });

    await waitFor(() => {
      expect(installHostProviderCliMock).toHaveBeenCalledTimes(2);
    });
    expect(installHostProviderCliMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "claude-code",
        actionKind: "update",
      }),
    );
    expect(result.current.queuedJobKeys.has("host_1:claude-code")).toBe(false);

    await act(async () => {
      completeInstall(installAt(1), {
        type: "completed",
        provider: "claude-code",
        success: true,
        exitCode: 0,
        signal: null,
      });
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostProviderCliStatusQueryKey("host_1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: allSystemExecutionOptionsQueryKeyPrefix(),
      predicate: expect.any(Function),
    });
    expect(appToastMock.success).not.toHaveBeenCalled();
  });

  it("keeps draining the queue after every consumer unmounts", async () => {
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result, unmount } = renderRunner();

    act(() => {
      result.current.startInstall({
        hostId: "host_1",
        issue: issueForProvider("codex"),
      });
      result.current.startInstall({
        hostId: "host_1",
        issue: issueForProvider("claude-code"),
      });
    });
    expect(installHostProviderCliMock).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      completeInstall(installAt(0), {
        type: "completed",
        provider: "codex",
        success: true,
        exitCode: 0,
        signal: null,
      });
    });

    await waitFor(() => {
      expect(installHostProviderCliMock).toHaveBeenCalledTimes(2);
    });
    expect(installHostProviderCliMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "claude-code" }),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: hostProviderCliStatusQueryKey("host_1"),
    });

    const remounted = renderRunner();
    expect(remounted.result.current.runningJobKey).toBe("host_1:claude-code");
  });

  it("keeps a failed install and its stderr available for a retry", async () => {
    const { result } = renderRunner();
    const issue = issueForProvider("codex");

    act(() => {
      result.current.startInstall({
        hostId: "host_1",
        issue,
      });
    });

    await act(async () => {
      installAt(0).resolve([
        {
          type: "started",
          provider: "codex",
          command: "codex update",
        },
        {
          type: "output",
          provider: "codex",
          stream: "stderr",
          text: "permission denied\n",
        },
        {
          type: "completed",
          provider: "codex",
          success: false,
          exitCode: 1,
          signal: null,
        },
      ]);
    });

    expect(appToastMock.error).toHaveBeenCalledWith(
      "Codex update failed",
      expect.objectContaining({
        description: "Command exited with code 1",
        action: expect.objectContaining({ label: "View log" }),
      }),
    );
    expect(result.current.failuresByJobKey.get("host_1:codex")).toMatchObject({
      issueFingerprint: issue.fingerprint,
      logDialogState: {
        message: "Command exited with code 1",
        log: "$ codex update\npermission denied\n",
      },
    });

    act(() => {
      result.current.startInstall({ hostId: "host_1", issue });
    });
    expect(result.current.failuresByJobKey.has("host_1:codex")).toBe(false);
  });

  it("bounds retained failures by entry count and log bytes", async () => {
    const { result } = renderRunner();
    const issue = issueForProvider("codex");

    for (let index = 0; index <= PROVIDER_CLI_FAILURE_MAX_ENTRIES; index += 1) {
      const hostId = `host_${index}`;
      act(() => {
        result.current.startInstall({ hostId, issue });
      });
      const output =
        index === PROVIDER_CLI_FAILURE_MAX_ENTRIES
          ? `first line\n${"x".repeat(PROVIDER_CLI_FAILURE_LOG_MAX_BYTES * 2)}\nlast line\n`
          : "failed\n";
      await act(async () => {
        installAt(index).resolve([
          {
            type: "started",
            provider: "codex",
            command: "codex update",
          },
          {
            type: "output",
            provider: "codex",
            stream: "stderr",
            text: output,
          },
          {
            type: "completed",
            provider: "codex",
            success: false,
            exitCode: 1,
            signal: null,
          },
        ]);
      });
    }

    expect(result.current.failuresByJobKey.size).toBe(
      PROVIDER_CLI_FAILURE_MAX_ENTRIES,
    );
    expect(result.current.failuresByJobKey.has("host_0:codex")).toBe(false);
    const newestFailure = result.current.failuresByJobKey.get(
      `host_${PROVIDER_CLI_FAILURE_MAX_ENTRIES}:codex`,
    );
    if (newestFailure === undefined) {
      throw new Error("Expected the newest provider failure to be retained");
    }
    expect(newestFailure.logDialogState.log).toContain(
      "provider update output truncated",
    );
    expect(newestFailure.logDialogState.log).toContain("$ codex update");
    expect(newestFailure.logDialogState.log).toContain("last line");
    expect(
      new TextEncoder().encode(newestFailure.logDialogState.log).byteLength,
    ).toBeLessThanOrEqual(PROVIDER_CLI_FAILURE_LOG_MAX_BYTES);
  });
});
