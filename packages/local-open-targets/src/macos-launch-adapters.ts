import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  BASIC_FILE_OPEN_CAPABILITIES,
  FILE_MANAGER_OPEN_CAPABILITIES,
  FULL_FILE_OPEN_CAPABILITIES,
  LINE_ONLY_FILE_OPEN_CAPABILITIES,
  TERMINAL_OPEN_CAPABILITIES,
} from "./capabilities.js";
import {
  buildMacGhosttyLocalOpenArgs,
  buildMacGhosttyRemoteSshOpenArgs,
  buildMacTerminalAppLocalOpenArgs,
  buildMacTerminalLocalOpenArgs,
  buildMacTerminalRemoteSshOpenArgs,
} from "./terminal.js";
import type {
  MacBundledExecutableAdapter,
  BuildMacLineOpenArgs,
  BuildMacRemoteSshOpenArgs,
  LaunchAdapter,
  MacCommandExecutableAdapter,
} from "./types.js";

const CURSOR_CLI_JS_RELATIVE_PATH = [
  "Contents",
  "Resources",
  "app",
  "out",
  "cli.js",
];

function formatPathWithLineNumber(args: BuildMacLineOpenArgs): string {
  return args.columnNumber === null
    ? `${args.path}:${args.lineNumber}`
    : `${args.path}:${args.lineNumber}:${args.columnNumber}`;
}

function formatJetBrainsLineOpenArgs(args: BuildMacLineOpenArgs): string[] {
  return [
    "--line",
    String(args.lineNumber),
    ...(args.columnNumber === null
      ? []
      : ["--column", String(args.columnNumber)]),
    args.path,
  ];
}

function formatZedRemoteSshUri(args: BuildMacRemoteSshOpenArgs): string {
  const absolutePath = args.path.startsWith("/") ? args.path : `/${args.path}`;
  const encodedPath = absolutePath.split("/").map(encodeURIComponent).join("/");
  const uri = `ssh://${args.sshAuthority}${encodedPath}`;
  if (args.lineNumber === null) {
    return uri;
  }
  return args.columnNumber === null
    ? `${uri}:${args.lineNumber}`
    : `${uri}:${args.lineNumber}:${args.columnNumber}`;
}

function formatTextMateOpenUri(args: BuildMacLineOpenArgs): string {
  const uri = new URL("txmt://open/");
  uri.searchParams.set("url", pathToFileURL(args.path).toString());
  uri.searchParams.set("line", String(args.lineNumber));
  if (args.columnNumber !== null) {
    uri.searchParams.set("column", String(args.columnNumber));
  }
  return uri.toString();
}

function buildCursorCliEnv(
  env: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const cursorEnv: NodeJS.ProcessEnv = { ...(env ?? process.env) };
  cursorEnv.VSCODE_NODE_OPTIONS = cursorEnv.NODE_OPTIONS;
  cursorEnv.VSCODE_NODE_REPL_EXTERNAL_MODULE =
    cursorEnv.NODE_REPL_EXTERNAL_MODULE;
  delete cursorEnv.NODE_OPTIONS;
  delete cursorEnv.NODE_REPL_EXTERNAL_MODULE;
  cursorEnv.ELECTRON_RUN_AS_NODE = "1";
  return cursorEnv;
}

const CURSOR_BUNDLED_EXECUTABLE: MacBundledExecutableAdapter = {
  relativeExecutablePath: ["Contents", "MacOS", "Cursor"],
  requiredRelativePaths: [CURSOR_CLI_JS_RELATIVE_PATH],
  toArgsPrefix: (appPath) => [
    path.join(appPath, ...CURSOR_CLI_JS_RELATIVE_PATH),
  ],
  toEnv: buildCursorCliEnv,
};

function jetBrainsBundledExecutable(
  executable: string,
): MacBundledExecutableAdapter {
  return bundledExecutable("Contents", "MacOS", executable);
}

function bundledExecutable(
  ...relativeExecutablePath: string[]
): MacBundledExecutableAdapter {
  return {
    relativeExecutablePath,
  };
}

const LEGACY_WINDSURF_EXECUTABLE: MacCommandExecutableAdapter = {
  bundledExecutable: bundledExecutable(
    "Contents",
    "Resources",
    "app",
    "bin",
    "windsurf",
  ),
  executable: "windsurf",
};

function jetBrainsToolbox(
  executable: string,
  ...bundlePrefixes: string[]
): { bundlePrefixes: string[]; executable: string } {
  return { bundlePrefixes, executable };
}

export const LAUNCH_ADAPTERS: LaunchAdapter[] = [
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "vscode" },
    id: "vscode",
    kind: "editor",
    label: "VS Code",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Visual Studio Code",
      additionalAppNames: ["Code"],
      bundleIds: ["com.microsoft.VSCode"],
      builtIn: false,
      lineOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "code",
        ),
        executable: "code",
        supportsColumn: true,
        toArgs: (args) => ["-g", formatPathWithLineNumber(args)],
      },
      pathOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "code",
        ),
        executable: "code",
        toArgs: (path) => [path],
      },
      remoteSshOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "code",
        ),
        capabilities: FULL_FILE_OPEN_CAPABILITIES,
        executable: "code",
        toArgs: (args) => [
          "--remote",
          `ssh-remote+${args.sshAuthority}`,
          ...(args.lineNumber === null
            ? [args.path]
            : [
                "-g",
                formatPathWithLineNumber({
                  lineNumber: args.lineNumber,
                  columnNumber: args.columnNumber,
                  path: args.path,
                }),
              ]),
        ],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "vscode-insiders" },
    id: "vscode-insiders",
    kind: "editor",
    label: "VS Code Insiders",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Visual Studio Code - Insiders",
      additionalAppNames: ["Code - Insiders"],
      bundleIds: ["com.microsoft.VSCodeInsiders"],
      builtIn: false,
      lineOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "code",
        ),
        executable: "code-insiders",
        supportsColumn: true,
        toArgs: (args) => ["-g", formatPathWithLineNumber(args)],
      },
      pathOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "code",
        ),
        executable: "code-insiders",
        toArgs: (path) => [path],
      },
      remoteSshOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "code",
        ),
        capabilities: FULL_FILE_OPEN_CAPABILITIES,
        executable: "code-insiders",
        toArgs: (args) => [
          "--remote",
          `ssh-remote+${args.sshAuthority}`,
          ...(args.lineNumber === null
            ? [args.path]
            : [
                "-g",
                formatPathWithLineNumber({
                  lineNumber: args.lineNumber,
                  columnNumber: args.columnNumber,
                  path: args.path,
                }),
              ]),
        ],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "cursor" },
    id: "cursor",
    kind: "editor",
    label: "Cursor",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Cursor",
      bundleIds: ["com.todesktop.230313mzl4w4u92"],
      builtIn: false,
      lineOpenCommand: {
        bundledExecutable: CURSOR_BUNDLED_EXECUTABLE,
        executable: "cursor",
        supportsColumn: true,
        toArgs: (args) => ["-g", formatPathWithLineNumber(args)],
      },
      pathOpenCommand: {
        bundledExecutable: CURSOR_BUNDLED_EXECUTABLE,
        executable: "cursor",
        toArgs: (path) => [path],
      },
      remoteSshOpenCommand: {
        bundledExecutable: CURSOR_BUNDLED_EXECUTABLE,
        capabilities: FULL_FILE_OPEN_CAPABILITIES,
        executable: "cursor",
        toArgs: (args) => [
          "--remote",
          `ssh-remote+${args.sshAuthority}`,
          ...(args.lineNumber === null
            ? [args.path]
            : [
                "-g",
                formatPathWithLineNumber({
                  lineNumber: args.lineNumber,
                  columnNumber: args.columnNumber,
                  path: args.path,
                }),
              ]),
        ],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "sublime-text" },
    id: "sublime-text",
    kind: "editor",
    label: "Sublime Text",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Sublime Text",
      bundleIds: ["com.sublimetext.4", "com.sublimetext.3"],
      builtIn: false,
      lineOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "SharedSupport",
          "bin",
          "subl",
        ),
        executable: "subl",
        supportsColumn: true,
        toArgs: (args) => [formatPathWithLineNumber(args)],
      },
      pathOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "SharedSupport",
          "bin",
          "subl",
        ),
        executable: "subl",
        toArgs: (path) => [path],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "zed" },
    id: "zed",
    kind: "editor",
    label: "Zed",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Zed",
      additionalAppNames: ["Zed Preview", "Zed Nightly"],
      bundleIds: ["dev.zed.Zed"],
      builtIn: false,
      lineOpenCommand: {
        bundledExecutable: bundledExecutable("Contents", "MacOS", "zed"),
        executable: "zed",
        supportsColumn: true,
        toArgs: (args) => [formatPathWithLineNumber(args)],
      },
      pathOpenCommand: {
        bundledExecutable: bundledExecutable("Contents", "MacOS", "zed"),
        executable: "zed",
        toArgs: (path) => [path],
      },
      remoteSshOpenCommand: {
        bundledExecutable: bundledExecutable("Contents", "MacOS", "zed"),
        capabilities: FULL_FILE_OPEN_CAPABILITIES,
        executable: "zed",
        toArgs: (args) => [formatZedRemoteSshUri(args)],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "devin-desktop" },
    id: "devin-desktop",
    kind: "editor",
    label: "Devin Desktop",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      additionalAppNames: ["Windsurf"],
      appName: "Devin",
      bundleIds: ["com.exafunction.windsurf"],
      builtIn: false,
      lineOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "devin-desktop",
        ),
        executable: "devin-desktop",
        fallbackExecutables: [LEGACY_WINDSURF_EXECUTABLE],
        supportsColumn: true,
        toArgs: (args) => ["-g", formatPathWithLineNumber(args)],
      },
      pathOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "devin-desktop",
        ),
        executable: "devin-desktop",
        fallbackExecutables: [LEGACY_WINDSURF_EXECUTABLE],
        toArgs: (path) => [path],
      },
      remoteSshOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "devin-desktop",
        ),
        capabilities: FULL_FILE_OPEN_CAPABILITIES,
        executable: "devin-desktop",
        fallbackExecutables: [LEGACY_WINDSURF_EXECUTABLE],
        toArgs: (args) => [
          "--remote",
          `ssh-remote+${args.sshAuthority}`,
          ...(args.lineNumber === null
            ? [args.path]
            : [
                "-g",
                formatPathWithLineNumber({
                  lineNumber: args.lineNumber,
                  columnNumber: args.columnNumber,
                  path: args.path,
                }),
              ]),
        ],
      },
    },
  },
  {
    capabilities: BASIC_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "bbedit" },
    id: "bbedit",
    kind: "editor",
    label: "BBEdit",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "BBEdit",
      bundleIds: ["com.barebones.bbedit"],
      builtIn: false,
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "textmate" },
    id: "textmate",
    kind: "editor",
    label: "TextMate",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "TextMate",
      bundleIds: ["com.macromates.TextMate"],
      builtIn: false,
      lineOpenCommand: {
        executable: "open",
        supportsColumn: true,
        toArgs: (args) => ["-a", "TextMate", formatTextMateOpenUri(args)],
      },
    },
  },
  {
    capabilities: BASIC_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "emacs" },
    id: "emacs",
    kind: "editor",
    label: "Emacs",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Emacs",
      bundleIds: ["org.gnu.Emacs"],
      builtIn: false,
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "intellij" },
    id: "intellij-idea",
    kind: "editor",
    label: "IntelliJ IDEA",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "IntelliJ IDEA",
      bundleIds: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"],
      builtIn: false,
      jetBrainsToolbox: jetBrainsToolbox("idea", "intellij idea"),
      lineOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("idea"),
        executable: "idea",
        supportsColumn: true,
        toArgs: formatJetBrainsLineOpenArgs,
      },
      pathOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("idea"),
        executable: "idea",
        toArgs: (path) => [path],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "pycharm" },
    id: "pycharm",
    kind: "editor",
    label: "PyCharm",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "PyCharm",
      bundleIds: ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"],
      builtIn: false,
      jetBrainsToolbox: jetBrainsToolbox("pycharm", "pycharm"),
      lineOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("pycharm"),
        executable: "pycharm",
        supportsColumn: true,
        toArgs: formatJetBrainsLineOpenArgs,
      },
      pathOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("pycharm"),
        executable: "pycharm",
        toArgs: (path) => [path],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "webstorm" },
    id: "webstorm",
    kind: "editor",
    label: "WebStorm",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "WebStorm",
      bundleIds: ["com.jetbrains.WebStorm"],
      builtIn: false,
      jetBrainsToolbox: jetBrainsToolbox("webstorm", "webstorm"),
      lineOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("webstorm"),
        executable: "webstorm",
        supportsColumn: true,
        toArgs: formatJetBrainsLineOpenArgs,
      },
      pathOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("webstorm"),
        executable: "webstorm",
        toArgs: (path) => [path],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "goland" },
    id: "goland",
    kind: "editor",
    label: "GoLand",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "GoLand",
      bundleIds: ["com.jetbrains.goland"],
      builtIn: false,
      jetBrainsToolbox: jetBrainsToolbox("goland", "goland"),
      lineOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("goland"),
        executable: "goland",
        supportsColumn: true,
        toArgs: formatJetBrainsLineOpenArgs,
      },
      pathOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("goland"),
        executable: "goland",
        toArgs: (path) => [path],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "rider" },
    id: "rider",
    kind: "editor",
    label: "Rider",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Rider",
      bundleIds: ["com.jetbrains.rider"],
      builtIn: false,
      jetBrainsToolbox: jetBrainsToolbox("rider", "rider"),
      lineOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("rider"),
        executable: "rider",
        supportsColumn: true,
        toArgs: formatJetBrainsLineOpenArgs,
      },
      pathOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("rider"),
        executable: "rider",
        toArgs: (path) => [path],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "rustrover" },
    id: "rustrover",
    kind: "editor",
    label: "RustRover",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "RustRover",
      bundleIds: ["com.jetbrains.rustrover"],
      builtIn: false,
      jetBrainsToolbox: jetBrainsToolbox("rustrover", "rustrover"),
      lineOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("rustrover"),
        executable: "rustrover",
        supportsColumn: true,
        toArgs: formatJetBrainsLineOpenArgs,
      },
      pathOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("rustrover"),
        executable: "rustrover",
        toArgs: (path) => [path],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "phpstorm" },
    id: "phpstorm",
    kind: "editor",
    label: "PhpStorm",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "PhpStorm",
      bundleIds: ["com.jetbrains.PhpStorm"],
      builtIn: false,
      jetBrainsToolbox: jetBrainsToolbox("phpstorm", "phpstorm"),
      lineOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("phpstorm"),
        executable: "phpstorm",
        supportsColumn: true,
        toArgs: formatJetBrainsLineOpenArgs,
      },
      pathOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("phpstorm"),
        executable: "phpstorm",
        toArgs: (path) => [path],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "android-studio" },
    id: "android-studio",
    kind: "editor",
    label: "Android Studio",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Android Studio",
      bundleIds: ["com.google.android.studio"],
      builtIn: false,
      jetBrainsToolbox: jetBrainsToolbox("studio", "android studio"),
      lineOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("studio"),
        executable: "studio",
        supportsColumn: true,
        toArgs: formatJetBrainsLineOpenArgs,
      },
      pathOpenCommand: {
        bundledExecutable: jetBrainsBundledExecutable("studio"),
        executable: "studio",
        toArgs: (path) => [path],
      },
    },
  },
  {
    capabilities: FULL_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "antigravity" },
    id: "antigravity",
    kind: "editor",
    label: "Antigravity",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Antigravity",
      bundleIds: ["com.google.antigravity", "com.googlelabs.antigravity"],
      builtIn: false,
      lineOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "antigravity",
        ),
        executable: "antigravity",
        supportsColumn: true,
        toArgs: (args) => ["-g", formatPathWithLineNumber(args)],
      },
      pathOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "antigravity",
        ),
        executable: "antigravity",
        toArgs: (path) => [path],
      },
      remoteSshOpenCommand: {
        bundledExecutable: bundledExecutable(
          "Contents",
          "Resources",
          "app",
          "bin",
          "antigravity",
        ),
        capabilities: FULL_FILE_OPEN_CAPABILITIES,
        executable: "antigravity",
        toArgs: (args) => [
          "--remote",
          `ssh-remote+${args.sshAuthority}`,
          ...(args.lineNumber === null
            ? [args.path]
            : [
                "-g",
                formatPathWithLineNumber({
                  lineNumber: args.lineNumber,
                  columnNumber: args.columnNumber,
                  path: args.path,
                }),
              ]),
        ],
      },
    },
  },
  {
    capabilities: LINE_ONLY_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "xcode" },
    id: "xcode",
    kind: "editor",
    label: "Xcode",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Xcode",
      bundleIds: ["com.apple.dt.Xcode"],
      builtIn: false,
      lineOpenCommand: {
        executable: "xed",
        supportsColumn: false,
        toArgs: (args) => ["-l", String(args.lineNumber), args.path],
      },
    },
  },
  {
    capabilities: FILE_MANAGER_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "finder" },
    id: "finder",
    kind: "file-manager",
    label: "Finder",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "application",
      appName: "Finder",
      bundleIds: ["com.apple.finder"],
      builtIn: true,
      fileOpenCommand: {
        executable: "open",
        toArgs: (path) => ["-R", path],
      },
    },
  },
  {
    capabilities: TERMINAL_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "terminal" },
    id: "terminal",
    kind: "terminal",
    label: "Terminal",
    fileOpenBehavior: "containing-directory",
    macos: {
      openMode: "application",
      appName: "Terminal",
      bundleIds: ["com.apple.Terminal"],
      builtIn: true,
      localTerminalOpenCommand: {
        executable: "osascript",
        toArgs: (args) =>
          buildMacTerminalLocalOpenArgs({
            appName: "Terminal",
            columnNumber: args.columnNumber,
            editorCommand: args.editorCommand,
            lineNumber: args.lineNumber,
            path: args.path,
            pathType: args.pathType,
            shellPath: args.shellPath,
          }),
      },
      remoteSshOpenCommand: {
        capabilities: TERMINAL_OPEN_CAPABILITIES,
        executable: "osascript",
        requiredExecutables: ["ssh"],
        toArgs: (args) =>
          buildMacTerminalRemoteSshOpenArgs({
            appName: "Terminal",
            columnNumber: args.columnNumber,
            lineNumber: args.lineNumber,
            path: args.path,
            sshAuthority: args.sshAuthority,
          }),
      },
    },
  },
  {
    capabilities: TERMINAL_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "iterm2" },
    id: "iterm2",
    kind: "terminal",
    label: "iTerm2",
    fileOpenBehavior: "containing-directory",
    macos: {
      openMode: "application",
      appName: "iTerm",
      bundleIds: ["com.googlecode.iterm2"],
      builtIn: false,
      localTerminalOpenCommand: {
        executable: "osascript",
        toArgs: (args) =>
          buildMacTerminalLocalOpenArgs({
            appName: "iTerm",
            columnNumber: args.columnNumber,
            editorCommand: args.editorCommand,
            lineNumber: args.lineNumber,
            path: args.path,
            pathType: args.pathType,
            shellPath: args.shellPath,
          }),
      },
      remoteSshOpenCommand: {
        capabilities: TERMINAL_OPEN_CAPABILITIES,
        executable: "osascript",
        requiredExecutables: ["ssh"],
        toArgs: (args) =>
          buildMacTerminalRemoteSshOpenArgs({
            appName: "iTerm",
            columnNumber: args.columnNumber,
            lineNumber: args.lineNumber,
            path: args.path,
            sshAuthority: args.sshAuthority,
          }),
      },
    },
  },
  {
    capabilities: TERMINAL_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "ghostty" },
    id: "ghostty",
    kind: "terminal",
    label: "Ghostty",
    fileOpenBehavior: "containing-directory",
    macos: {
      openMode: "application",
      appName: "Ghostty",
      bundleIds: ["com.mitchellh.ghostty"],
      builtIn: false,
      localTerminalOpenCommand: {
        executable: "open",
        toArgs: (args) =>
          buildMacGhosttyLocalOpenArgs({
            columnNumber: args.columnNumber,
            editorCommand: args.editorCommand,
            lineNumber: args.lineNumber,
            path: args.path,
            pathType: args.pathType,
            shellPath: args.shellPath,
          }),
      },
      remoteSshOpenCommand: {
        capabilities: TERMINAL_OPEN_CAPABILITIES,
        executable: "open",
        requiredExecutables: ["ssh"],
        toArgs: (args) =>
          buildMacGhosttyRemoteSshOpenArgs({
            columnNumber: args.columnNumber,
            lineNumber: args.lineNumber,
            path: args.path,
            sshAuthority: args.sshAuthority,
          }),
      },
    },
  },
  {
    capabilities: BASIC_FILE_OPEN_CAPABILITIES,
    icon: { kind: "builtin", name: "warp" },
    id: "warp",
    kind: "terminal",
    label: "Warp",
    fileOpenBehavior: "containing-directory",
    macos: {
      openMode: "application",
      appName: "Warp",
      bundleIds: ["dev.warp.Warp", "dev.warp.Warp-Stable"],
      builtIn: false,
      localTerminalOpenCommand: {
        executable: "open",
        toArgs: (args) =>
          buildMacTerminalAppLocalOpenArgs({
            appName: "Warp",
            columnNumber: args.columnNumber,
            lineNumber: args.lineNumber,
            path: args.path,
            pathType: args.pathType,
          }),
      },
    },
  },
  {
    capabilities: BASIC_FILE_OPEN_CAPABILITIES,
    icon: { kind: "symbol", name: "default-app" },
    id: "default-app",
    kind: "default-app",
    label: "Default App",
    fileOpenBehavior: "direct",
    macos: {
      openMode: "default-app",
    },
  },
];
