import { describe, expect, it } from "vitest";
import {
  buildSpawnEnvironment,
  looksLikePath,
  requireHostId,
} from "../commands/thread/spawn.js";
import {
  parseThreadWaitTimeoutSeconds,
  parseThreadWaitPollIntervalMs,
  parseServiceTier,
  parsePermissionMode,
  DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS,
  DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  PERMISSION_MODE_HELP,
} from "../commands/thread/helpers.js";

describe("looksLikePath", () => {
  it("returns true for absolute paths", () => {
    expect(looksLikePath("/absolute/path")).toBe(true);
  });

  it("returns true for relative paths starting with ./", () => {
    expect(looksLikePath("./relative")).toBe(true);
  });

  it("returns true for home-relative paths starting with ~", () => {
    expect(looksLikePath("~/home/dir")).toBe(true);
  });

  it("returns true for parent-relative paths starting with ../", () => {
    expect(looksLikePath("../parent")).toBe(true);
  });

  it("returns true for paths containing slashes", () => {
    expect(looksLikePath("some/nested/dir")).toBe(true);
  });

  it("returns false for bare words", () => {
    expect(looksLikePath("worktree")).toBe(false);
    expect(looksLikePath("e2b")).toBe(false);
    expect(looksLikePath("docker")).toBe(false);
  });
});

describe("requireHostId", () => {
  it("returns the host ID when non-null", () => {
    expect(requireHostId("host-123")).toBe("host-123");
  });

  it("throws when host ID is null", () => {
    expect(() => requireHostId(null)).toThrow("Cannot reach local host daemon");
  });

  it("throws when host ID is empty string", () => {
    expect(() => requireHostId("")).toThrow("Cannot reach local host daemon");
  });
});

describe("buildSpawnEnvironment", () => {
  const HOST_ID = "test-host-id";

  it("returns unmanaged host with null path when no flags are provided", () => {
    const result = buildSpawnEnvironment({ hostId: HOST_ID });
    expect(result).toEqual({
      type: "host",
      hostId: HOST_ID,
      workspace: { type: "unmanaged", path: null },
    });
  });

  it("throws for bare e2b without sandbox/ prefix", () => {
    expect(() =>
      buildSpawnEnvironment({
        newEnvironmentKind: "e2b",
        hostId: null,
      }),
    ).toThrow("Unknown environment kind 'e2b'");
  });

  it("returns managed-worktree for --new-environment worktree with host", () => {
    const result = buildSpawnEnvironment({
      newEnvironmentKind: "worktree",
      hostId: HOST_ID,
    });
    expect(result).toEqual({
      type: "host",
      hostId: HOST_ID,
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "default" },
      },
    });
  });

  it("throws for --new-environment worktree when host is null", () => {
    expect(() =>
      buildSpawnEnvironment({ newEnvironmentKind: "worktree", hostId: null }),
    ).toThrow("Cannot reach local host daemon");
  });

  it("returns sandbox for --new-environment sandbox/e2b", () => {
    const result = buildSpawnEnvironment({
      newEnvironmentKind: "sandbox/e2b",
      hostId: null,
    });
    expect(result).toEqual({
      type: "sandbox-host",
      sandboxType: "e2b",
      baseBranch: { kind: "default" },
    });
  });

  it("returns sandbox for any sandbox/ prefix", () => {
    const result = buildSpawnEnvironment({
      newEnvironmentKind: "sandbox/daytona",
      hostId: null,
    });
    expect(result).toEqual({
      type: "sandbox-host",
      sandboxType: "daytona",
      baseBranch: { kind: "default" },
    });
  });

  it("throws for sandbox/ with no type", () => {
    expect(() =>
      buildSpawnEnvironment({
        newEnvironmentKind: "sandbox/",
        hostId: HOST_ID,
      }),
    ).toThrow("Missing sandbox type after 'sandbox/'");
  });

  it("throws when combining --host with sandbox environment", () => {
    expect(() =>
      buildSpawnEnvironment({
        newEnvironmentKind: "sandbox/e2b",
        hostId: HOST_ID,
        explicitHost: true,
      }),
    ).toThrow("Cannot combine --host with sandbox environments");
  });

  it("throws for unknown --new-environment kind", () => {
    expect(() =>
      buildSpawnEnvironment({
        newEnvironmentKind: "docker",
        hostId: HOST_ID,
      }),
    ).toThrow("Unknown environment kind 'docker'");
  });

  it("throws when combining --environment with --new-environment", () => {
    expect(() =>
      buildSpawnEnvironment({
        environmentValue: "some-env-id",
        newEnvironmentKind: "e2b",
        hostId: HOST_ID,
      }),
    ).toThrow("Cannot combine --environment with --new-environment");
  });

  it("returns unmanaged host with path for path-like --environment", () => {
    const result = buildSpawnEnvironment({
      environmentValue: "/absolute/workspace",
      hostId: HOST_ID,
    });
    expect(result).toEqual({
      type: "host",
      hostId: HOST_ID,
      workspace: { type: "unmanaged", path: "/absolute/workspace" },
    });
  });

  it("returns unmanaged host with path for relative --environment", () => {
    const result = buildSpawnEnvironment({
      environmentValue: "./my-project",
      hostId: HOST_ID,
    });
    expect(result).toEqual({
      type: "host",
      hostId: HOST_ID,
      workspace: { type: "unmanaged", path: "./my-project" },
    });
  });

  it("returns reuse for non-path --environment (UUID)", () => {
    const result = buildSpawnEnvironment({
      environmentValue: "env-uuid-123",
      hostId: HOST_ID,
    });
    expect(result).toEqual({
      type: "reuse",
      environmentId: "env-uuid-123",
    });
  });

  it("trims whitespace from environment values", () => {
    const result = buildSpawnEnvironment({
      newEnvironmentKind: "  sandbox/e2b  ",
      hostId: null,
    });
    expect(result).toEqual({
      type: "sandbox-host",
      sandboxType: "e2b",
      baseBranch: { kind: "default" },
    });
  });
});

describe("parseThreadWaitTimeoutSeconds", () => {
  it("returns default when undefined", () => {
    expect(parseThreadWaitTimeoutSeconds(undefined)).toBe(
      DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS,
    );
  });

  it("returns parsed number for valid input", () => {
    expect(parseThreadWaitTimeoutSeconds("60")).toBe(60);
    expect(parseThreadWaitTimeoutSeconds("0")).toBe(0);
    expect(parseThreadWaitTimeoutSeconds("1.5")).toBe(1.5);
  });

  it("throws for negative numbers", () => {
    expect(() => parseThreadWaitTimeoutSeconds("-1")).toThrow(
      "non-negative number",
    );
  });

  it("throws for non-numeric strings", () => {
    expect(() => parseThreadWaitTimeoutSeconds("abc")).toThrow(
      "non-negative number",
    );
  });
});

describe("parseThreadWaitPollIntervalMs", () => {
  it("returns default when undefined", () => {
    expect(parseThreadWaitPollIntervalMs(undefined)).toBe(
      DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
    );
  });

  it("returns parsed integer for valid input", () => {
    expect(parseThreadWaitPollIntervalMs("500")).toBe(500);
    expect(parseThreadWaitPollIntervalMs("1")).toBe(1);
  });

  it("throws for zero", () => {
    expect(() => parseThreadWaitPollIntervalMs("0")).toThrow(
      "positive integer",
    );
  });

  it("throws for negative numbers", () => {
    expect(() => parseThreadWaitPollIntervalMs("-100")).toThrow(
      "positive integer",
    );
  });
});

describe("parseServiceTier", () => {
  it("returns undefined when undefined", () => {
    expect(parseServiceTier(undefined)).toBeUndefined();
  });

  it("returns 'fast' for 'fast'", () => {
    expect(parseServiceTier("fast")).toBe("fast");
  });

  it("returns 'default' for 'default'", () => {
    expect(parseServiceTier("default")).toBe("default");
  });

  it("throws for invalid tier", () => {
    expect(() => parseServiceTier("turbo")).toThrow("Invalid service tier");
  });
});

describe("parsePermissionMode", () => {
  it("returns undefined when undefined", () => {
    expect(parsePermissionMode(undefined)).toBeUndefined();
  });

  it("returns 'workspace-write' for 'workspace-write'", () => {
    expect(parsePermissionMode("workspace-write")).toBe("workspace-write");
  });

  it("returns 'readonly' for 'readonly'", () => {
    expect(parsePermissionMode("readonly")).toBe("readonly");
  });

  it("returns 'full' for 'full'", () => {
    expect(parsePermissionMode("full")).toBe("full");
  });

  it("throws for invalid mode", () => {
    expect(() => parsePermissionMode("readwrite")).toThrow(
      "Invalid permission mode 'readwrite'. Expected full, workspace-write, or readonly.",
    );
  });

  it("exposes user-facing help in product terms", () => {
    expect(PERMISSION_MODE_HELP).toBe(
      "Permission mode: full, workspace-write, or readonly",
    );
  });
});
