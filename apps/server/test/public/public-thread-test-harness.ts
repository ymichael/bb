import type { SandboxHostProgressCallbacks } from "@bb/sandbox-host";
import {
  makeWorkspaceMergeBase,
  makeWorkspaceStatus,
} from "@bb/test-helpers";
import { vi } from "vitest";

export const provisionHostMock = vi.fn();
export const resumeHostMock = vi.fn();

type SandboxHostMockArgs = Array<object | string | undefined>;

export interface SandboxProvisionCall {
  daemonEnv?: Record<string, string>;
  enrollKey?: string;
  hostId: string;
  hostName: string;
  progressCallbacks?: SandboxHostProgressCallbacks;
}

// Server tests treat @bb/sandbox-host as the external sandbox boundary.
// Package-level tests cover the E2B mechanics directly; these tests focus on
// server policy and request/response behavior.
vi.mock("@bb/sandbox-host", () => ({
  DEFAULT_SANDBOX_TIMEOUT_MS: 15 * 60 * 1000,
  SANDBOX_DATA_DIR: "/tmp/bb-data",
  provisionHost: (...args: SandboxHostMockArgs) => provisionHostMock(...args),
  resumeHost: (...args: SandboxHostMockArgs) => resumeHostMock(...args),
}));

export function cleanWorkspaceStatus() {
  return makeWorkspaceStatus({
    branch: { currentBranch: "bb/thread", defaultBranch: "main" },
    mergeBase: makeWorkspaceMergeBase({ baseRef: "origin/main" }),
  });
}
