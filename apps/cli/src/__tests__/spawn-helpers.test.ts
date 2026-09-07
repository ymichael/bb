import { describe, expect, it } from "vitest";
import { DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS } from "@bb/sdk";
import {
  buildSpawnEnvironment,
  looksLikePath,
  requireHostId,
} from "../commands/thread/spawn.js";
import {
  DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS,
  parseThreadWaitTimeoutSeconds,
  parseThreadWaitPollIntervalMs,
  parseServiceTier,
  parsePermissionMode,
} from "../commands/thread/helpers.js";

const acceptedParserCases = [
  {
    label: "wait timeout default",
    parse: () => parseThreadWaitTimeoutSeconds(undefined),
    expected: DEFAULT_THREAD_WAIT_TIMEOUT_SECONDS,
  },
  {
    label: "decimal wait timeout",
    parse: () => parseThreadWaitTimeoutSeconds("1.5"),
    expected: 1.5,
  },
  {
    label: "poll interval default",
    parse: () => parseThreadWaitPollIntervalMs(undefined),
    expected: DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS,
  },
  {
    label: "integer poll interval",
    parse: () => parseThreadWaitPollIntervalMs("500"),
    expected: 500,
  },
  {
    label: "omitted service tier",
    parse: () => parseServiceTier(undefined),
    expected: undefined,
  },
  {
    label: "fast service tier",
    parse: () => parseServiceTier("fast"),
    expected: "fast",
  },
  {
    label: "omitted permission mode",
    parse: () => parsePermissionMode(undefined),
    expected: undefined,
  },
  {
    label: "accept-edits permission mode",
    parse: () => parsePermissionMode("accept-edits"),
    expected: "accept-edits",
  },
  {
    label: "auto permission mode",
    parse: () => parsePermissionMode("auto"),
    expected: "auto",
  },
  {
    label: "full permission mode",
    parse: () => parsePermissionMode("full"),
    expected: "full",
  },
  {
    label: "deprecated workspace-write permission mode",
    parse: () => parsePermissionMode("workspace-write"),
    expected: "accept-edits",
  },
] as const;

describe("accepted thread argument values", () => {
  it.each(acceptedParserCases)("parses $label", ({ parse, expected }) => {
    expect(parse()).toBe(expected);
  });
});

describe("looksLikePath", () => {
  it("returns false for bare words", () => {
    expect(looksLikePath("worktree")).toBe(false);
    expect(looksLikePath("docker")).toBe(false);
  });
});

describe("requireHostId", () => {
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
    const result = buildSpawnEnvironment({
      defaultPersonalWorkspace: false,
      hostId: HOST_ID,
    });
    expect(result).toEqual({
      type: "host",
      hostId: HOST_ID,
      workspace: { type: "unmanaged", path: null },
    });
  });

  it("returns personal workspace when personal project defaults are active", () => {
    const result = buildSpawnEnvironment({
      defaultPersonalWorkspace: true,
      hostId: null,
    });
    expect(result).toEqual({
      type: "host",
      workspace: { type: "personal" },
    });
  });

  it("throws for unsupported managed environment kinds", () => {
    expect(() =>
      buildSpawnEnvironment({
        defaultPersonalWorkspace: false,
        newEnvironmentKind: "docker",
        hostId: null,
      }),
    ).toThrow("Unknown environment kind 'docker'");
  });

  it("returns managed-worktree for --new-environment worktree with host", () => {
    const result = buildSpawnEnvironment({
      defaultPersonalWorkspace: false,
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

  it("returns personal for --new-environment personal with host", () => {
    const result = buildSpawnEnvironment({
      defaultPersonalWorkspace: false,
      newEnvironmentKind: "personal",
      hostId: HOST_ID,
    });
    expect(result).toEqual({
      type: "host",
      hostId: HOST_ID,
      workspace: { type: "personal" },
    });
  });

  it("returns named base branch for --base-branch with managed worktrees", () => {
    const result = buildSpawnEnvironment({
      defaultPersonalWorkspace: false,
      newEnvironmentKind: "worktree",
      hostId: HOST_ID,
      baseBranch: "release-1.2",
    });
    expect(result).toEqual({
      type: "host",
      hostId: HOST_ID,
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "release-1.2" },
      },
    });
  });

  it("throws for --new-environment worktree when host is null", () => {
    expect(() =>
      buildSpawnEnvironment({
        defaultPersonalWorkspace: false,
        newEnvironmentKind: "worktree",
        hostId: null,
      }),
    ).toThrow("Cannot reach local host daemon");
  });

  it("throws for unknown --new-environment kind", () => {
    expect(() =>
      buildSpawnEnvironment({
        defaultPersonalWorkspace: false,
        newEnvironmentKind: "docker",
        hostId: HOST_ID,
      }),
    ).toThrow("Unknown environment kind 'docker'");
  });

  it("throws when combining --environment with --new-environment", () => {
    expect(() =>
      buildSpawnEnvironment({
        defaultPersonalWorkspace: false,
        environmentValue: "some-env-id",
        newEnvironmentKind: "docker",
        hostId: HOST_ID,
      }),
    ).toThrow("Cannot combine --environment with --new-environment");
  });

  it("throws when --base-branch would otherwise be ignored", () => {
    expect(() =>
      buildSpawnEnvironment({
        defaultPersonalWorkspace: false,
        baseBranch: "main",
        hostId: HOST_ID,
      }),
    ).toThrow("--base-branch requires --new-environment worktree");
  });

  it("returns unmanaged host with path for path-like --environment", () => {
    const result = buildSpawnEnvironment({
      defaultPersonalWorkspace: false,
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
      defaultPersonalWorkspace: false,
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
      defaultPersonalWorkspace: false,
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
      defaultPersonalWorkspace: false,
      newEnvironmentKind: "  worktree  ",
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
});

describe("parseThreadWaitTimeoutSeconds", () => {
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
  it("throws for invalid tier", () => {
    expect(() => parseServiceTier("turbo")).toThrow("Invalid service tier");
  });
});

describe("parsePermissionMode", () => {
  it("throws for invalid mode", () => {
    expect(() => parsePermissionMode("readwrite")).toThrow(
      "Invalid permission mode 'readwrite'. Expected accept-edits, auto, or full.",
    );
  });

  it("does not widen legacy readonly mode", () => {
    expect(() => parsePermissionMode("readonly")).toThrow(
      "Invalid permission mode 'readonly'. Expected accept-edits, auto, or full.",
    );
  });
});
