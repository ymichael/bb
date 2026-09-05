// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useSystemEnvironmentProviders } from "./environment-provider-queries";

vi.mock("@/lib/sdk", () => ({
  sdk: { environments: { listProviders: vi.fn() } },
}));

const WORKTREE_PROVIDER: SystemEnvironmentProvider = {
  id: "git-worktree",
  displayName: "Worktree",
  icon: "GitBranch",
  logoUrl: null,
  pluginId: "environment-git-worktree",
  acceptsEmptyInputs: true,
  availability: null,
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
  inputs: null,
};

function pendingForever(): Promise<never> {
  return new Promise(() => {});
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSystemEnvironmentProviders", () => {
  it("loads availability for the requested project and machine", async () => {
    vi.mocked(sdk.environments.listProviders).mockResolvedValue([
      WORKTREE_PROVIDER,
    ]);
    const { result } = renderHook(
      () =>
        useSystemEnvironmentProviders({
          projectId: "project-1",
          hostId: "host-1",
        }),
      {
        wrapper: createQueryClientTestHarness().wrapper,
      },
    );

    await waitFor(() =>
      expect(result.current.providers).toEqual([WORKTREE_PROVIDER]),
    );
    expect(sdk.environments.listProviders).toHaveBeenCalledWith({
      projectId: "project-1",
      hostId: "host-1",
    });
  });

  it("reports the list as unresolved when nothing was remembered", () => {
    vi.mocked(sdk.environments.listProviders).mockImplementation(
      pendingForever,
    );
    const { result } = renderHook(() => useSystemEnvironmentProviders(), {
      wrapper: createQueryClientTestHarness().wrapper,
    });

    expect(result.current.providers).toBeUndefined();
  });
});
