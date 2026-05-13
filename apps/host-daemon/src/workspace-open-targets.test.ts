import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listWorkspaceOpenTargetsWithRuntime,
  openPathInTargetWithRuntime,
  type WorkspaceOpenTargetRuntime,
} from "./workspace-open-targets.js";

type ExecFileHandler = WorkspaceOpenTargetRuntime["execFile"];

interface ExecFileCall {
  args: string[];
  file: string;
}

interface CreateAvailableExecFileArgs {
  availableBundleIdSubstrings?: string[];
  availableExecutables?: string[];
  calls?: ExecFileCall[];
}

interface CreateRuntimeArgs {
  applicationDirectories?: string[];
  execFile?: ExecFileHandler;
  platform?: NodeJS.Platform;
}

function createRuntime(
  args: CreateRuntimeArgs = {},
): WorkspaceOpenTargetRuntime {
  return {
    applicationDirectories: args.applicationDirectories ?? [],
    execFile: args.execFile ?? (async () => ({ stdout: "" })),
    platform: args.platform ?? "darwin",
  };
}

function createAvailableExecFile(
  args: CreateAvailableExecFileArgs = {},
): ExecFileHandler {
  const availableBundleIdSubstrings = args.availableBundleIdSubstrings ?? [];
  const availableExecutables = args.availableExecutables ?? [];

  return async (file, commandArgs) => {
    args.calls?.push({ file, args: commandArgs });

    if (file === "mdfind") {
      return {
        stdout: availableBundleIdSubstrings.some((bundleId) =>
          commandArgs.join(" ").includes(bundleId),
        )
          ? "/Applications/Available.app\n"
          : "",
      };
    }

    if (file === "which") {
      const executable = commandArgs[0];
      if (executable && availableExecutables.includes(executable)) {
        return {
          stdout: `/usr/local/bin/${executable}\n`,
        };
      }
      throw new Error("Executable not found");
    }

    return { stdout: "" };
  };
}

describe("workspace open targets", () => {
  it("returns no targets on unsupported platforms without probing apps", async () => {
    const execFile = vi.fn(async () => ({ stdout: "" }));

    await expect(
      listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          execFile,
          platform: "linux",
        }),
      ),
    ).resolves.toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("discovers built-in targets and bundle-id matches", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["dev.zed.Zed"],
      calls,
    });

    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile,
      }),
    );

    expect(targets.map((target) => target.id)).toEqual([
      "zed",
      "finder",
      "terminal",
    ]);
    expect(
      calls.some((call) => call.args.join(" ").includes("com.apple.finder")),
    ).toBe(false);
    expect(
      calls.some((call) => call.args.join(" ").includes("com.apple.Terminal")),
    ).toBe(false);
  });

  it("falls back to application bundle paths when bundle id lookup misses", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    await mkdir(path.join(applicationsDirectory, "Cursor.app"), {
      recursive: true,
    });

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          applicationDirectories: [applicationsDirectory],
        }),
      );

      expect(targets.map((target) => target.id)).toContain("cursor");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers Antigravity with the current bundle id", async () => {
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.google.antigravity"],
    });

    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile,
      }),
    );

    expect(targets.map((target) => target.id)).toContain("antigravity");
  });

  it("opens the workspace with an argument separator before the path", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["dev.zed.Zed"],
      calls,
    });

    try {
      await openPathInTargetWithRuntime(
        {
          lineNumber: null,
          path: workspacePath,
          targetId: "zed",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-a", "Zed", "--", workspacePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("rejects missing paths", async () => {
    await expect(
      openPathInTargetWithRuntime(
        {
          lineNumber: null,
          path: path.join(tmpdir(), "bb-missing-workspace"),
          targetId: "zed",
        },
        createRuntime({
          execFile: createAvailableExecFile({
            availableBundleIdSubstrings: ["dev.zed.Zed"],
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "path_not_found",
    });
  });

  it("opens terminal targets at the containing directory for files", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          lineNumber: 22,
          path: filePath,
          targetId: "terminal",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-a", "Terminal", "--", path.dirname(filePath)],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("uses line-aware direct-editor commands when available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.todesktop.230313mzl4w4u92"],
      availableExecutables: ["cursor"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          lineNumber: 15,
          path: filePath,
          targetId: "cursor",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "cursor")).toEqual({
        file: "cursor",
        args: ["-g", `${filePath}:15`],
      });
      expect(calls.some((call) => call.file === "open")).toBe(false);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("falls back to regular app opens when a line-aware executable is unavailable", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.todesktop.230313mzl4w4u92"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          lineNumber: 15,
          path: filePath,
          targetId: "cursor",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-a", "Cursor", "--", filePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("rejects unavailable targets", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

    try {
      await expect(
        openPathInTargetWithRuntime(
          {
            lineNumber: null,
            path: workspacePath,
            targetId: "vscode",
          },
          createRuntime(),
        ),
      ).rejects.toMatchObject({
        code: "target_unavailable",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("rejects workspace opening on unsupported platforms", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

    try {
      await expect(
        openPathInTargetWithRuntime(
          {
            lineNumber: null,
            path: workspacePath,
            targetId: "vscode",
          },
          createRuntime({ platform: "linux" }),
        ),
      ).rejects.toMatchObject({
        code: "unsupported_platform",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });
});
