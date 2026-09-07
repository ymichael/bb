import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceOpenTargetRuntime,
  listWorkspaceOpenTargetsWithRuntime,
  openPathInTargetWithRuntime,
  type WorkspaceOpenTargetRuntime,
} from "../src/index.js";

describe("default workspace open-target runtime", () => {
  it("exposes the resolved shell PATH without changing system-tool launches", async () => {
    const runtime = createWorkspaceOpenTargetRuntime({
      shellPath: "/Users/test/.local/bin:/usr/bin",
    });

    expect(runtime.env?.PATH).toBe("/Users/test/.local/bin:/usr/bin");
    const inheritedResult = await runtime.execFile(process.execPath, [
      "-e",
      "process.stdout.write(process.env.PATH ?? '')",
    ]);
    expect(inheritedResult.stdout).toBe(process.env.PATH ?? "");

    const userExecutableResult = await runtime.execFile(
      process.execPath,
      ["-e", "process.stdout.write(process.env.PATH ?? '')"],
      { env: runtime.env },
    );
    expect(userExecutableResult.stdout).toBe("/Users/test/.local/bin:/usr/bin");
  });
});

type ExecFileHandler = WorkspaceOpenTargetRuntime["execFile"];

interface ExecFileCall {
  args: string[];
  env?: NodeJS.ProcessEnv;
  file: string;
}

interface AvailableMacApplication {
  appPath: string;
  bundleId: string;
  displayName?: string;
}

interface CreateAvailableExecFileArgs {
  availableMacApplications?: AvailableMacApplication[];
  availableBundleIdSubstrings?: string[];
  availableExecutables?: string[];
  calls?: ExecFileCall[];
  fileAssociatedMacApplications?: AvailableMacApplication[];
}

interface CreateRuntimeArgs {
  applicationDirectories?: string[];
  desktopFileDirectories?: string[];
  env?: NodeJS.ProcessEnv;
  execFile?: ExecFileHandler;
  platform?: NodeJS.Platform;
}

function createRuntime(
  args: CreateRuntimeArgs = {},
): WorkspaceOpenTargetRuntime {
  return {
    applicationDirectories: args.applicationDirectories ?? [],
    desktopFileDirectories: args.desktopFileDirectories ?? [],
    execFile:
      args.execFile ??
      (async (file) => {
        if (file === "which") {
          throw new Error("Executable not found");
        }
        return { stdout: "" };
      }),
    env: args.env,
    platform: args.platform ?? "darwin",
  };
}

function createAvailableExecFile(
  args: CreateAvailableExecFileArgs = {},
): ExecFileHandler {
  const availableBundleIdSubstrings = args.availableBundleIdSubstrings ?? [];
  const availableMacApplications: AvailableMacApplication[] = [
    ...(args.availableMacApplications ?? []),
    ...availableBundleIdSubstrings.map((bundleId) => ({
      appPath: `/Applications/${bundleId}.app`,
      bundleId,
    })),
  ];
  const availableExecutables = args.availableExecutables ?? [];
  const fileAssociatedMacApplications =
    args.fileAssociatedMacApplications ?? [];

  return async (file, commandArgs, options) => {
    const call: ExecFileCall = { file, args: commandArgs };
    if (options?.env !== undefined) {
      call.env = options.env;
    }
    args.calls?.push(call);

    if (file === "mdfind") {
      if (commandArgs.join(" ").includes("kMDItemContentType")) {
        return {
          stdout: `${availableMacApplications
            .map((application) => application.appPath)
            .join("\n")}\n`,
        };
      }
      return {
        stdout:
          availableMacApplications
            .filter((application) =>
              commandArgs.join(" ").includes(application.bundleId),
            )
            .map((application) => application.appPath)
            .join("\n") || "",
      };
    }

    if (file === "plutil") {
      const key = commandArgs[1];
      const plistPath = commandArgs.at(-1) ?? "";
      const application = availableMacApplications.find((candidate) =>
        plistPath.startsWith(path.join(candidate.appPath, "Contents")),
      );
      if (!application) {
        return { stdout: "" };
      }
      if (key === "CFBundleIdentifier") {
        return { stdout: `${application.bundleId}\n` };
      }
      if (key === "CFBundleDisplayName" || key === "CFBundleName") {
        return {
          stdout: `${application.displayName ?? path.basename(application.appPath, ".app")}\n`,
        };
      }
      return { stdout: "" };
    }

    if (file === "osascript" && commandArgs.includes("JavaScript")) {
      return {
        stdout: JSON.stringify(
          fileAssociatedMacApplications.map((application) => ({
            appPath: application.appPath,
            bundleId: application.bundleId,
          })),
        ),
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
          platform: "freebsd",
        }),
      ),
    ).resolves.toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("discovers Linux platform targets and editor CLIs from PATH", async () => {
    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableExecutables: ["code", "xdg-open", "x-terminal-emulator"],
        }),
        platform: "linux",
      }),
    );

    expect(targets.map((target) => target.id)).toEqual([
      "vscode",
      "default-app",
      "file-manager",
      "terminal",
    ]);
    expect(targets.find((target) => target.id === "vscode")).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
      kind: "editor",
      label: "VS Code",
    });
    expect(
      targets.find((target) => target.id === "file-manager"),
    ).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: false,
        openFileAtLine: false,
      },
      kind: "file-manager",
      label: "File Manager",
    });
  });

  it("discovers Linux desktop apps outside app-specific adapters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-desktop-apps-"));
    const desktopDirectory = path.join(root, "applications");
    await mkdir(desktopDirectory, { recursive: true });
    await writeFile(
      path.join(desktopDirectory, "mockedit.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Mock Edit",
        "Categories=Utility;TextEditor;",
        "Exec=mockedit --open %f",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(desktopDirectory, "hidden.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Hidden App",
        "NoDisplay=true",
        "Categories=TextEditor;",
        "Exec=hidden %f",
        "",
      ].join("\n"),
    );
    await Promise.all(
      [
        ["files", "Files", "FileManager"],
        ["terminal", "Terminal", "TerminalEmulator"],
      ].map(async ([id, name, category]) =>
        writeFile(
          path.join(desktopDirectory, `${id}.desktop`),
          [
            "[Desktop Entry]",
            "Type=Application",
            `Name=${name}`,
            `Categories=System;${category};`,
            `Exec=${id} %f`,
            "",
          ].join("\n"),
        ),
      ),
    );
    await writeFile(
      path.join(desktopDirectory, "unrelated.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Music Player",
        "Categories=AudioVideo;Player;",
        "MimeType=audio/mpeg;inode/directory;",
        "Exec=music-player %f",
        "",
      ].join("\n"),
    );

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          desktopFileDirectories: [desktopDirectory],
          platform: "linux",
        }),
      );

      expect(targets).toEqual(
        [
          ["desktop-app:files", "Files"],
          ["desktop-app:mockedit", "Mock Edit"],
          ["desktop-app:terminal", "Terminal"],
        ].map(([id, label]) => ({
          capabilities: {
            openDirectory: true,
            openFile: true,
            openFileAtColumn: false,
            openFileAtLine: false,
          },
          icon: { kind: "symbol", name: "app" },
          id,
          kind: "native-app",
          label,
        })),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers WSL default app and file manager integrations", async () => {
    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        execFile: createAvailableExecFile({
          availableExecutables: ["explorer.exe", "wslview"],
        }),
        platform: "linux",
      }),
    );

    expect(targets.map((target) => target.id)).toEqual([
      "default-app",
      "file-manager",
    ]);
    expect(targets.find((target) => target.id === "default-app")).toMatchObject(
      {
        label: "Default App",
        kind: "default-app",
      },
    );
    expect(
      targets.find((target) => target.id === "file-manager"),
    ).toMatchObject({
      label: "File Manager",
      kind: "file-manager",
    });
  });

  it("returns no targets for unsupported win32 runtime", async () => {
    const execFile = vi.fn(async () => ({ stdout: "" }));

    await expect(
      listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          execFile,
          platform: "win32",
        }),
      ),
    ).resolves.toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("opens WSL paths with the configured default app bridge", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["wslview"],
      calls,
    });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "default-app",
        },
        createRuntime({
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          execFile,
          platform: "linux",
        }),
      );

      expect(calls.find((call) => call.file === "wslview")).toEqual({
        file: "wslview",
        args: [filePath],
        env: { WSL_DISTRO_NAME: "Ubuntu" },
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens WSL paths with the file manager bridge through the Linux runtime", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["explorer.exe"],
      calls,
    });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "file-manager",
        },
        createRuntime({
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          execFile,
          platform: "linux",
        }),
      );

      expect(calls.find((call) => call.file === "explorer.exe")).toEqual({
        file: "explorer.exe",
        args: [path.dirname(filePath)],
        env: { WSL_DISTRO_NAME: "Ubuntu" },
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("rejects unsupported non-Linux open requests", async () => {
    await expect(
      openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: "/tmp/workspace",
          targetId: "default-app",
        },
        createRuntime({ platform: "win32" }),
      ),
    ).rejects.toMatchObject({
      code: "unsupported_platform",
    });
  });

  it("opens Linux files with discovered editor CLIs", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["code"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "vscode",
        },
        createRuntime({
          env: { PATH: "/Users/test/.local/bin:/usr/bin" },
          execFile,
          platform: "linux",
        }),
      );

      expect(calls.find((call) => call.file === "code")).toEqual({
        file: "code",
        args: ["-g", `${filePath}:15:6`],
        env: { PATH: "/Users/test/.local/bin:/usr/bin" },
      });
      expect(
        calls.find((call) => call.file === "which" && call.args[0] === "code")
          ?.env,
      ).toEqual({ PATH: "/Users/test/.local/bin:/usr/bin" });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens Linux desktop app targets from desktop Exec entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-desktop-open-"));
    const desktopDirectory = path.join(root, "applications");
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(desktopDirectory, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(filePath, "# Notes\n");
      await writeFile(
        path.join(desktopDirectory, "mockedit.desktop"),
        [
          "[Desktop Entry]",
          "Type=Application",
          "Name=Mock Edit",
          "Categories=TextEditor;",
          "Exec=mockedit --open %f",
          "",
        ].join("\n"),
      );

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "desktop-app:mockedit",
        },
        createRuntime({
          desktopFileDirectories: [desktopDirectory],
          execFile,
          platform: "linux",
        }),
      );

      expect(calls.find((call) => call.file === "mockedit")).toEqual({
        file: "mockedit",
        args: ["--open", filePath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens Linux paths with the platform default app", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["xdg-open"],
      calls,
    });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "default-app",
        },
        createRuntime({ execFile, platform: "linux" }),
      );

      expect(calls.find((call) => call.file === "xdg-open")).toEqual({
        file: "xdg-open",
        args: [filePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens remote SSH paths in a Linux terminal", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["ssh", "x-terminal-emulator"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: 8,
        lineNumber: 42,
        path: "/home/me/project/src/file.ts",
        targetId: "terminal",
      },
      createRuntime({ execFile, platform: "linux" }),
    );

    const terminalCall = calls.find(
      (call) => call.file === "x-terminal-emulator",
    );
    expect(terminalCall).toBeDefined();
    expect(terminalCall?.args.slice(0, 5)).toEqual([
      "-e",
      "ssh",
      "-t",
      "--",
      "devbox",
    ]);
    expect(terminalCall?.args.at(-1)).toContain("/home/me/project/src/file.ts");
    expect(terminalCall?.args.at(-1)).toContain("42");
    expect(terminalCall?.args.at(-1)).toContain("8");
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
      "default-app",
    ]);
    expect(targets.find((target) => target.id === "default-app")).toEqual({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: false,
        openFileAtLine: false,
      },
      icon: { kind: "symbol", name: "default-app" },
      id: "default-app",
      kind: "default-app",
      label: "Default App",
    });
    expect(targets.find((target) => target.id === "terminal")).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
      id: "terminal",
      label: "Terminal",
    });
    expect(targets.find((target) => target.id === "finder")).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: false,
        openFileAtLine: false,
      },
      id: "finder",
      label: "Finder",
    });
    expect(
      calls.some((call) => call.args.join(" ").includes("com.apple.finder")),
    ).toBe(false);
    expect(
      calls.some((call) => call.args.join(" ").includes("com.apple.Terminal")),
    ).toBe(false);
  });

  it("opens paths with the macOS default app", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 3,
          lineNumber: 12,
          path: filePath,
          targetId: "default-app",
        },
        createRuntime({
          env: { PATH: "/Users/test/.local/bin:/usr/bin" },
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["--", filePath],
      });
      expect(calls.some((call) => call.file === "which")).toBe(false);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("reveals files in Finder", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["open"],
      calls,
    });

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "finder",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-R", filePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens BBEdit and Emacs through macOS application open instead of editor CLIs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const applicationsDirectory = path.join(root, "Applications");
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.join(applicationsDirectory, "BBEdit.app"), {
        recursive: true,
      });
      await mkdir(path.join(applicationsDirectory, "Emacs.app"), {
        recursive: true,
      });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(filePath, "# Notes\n");

      for (const target of [
        { appName: "BBEdit", cli: "bbedit", targetId: "bbedit" },
        { appName: "Emacs", cli: "emacsclient", targetId: "emacs" },
      ]) {
        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: 6,
            lineNumber: 15,
            path: filePath,
            targetId: target.targetId,
          },
          createRuntime({
            applicationDirectories: [applicationsDirectory],
            execFile,
          }),
        );

        expect(calls.some((call) => call.file === target.cli)).toBe(false);
        expect(
          calls.find(
            (call) => call.file === "open" && call.args[1] === target.appName,
          ),
        ).toEqual({
          file: "open",
          args: ["-a", target.appName, "--", filePath],
        });
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens TextMate locations through txmt URLs with column support", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const applicationsDirectory = path.join(root, "Applications");
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["open"],
      calls,
    });

    try {
      await mkdir(path.join(applicationsDirectory, "TextMate.app"), {
        recursive: true,
      });
      await mkdir(workspacePath, { recursive: true });
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "textmate",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.some((call) => call.file === "mate")).toBe(false);
      const openCall = calls.find(
        (call) => call.file === "open" && call.args[1] === "TextMate",
      );
      expect(openCall?.args.slice(0, 2)).toEqual(["-a", "TextMate"]);
      const textMateUri = new URL(openCall?.args[2] ?? "");
      expect(textMateUri.protocol).toBe("txmt:");
      expect(textMateUri.searchParams.get("url")).toBe(
        pathToFileURL(filePath).toString(),
      );
      expect(textMateUri.searchParams.get("line")).toBe("15");
      expect(textMateUri.searchParams.get("column")).toBe("6");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("advertises and uses column support for IntelliJ IDEA", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-intellij-idea-"));
    const applicationsDirectory = path.join(root, "Applications");
    const intellijAppPath = path.join(
      applicationsDirectory,
      "IntelliJ IDEA.app",
    );
    const intellijExecutable = path.join(
      intellijAppPath,
      "Contents",
      "MacOS",
      "idea",
    );
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.dirname(intellijExecutable), { recursive: true });
      await writeFile(intellijExecutable, "");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(
        targets.find((target) => target.id === "intellij-idea"),
      ).toMatchObject({
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
        label: "IntelliJ IDEA",
      });

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "intellij-idea",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === intellijExecutable)).toEqual({
        file: intellijExecutable,
        args: ["--line", "15", "--column", "6", filePath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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

  it("uses Cursor's bundled macOS CLI when the shell command is unavailable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    const cursorAppPath = path.join(applicationsDirectory, "Cursor.app");
    const cursorExecutable = path.join(
      cursorAppPath,
      "Contents",
      "MacOS",
      "Cursor",
    );
    const cursorCli = path.join(
      cursorAppPath,
      "Contents",
      "Resources",
      "app",
      "out",
      "cli.js",
    );
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.dirname(cursorExecutable), { recursive: true });
      await mkdir(path.dirname(cursorCli), { recursive: true });
      await writeFile(cursorExecutable, "");
      await writeFile(cursorCli, "");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "cursor",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          env: {
            NODE_OPTIONS: "--inspect",
            NODE_REPL_EXTERNAL_MODULE: "repl-module",
          },
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === cursorExecutable)).toEqual({
        file: cursorExecutable,
        args: [cursorCli, "-g", `${filePath}:15:6`],
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: "1",
          VSCODE_NODE_OPTIONS: "--inspect",
          VSCODE_NODE_REPL_EXTERNAL_MODULE: "repl-module",
        }),
      });
      expect(
        calls.find((call) => call.file === cursorExecutable)?.env,
      ).not.toHaveProperty("NODE_OPTIONS");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses bundled macOS editor CLIs when shell commands are unavailable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });
    const cases = [
      {
        appName: "Code",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: ["Contents", "Resources", "app", "bin", "code"],
        targetId: "vscode",
      },
      {
        appName: "Code - Insiders",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: ["Contents", "Resources", "app", "bin", "code"],
        targetId: "vscode-insiders",
      },
      {
        appName: "Windsurf",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: [
          "Contents",
          "Resources",
          "app",
          "bin",
          "windsurf",
        ],
        targetId: "devin-desktop",
      },
      {
        appName: "Devin",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: [
          "Contents",
          "Resources",
          "app",
          "bin",
          "devin-desktop",
        ],
        targetId: "devin-desktop",
      },
      {
        appName: "Antigravity",
        args: ["-g", `${filePath}:15:6`],
        relativeExecutablePath: [
          "Contents",
          "Resources",
          "app",
          "bin",
          "antigravity",
        ],
        targetId: "antigravity",
      },
      {
        appName: "Zed Nightly",
        args: [`${filePath}:15:6`],
        relativeExecutablePath: ["Contents", "MacOS", "zed"],
        targetId: "zed",
      },
      {
        appName: "Sublime Text",
        args: [`${filePath}:15:6`],
        relativeExecutablePath: ["Contents", "SharedSupport", "bin", "subl"],
        targetId: "sublime-text",
      },
    ];

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");
      for (const testCase of cases) {
        const executablePath = path.join(
          applicationsDirectory,
          `${testCase.appName}.app`,
          ...testCase.relativeExecutablePath,
        );
        await mkdir(path.dirname(executablePath), { recursive: true });
        await writeFile(executablePath, "");

        await openPathInTargetWithRuntime(
          {
            context: { kind: "local" },
            columnNumber: 6,
            lineNumber: 15,
            path: filePath,
            targetId: testCase.targetId,
          },
          createRuntime({
            applicationDirectories: [applicationsDirectory],
            execFile,
          }),
        );

        expect(calls.find((call) => call.file === executablePath)).toEqual({
          file: executablePath,
          args: testCase.args,
        });
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses bundled VS Code CLI for remote SSH opens when the shell command is unavailable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    const codeExecutable = path.join(
      applicationsDirectory,
      "Code.app",
      "Contents",
      "Resources",
      "app",
      "bin",
      "code",
    );
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["ssh"],
      calls,
    });

    try {
      await mkdir(path.dirname(codeExecutable), { recursive: true });
      await writeFile(codeExecutable, "");

      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );
      expect(targets.find((target) => target.id === "vscode")).toMatchObject({
        remoteSshCapabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
      });

      await openPathInTargetWithRuntime(
        {
          context: {
            kind: "remote-ssh",
            sshAuthority: "mbp-intel",
          },
          columnNumber: 2,
          lineNumber: 10,
          path: "/repo/src/file.ts",
          targetId: "vscode",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === codeExecutable)).toEqual({
        file: codeExecutable,
        args: [
          "--remote",
          "ssh-remote+mbp-intel",
          "-g",
          "/repo/src/file.ts:10:2",
        ],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers Warp from the macOS application bundle", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    await mkdir(path.join(applicationsDirectory, "Warp.app"), {
      recursive: true,
    });

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          applicationDirectories: [applicationsDirectory],
        }),
      );

      expect(targets.find((target) => target.id === "warp")).toMatchObject({
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: false,
          openFileAtLine: false,
        },
        icon: { kind: "builtin", name: "warp" },
        kind: "terminal",
        label: "Warp",
      });
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

  it("discovers Devin Desktop with its current bundle id", async () => {
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.exafunction.windsurf"],
    });

    const targets = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile,
      }),
    );

    expect(
      targets.find((target) => target.id === "devin-desktop"),
    ).toMatchObject({
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
      icon: { kind: "builtin", name: "devin-desktop" },
      kind: "editor",
      label: "Devin Desktop",
    });
  });

  it("discovers generic macOS apps from file-specific LaunchServices results", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const mockEditPath = "/Applications/MockEdit.app";
    const zedPath = "/Applications/Zed.app";
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      if (file === "mdfind") {
        const query = commandArgs.join(" ");
        if (query.includes("kMDItemContentType")) {
          return { stdout: `${mockEditPath}\n${zedPath}\n` };
        }
        if (query.includes("dev.zed.Zed")) {
          return { stdout: `${zedPath}\n` };
        }
        return { stdout: "" };
      }
      if (file === "osascript" && commandArgs.includes("JavaScript")) {
        return {
          stdout: JSON.stringify([
            { appPath: mockEditPath, bundleId: "com.example.MockEdit" },
            { appPath: zedPath, bundleId: "dev.zed.Zed" },
          ]),
        };
      }
      if (file === "plutil") {
        const key = commandArgs[1];
        const plistPath = commandArgs.at(-1) ?? "";
        if (plistPath.includes("MockEdit.app")) {
          if (key === "CFBundleIdentifier") {
            return { stdout: "com.example.MockEdit\n" };
          }
          if (key === "CFBundleDisplayName") {
            return { stdout: "Mock Edit\n" };
          }
          return { stdout: "" };
        }
        if (plistPath.includes("Zed.app")) {
          if (key === "CFBundleIdentifier") {
            return { stdout: "dev.zed.Zed\n" };
          }
          if (key === "CFBundleDisplayName") {
            return { stdout: "Zed\n" };
          }
        }
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      await writeFile(filePath, "# Notes\n");

      const globalTargets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
      );
      expect(globalTargets.find((target) => target.id === "zed")).toBeDefined();
      expect(
        globalTargets.find(
          (target) => target.id === "mac-app:com.example.MockEdit",
        ),
      ).toBeUndefined();

      const fileTargets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
        { path: filePath },
      );

      expect(fileTargets.find((target) => target.id === "zed")).toBeDefined();
      expect(
        fileTargets.find((target) => target.id === "mac-app:dev.zed.Zed"),
      ).toBeUndefined();
      expect(
        fileTargets.find(
          (target) => target.id === "mac-app:com.example.MockEdit",
        ),
      ).toMatchObject({
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: false,
          openFileAtLine: false,
        },
        icon: { kind: "symbol", name: "app" },
        kind: "native-app",
        label: "Mock Edit",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens generic macOS app targets by bundle id", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "notes.md");
    const calls: ExecFileCall[] = [];
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      calls.push({ file, args: commandArgs });
      if (file === "mdfind") {
        return commandArgs.join(" ").includes("com.example.MockEdit")
          ? { stdout: "/Applications/MockEdit.app\n" }
          : { stdout: "" };
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      await writeFile(filePath, "# Notes\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "mac-app:com.example.MockEdit",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-b", "com.example.MockEdit", "--", filePath],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("uses app-provided icons for discovered targets without built-in icons", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-open-target-icon-"));
    const appPath = path.join(root, "WebStorm.app");
    const calls: ExecFileCall[] = [];
    await mkdir(appPath, { recursive: true });
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      calls.push({ file, args: commandArgs });
      if (file === "mdfind") {
        if (commandArgs.join(" ").includes("kMDItemContentType")) {
          return { stdout: `${appPath}\n` };
        }
        return {
          stdout: commandArgs.join(" ").includes("com.jetbrains.WebStorm")
            ? `${appPath}\n`
            : "",
        };
      }
      if (file === "plutil") {
        const key = commandArgs[1];
        if (key === "CFBundleIdentifier") {
          return { stdout: "com.jetbrains.WebStorm\n" };
        }
        if (key === "CFBundleDisplayName" || key === "CFBundleName") {
          return { stdout: "WebStorm\n" };
        }
        if (key === "CFBundleIconFile") {
          return { stdout: "webstorm\n" };
        }
        return { stdout: "" };
      }
      if (file === "qlmanage") {
        const outputDir = commandArgs[commandArgs.indexOf("-o") + 1];
        const inputPath = commandArgs.at(-1);
        if (outputDir && inputPath) {
          await writeFile(
            path.join(outputDir, `${path.basename(inputPath)}.png`),
            "fake-png",
          );
        }
        return { stdout: "" };
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
      );

      expect(targets.find((target) => target.id === "webstorm")).toMatchObject({
        icon: {
          kind: "data-url",
          dataUrl: "data:image/png;base64,ZmFrZS1wbmc=",
        },
        label: "WebStorm",
      });
      expect(calls.some((call) => call.file === "qlmanage")).toBe(true);
      expect(calls.find((call) => call.file === "qlmanage")?.args).toEqual(
        expect.arrayContaining(["-t", "-s", "32"]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("prefers app-provided icons for discovered known app targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-open-target-icon-"));
    const appPath = path.join(root, "Visual Studio Code.app");
    const calls: ExecFileCall[] = [];
    await mkdir(appPath, { recursive: true });
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      calls.push({ file, args: commandArgs });
      if (file === "mdfind") {
        if (commandArgs.join(" ").includes("kMDItemContentType")) {
          return { stdout: `${appPath}\n` };
        }
        return {
          stdout: commandArgs.join(" ").includes("com.microsoft.VSCode")
            ? `${appPath}\n`
            : "",
        };
      }
      if (file === "plutil") {
        const key = commandArgs[1];
        if (key === "CFBundleIdentifier") {
          return { stdout: "com.microsoft.VSCode\n" };
        }
        if (key === "CFBundleDisplayName" || key === "CFBundleName") {
          return { stdout: "Code\n" };
        }
        if (key === "CFBundleIconFile") {
          return { stdout: "Code\n" };
        }
        return { stdout: "" };
      }
      if (file === "qlmanage") {
        const outputDir = commandArgs[commandArgs.indexOf("-o") + 1];
        const inputPath = commandArgs.at(-1);
        if (outputDir && inputPath) {
          await writeFile(
            path.join(outputDir, `${path.basename(inputPath)}.png`),
            "vscode-png",
          );
        }
        return { stdout: "" };
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
      );

      expect(targets.find((target) => target.id === "vscode")).toMatchObject({
        icon: {
          kind: "data-url",
          dataUrl: "data:image/png;base64,dnNjb2RlLXBuZw==",
        },
        label: "VS Code",
      });
      expect(calls.some((call) => call.file === "qlmanage")).toBe(true);
      expect(calls.find((call) => call.file === "qlmanage")?.args).toEqual(
        expect.arrayContaining(["-t", "-s", "32"]),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discovers and opens JetBrains Toolbox applications through bundled executables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-jetbrains-toolbox-"));
    const homeDirectory = path.join(root, "home");
    const webStormAppPath = path.join(
      homeDirectory,
      "Library",
      "Application Support",
      "JetBrains",
      "Toolbox",
      "apps",
      "WebStorm",
      "ch-0",
      "241.1",
      "WebStorm.app",
    );
    const webStormExecutable = path.join(
      webStormAppPath,
      "Contents",
      "MacOS",
      "webstorm",
    );
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.dirname(webStormExecutable), { recursive: true });
      await writeFile(webStormExecutable, "");
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({
          env: { HOME: homeDirectory },
          execFile,
        }),
      );
      expect(targets.find((target) => target.id === "webstorm")).toMatchObject({
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
        label: "WebStorm",
      });

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "webstorm",
        },
        createRuntime({
          env: { HOME: homeDirectory },
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === webStormExecutable)).toEqual({
        file: webStormExecutable,
        args: ["--line", "15", "--column", "6", filePath],
        env: { HOME: homeDirectory },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("falls back when app-provided icons exceed the contract size limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-open-target-icon-"));
    const appPath = path.join(root, "Visual Studio Code.app");
    await mkdir(appPath, { recursive: true });
    const execFile: ExecFileHandler = async (file, commandArgs) => {
      if (file === "mdfind") {
        return commandArgs.join(" ").includes("com.microsoft.VSCode")
          ? { stdout: `${appPath}\n` }
          : { stdout: "" };
      }
      if (file === "plutil") {
        const key = commandArgs[1];
        if (key === "CFBundleIdentifier") {
          return { stdout: "com.microsoft.VSCode\n" };
        }
        if (key === "CFBundleDisplayName" || key === "CFBundleName") {
          return { stdout: "Code\n" };
        }
        if (key === "CFBundleIconFile") {
          return { stdout: "Code\n" };
        }
        return { stdout: "" };
      }
      if (file === "qlmanage") {
        const outputDir = commandArgs[commandArgs.indexOf("-o") + 1];
        const inputPath = commandArgs.at(-1);
        if (outputDir && inputPath) {
          await writeFile(
            path.join(outputDir, `${path.basename(inputPath)}.png`),
            "x".repeat(200_000),
          );
        }
        return { stdout: "" };
      }
      if (file === "which") {
        throw new Error("Executable not found");
      }
      return { stdout: "" };
    };

    try {
      const targets = await listWorkspaceOpenTargetsWithRuntime(
        createRuntime({ execFile }),
      );

      expect(targets.find((target) => target.id === "vscode")).toMatchObject({
        icon: { kind: "builtin", name: "vscode" },
        label: "VS Code",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens Xcode files through xed with the enclosing project container", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bb-xcode-open-"));
    const applicationsDirectory = path.join(root, "Applications");
    const xcodeAppPath = path.join(applicationsDirectory, "Xcode.app");
    const xedPath = path.join(
      xcodeAppPath,
      "Contents",
      "Developer",
      "usr",
      "bin",
      "xed",
    );
    const workspacePath = path.join(root, "workspace");
    const xcodeWorkspacePath = path.join(workspacePath, "App.xcworkspace");
    const filePath = path.join(workspacePath, "Sources", "App", "File.swift");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(path.dirname(xedPath), { recursive: true });
      await writeFile(xedPath, "");
      await mkdir(xcodeWorkspacePath, { recursive: true });
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "let value = 1\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "xcode",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === xedPath)).toEqual({
        file: xedPath,
        args: ["--project", xcodeWorkspacePath, "--line", "22", filePath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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
          context: { kind: "local" },
          columnNumber: null,
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

  it("uses the VS Code CLI for workspace opens when available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.microsoft.VSCode"],
      availableExecutables: ["code"],
      calls,
    });

    try {
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "vscode",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "code")).toEqual({
        file: "code",
        args: [workspacePath],
      });
      expect(calls.some((call) => call.file === "open")).toBe(false);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("advertises VS Code remote SSH support only when the CLI is available", async () => {
    const withCli = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableBundleIdSubstrings: ["com.microsoft.VSCode"],
          availableExecutables: ["code"],
        }),
      }),
    );
    expect(withCli.find((target) => target.id === "vscode")).toMatchObject({
      remoteSshCapabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtLine: true,
      },
    });

    const withoutCli = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableBundleIdSubstrings: ["com.microsoft.VSCode"],
        }),
      }),
    );
    expect(
      withoutCli.find((target) => target.id === "vscode")
        ?.remoteSshCapabilities,
    ).toBeUndefined();
  });

  it("advertises terminal remote SSH support only when osascript and ssh are available", async () => {
    const withLauncher = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableExecutables: ["osascript", "ssh"],
        }),
      }),
    );
    expect(
      withLauncher.find((target) => target.id === "terminal"),
    ).toMatchObject({
      remoteSshCapabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtLine: true,
      },
    });

    const withoutLauncher = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile(),
      }),
    );
    expect(
      withoutLauncher.find((target) => target.id === "terminal")
        ?.remoteSshCapabilities,
    ).toBeUndefined();

    const withoutSsh = await listWorkspaceOpenTargetsWithRuntime(
      createRuntime({
        execFile: createAvailableExecFile({
          availableExecutables: ["osascript"],
        }),
      }),
    );
    expect(
      withoutSsh.find((target) => target.id === "terminal")
        ?.remoteSshCapabilities,
    ).toBeUndefined();
  });

  it("opens remote SSH paths with VS Code without local path checks", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.microsoft.VSCode"],
      availableExecutables: ["code"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: 9,
        lineNumber: 42,
        path: "/home/me/missing-on-client.ts",
        targetId: "vscode",
      },
      createRuntime({ execFile }),
    );

    expect(calls.find((call) => call.file === "code")).toEqual({
      file: "code",
      args: [
        "--remote",
        "ssh-remote+devbox",
        "-g",
        "/home/me/missing-on-client.ts:42:9",
      ],
    });
  });

  it("opens remote SSH paths in Terminal with a remote editor script", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["osascript", "ssh"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: 8,
        lineNumber: 42,
        path: "/home/me/project/src/file.ts",
        targetId: "terminal",
      },
      createRuntime({ execFile }),
    );

    const osascriptCall = calls.find((call) => call.file === "osascript");
    expect(osascriptCall).toBeDefined();
    const script = osascriptCall?.args.join("\n") ?? "";
    expect(script).toContain('tell application "Terminal" to do script');
    expect(script).toContain("ssh");
    expect(script).toContain("devbox");
    expect(script).toContain("/home/me/project/src/file.ts");
    expect(script).toContain("line=");
    expect(script).toContain("42");
    expect(script).toContain("column=");
    expect(script).toContain("8");
    expect(script).toContain("VISUAL");
    expect(script).toContain("EDITOR");
  });

  it("opens remote SSH paths in Ghostty by passing ssh args to the app", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.mitchellh.ghostty"],
      availableExecutables: ["open", "ssh"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: null,
        lineNumber: null,
        path: "/home/me/project",
        targetId: "ghostty",
      },
      createRuntime({ execFile }),
    );

    expect(calls.find((call) => call.file === "open")).toEqual({
      file: "open",
      args: [
        "-na",
        "Ghostty",
        "--args",
        "-e",
        "ssh",
        "-t",
        "--",
        "devbox",
        expect.stringContaining("/home/me/project"),
      ],
    });
  });

  it("opens remote SSH paths in Zed with SSH URIs", async () => {
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["dev.zed.Zed"],
      availableExecutables: ["zed"],
      calls,
    });

    await openPathInTargetWithRuntime(
      {
        context: {
          kind: "remote-ssh",
          sshAuthority: "devbox",
        },
        columnNumber: 3,
        lineNumber: 7,
        path: "/home/me/project/src/file with spaces.ts",
        targetId: "zed",
      },
      createRuntime({ execFile }),
    );

    expect(calls.find((call) => call.file === "zed")).toEqual({
      file: "zed",
      args: ["ssh://devbox/home/me/project/src/file%20with%20spaces.ts:7:3"],
    });
  });

  it("rejects remote SSH opens for targets without remote support", async () => {
    await expect(
      openPathInTargetWithRuntime(
        {
          context: {
            kind: "remote-ssh",
            sshAuthority: "devbox",
          },
          columnNumber: null,
          lineNumber: null,
          path: "/home/me/project",
          targetId: "sublime-text",
        },
        createRuntime({
          execFile: createAvailableExecFile({
            availableBundleIdSubstrings: ["com.sublimetext.4"],
          }),
        }),
      ),
    ).rejects.toMatchObject({
      code: "remote_target_unsupported",
    });
  });

  it("rejects missing paths", async () => {
    await expect(
      openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
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

  it("opens local directories in Terminal with a short cd command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "terminal",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain('tell application "Terminal" to do script');
      expect(script).toContain(`cd '${workspacePath}'`);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local directories in iTerm2 with a short cd command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.googlecode.iterm2"],
      calls,
    });

    try {
      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: workspacePath,
          targetId: "iterm2",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain(
        'tell application "iTerm" to create window with default profile',
      );
      expect(script).toContain(
        'tell application "iTerm" to tell current session of current window to write text',
      );
      expect(script).toContain(`cd '${workspacePath}'`);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in Terminal with a resolved terminal editor command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableExecutables: ["vim"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "terminal",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain('tell application "Terminal" to do script');
      expect(script).toContain(
        `cd '${path.dirname(filePath)}' && 'vim' '+call cursor(22,4)' '${filePath}'`,
      );
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in iTerm2 with a resolved terminal editor command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "README.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.googlecode.iterm2"],
      availableExecutables: ["vim"],
      calls,
    });

    try {
      await writeFile(filePath, "# Test\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: null,
          lineNumber: null,
          path: filePath,
          targetId: "iterm2",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain(
        'tell application "iTerm" to create window with default profile',
      );
      expect(script).toContain(
        'tell application "iTerm" to tell current session of current window to write text',
      );
      expect(script).toContain(`cd '${workspacePath}' && 'vim' '${filePath}'`);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("inserts terminal editor location args before explicit editor args separator", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "terminal",
        },
        createRuntime({
          env: { VISUAL: "vim --clean --" },
          execFile,
        }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain(
        `cd '${path.dirname(filePath)}' && 'vim' '--clean' '+call cursor(22,4)' '--' '${filePath}'`,
      );
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in Terminal at the containing directory when no terminal editor is available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "README.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await writeFile(filePath, "# Test\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "terminal",
        },
        createRuntime({ execFile }),
      );

      const osascriptCall = calls.find((call) => call.file === "osascript");
      expect(osascriptCall).toBeDefined();
      const script = osascriptCall?.args.join("\n") ?? "";
      expect(script).toContain('tell application "Terminal" to do script');
      expect(script).toContain(`cd '${workspacePath}'`);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in Warp at the containing directory", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "bb-workspace-open-targets-"),
    );
    const applicationsDirectory = path.join(root, "Applications");
    await mkdir(path.join(applicationsDirectory, "Warp.app"), {
      recursive: true,
    });
    const workspacePath = path.join(root, "workspace");
    const filePath = path.join(workspacePath, "README.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({ calls });

    try {
      await mkdir(workspacePath, { recursive: true });
      await writeFile(filePath, "# Test\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "warp",
        },
        createRuntime({
          applicationDirectories: [applicationsDirectory],
          execFile,
        }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-a", "Warp", workspacePath],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("opens local files in Ghostty with a resolved terminal editor command", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.mitchellh.ghostty"],
      availableExecutables: ["vim"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "ghostty",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: [
          "-na",
          "Ghostty.app",
          "--args",
          "-e",
          "/bin/zsh",
          "-lc",
          `cd '${path.dirname(filePath)}' && 'vim' '+call cursor(22,4)' '${filePath}'`,
        ],
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("opens local files in Ghostty at the containing directory when no terminal editor is available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "README.md");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.mitchellh.ghostty"],
      calls,
    });

    try {
      await writeFile(filePath, "# Test\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 4,
          lineNumber: 22,
          path: filePath,
          targetId: "ghostty",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "open")).toEqual({
        file: "open",
        args: ["-a", "Ghostty", workspacePath],
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
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "cursor",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "cursor")).toEqual({
        file: "cursor",
        args: ["-g", `${filePath}:15:6`],
      });
      expect(calls.some((call) => call.file === "open")).toBe(false);
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });

  it("uses Devin Desktop line and column direct-editor commands when available", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "bb-workspace-"));
    const filePath = path.join(workspacePath, "src", "file.ts");
    const calls: ExecFileCall[] = [];
    const execFile = createAvailableExecFile({
      availableBundleIdSubstrings: ["com.exafunction.windsurf"],
      availableExecutables: ["devin-desktop"],
      calls,
    });

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "export const value = 1;\n");

      await openPathInTargetWithRuntime(
        {
          context: { kind: "local" },
          columnNumber: 6,
          lineNumber: 15,
          path: filePath,
          targetId: "devin-desktop",
        },
        createRuntime({ execFile }),
      );

      expect(calls.find((call) => call.file === "devin-desktop")).toEqual({
        file: "devin-desktop",
        args: ["-g", `${filePath}:15:6`],
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
          context: { kind: "local" },
          columnNumber: 6,
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
            context: { kind: "local" },
            columnNumber: null,
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
            context: { kind: "local" },
            columnNumber: null,
            lineNumber: null,
            path: workspacePath,
            targetId: "vscode",
          },
          createRuntime({ platform: "freebsd" }),
        ),
      ).rejects.toMatchObject({
        code: "unsupported_platform",
      });
    } finally {
      await rm(workspacePath, { force: true, recursive: true });
    }
  });
});
