import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listWorkspaceOpenTargetsWithRuntime,
  openWorkspaceInTargetWithRuntime,
  type WorkspaceOpenTargetRuntime,
} from "./workspace-open-targets.js";

type ExecFileHandler = WorkspaceOpenTargetRuntime["execFile"];

interface ExecFileCall {
  args: string[];
  file: string;
}

interface CreateRuntimeArgs {
  applicationDirectories?: string[];
  execFile?: ExecFileHandler;
  platform?: NodeJS.Platform;
}

function createRuntime(args: CreateRuntimeArgs = {}): WorkspaceOpenTargetRuntime {
  return {
    applicationDirectories: args.applicationDirectories ?? [],
    execFile: args.execFile ?? (async () => ({ stdout: "" })),
    platform: args.platform ?? "darwin",
  };
}

describe("workspace open targets", () => {
  it("returns no targets on unsupported platforms without probing apps", async () => {
    const execFile = vi.fn(async () => ({ stdout: "" }));

    await expect(
      listWorkspaceOpenTargetsWithRuntime(createRuntime({
        execFile,
        platform: "linux",
      })),
    ).resolves.toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("discovers built-in targets and bundle-id matches", async () => {
    const calls: ExecFileCall[] = [];
    const execFile: ExecFileHandler = async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: args.join(" ").includes("dev.zed.Zed")
          ? "/Applications/Zed.app\n"
          : "",
      };
    };

    const targets = await listWorkspaceOpenTargetsWithRuntime(createRuntime({
      execFile,
    }));

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
    const root = await mkdtemp(path.join(tmpdir(), "bb-workspace-open-targets-"));
    const applicationsDirectory = path.join(root, "Applications");
    await mkdir(path.join(applicationsDirectory, "Cursor.app"), { recursive: true });

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(createRuntime({
        applicationDirectories: [applicationsDirectory],
      }));

      expect(targets.map((target) => target.id)).toContain("cursor");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens the workspace with an argument separator before the path", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: ExecFileCall[] = [];
    const execFile: ExecFileHandler = async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: file === "mdfind" && args.join(" ").includes("dev.zed.Zed")
          ? "/Applications/Zed.app\n"
          : "",
      };
    };

    try {
      await openWorkspaceInTargetWithRuntime(
        {
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

  it("rejects missing workspace directories", async () => {
    await expect(
      openWorkspaceInTargetWithRuntime(
        {
          path: path.join(tmpdir(), "bb-missing-workspace"),
          targetId: "zed",
        },
        createRuntime(),
      ),
    ).rejects.toMatchObject({
      code: "path_not_directory",
    });
  });

  it("rejects unavailable targets", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));

    try {
      await expect(
        openWorkspaceInTargetWithRuntime(
          {
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
        openWorkspaceInTargetWithRuntime(
          {
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
