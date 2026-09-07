import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  createDesktopReleaseInfo,
  DESKTOP_AUTO_UPDATE_FEED_CONFIG,
} from "../src/desktop-update-provider.js";

const desktopPackageRoot = process.cwd();
const require = createRequire(resolve(desktopPackageRoot, "package.json"));
const nativeModulesScript: {
  parseStandaloneArguments(argv: string[]): {
    appOutDir: string | undefined;
    options: {
      arch: string;
      electronVersion?: string;
      platform: string;
    };
  };
  resolveBetterSqlite3PrebuildArguments(options: {
    arch: string;
    electronVersion: string;
    platform: string;
  }): string[];
} = require("./scripts/prepare-native-modules.cjs");

const macConfigSchema = z
  .object({
    entitlements: z.string().min(1),
    entitlementsInherit: z.string().min(1),
    gatekeeperAssess: z.literal(false),
    hardenedRuntime: z.literal(true),
    icon: z.string().min(1),
    identity: z.string().nullable().optional(),
    notarize: z.boolean(),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("dmg"),
        })
        .passthrough(),
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("zip"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const linuxConfigSchema = z
  .object({
    category: z.literal("Development"),
    executableName: z.enum(["bb", "bb-nightly"]),
    icon: z.string().min(1),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("x64")]),
          target: z.literal("AppImage"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const electronBuilderFileSetSchema = z
  .object({
    filter: z.array(z.string().min(1)),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .passthrough();

const electronBuilderFilePatternSchema = z.union([
  z.string().min(1),
  electronBuilderFileSetSchema,
]);

const electronBuilderConfigSchema = z
  .object({
    afterPack: z.string().min(1),
    asarUnpack: z.array(z.string().min(1)),
    dmg: z
      .object({
        sign: z.boolean(),
      })
      .passthrough(),
    files: z.array(electronBuilderFilePatternSchema),
    linux: linuxConfigSchema,
    mac: macConfigSchema,
    npmRebuild: z.literal(false),
    appId: z.string().min(1),
    artifactName: z.string().min(1),
    productName: z.string().min(1),
    publish: z.tuple([
      z
        .object({
          channel: z.enum(["latest", "nightly"]),
          provider: z.literal("generic"),
          url: z.string().min(1),
        })
        .passthrough(),
    ]),
    toolsets: z.object({
      appimage: z.literal("1.0.3"),
    }),
  })
  .passthrough();

const desktopPackageJsonSchema = z
  .object({
    main: z.literal("dist/main.js"),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    type: z.never().optional(),
  })
  .passthrough();

const workspacePackageJsonSchema = z
  .object({
    pnpm: z.object({
      supportedArchitectures: z.object({
        cpu: z.array(z.string().min(1)),
        os: z.array(z.string().min(1)),
      }),
    }),
  })
  .passthrough();

const signingEnvironmentKeys = [
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
  "CSC_NAME",
];
const audioInputEntitlementPattern =
  /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/u;

type ElectronBuilderConfig = z.infer<typeof electronBuilderConfigSchema>;
type EnvironmentOverrides = Record<string, string | undefined>;
type ScriptRunResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};
type ReadResolvedConfigResult = {
  config: ElectronBuilderConfig;
};
type CreateScriptEnvironment = (
  overrides: EnvironmentOverrides,
) => NodeJS.ProcessEnv;
type RunConfigScript = (
  overrides: EnvironmentOverrides,
) => Promise<ScriptRunResult>;
type ReadResolvedConfig = (
  overrides: EnvironmentOverrides,
) => Promise<ReadResolvedConfigResult>;
type RunNativePrepScript = (appOutDir: string) => Promise<ScriptRunResult>;

const createScriptEnvironment: CreateScriptEnvironment = (overrides) => {
  const env = { ...process.env };

  for (const key of signingEnvironmentKeys) {
    delete env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
};

const runConfigScript: RunConfigScript = async (overrides) => {
  const child = spawn(
    process.execPath,
    ["scripts/run-electron-builder.mjs", "--print-config"],
    {
      cwd: desktopPackageRoot,
      env: createScriptEnvironment(overrides),
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const runNativePrepScript: RunNativePrepScript = async (appOutDir) => {
  const child = spawn(
    process.execPath,
    ["scripts/prepare-native-modules.cjs", appOutDir],
    {
      cwd: desktopPackageRoot,
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const readResolvedConfig: ReadResolvedConfig = async (overrides) => {
  const result = await runConfigScript(overrides);

  expect(result.exitCode).toBe(0);
  return {
    config: electronBuilderConfigSchema.parse(JSON.parse(result.stdout)),
  };
};

describe("electron-builder signing config", () => {
  it("keeps package metadata compatible with electron universal's CJS entry asar", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.main).toBe("dist/main.js");
    expect(packageJson).not.toHaveProperty("type");
  });

  it("ships no plugin build toolchain binaries", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(Object.keys(packageJson.optionalDependencies ?? {})).not.toEqual(
      expect.arrayContaining(["@esbuild/darwin-arm64", "@esbuild/darwin-x64"]),
    );
  });

  it("unpacks the ESM bb-app bridge with an explicit module extension", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.asarUnpack).toContain("dist/bb-app-bridge.mjs");
    expect(config.asarUnpack).not.toContain("dist/bb-app-bridge.js");
  });

  it("runs a native module preparation hook after packaging", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const hookPath = "scripts/prepare-native-modules.cjs";

    expect(config.afterPack).toBe(hookPath);
    await expect(
      access(resolve(desktopPackageRoot, hookPath)),
    ).resolves.toBeUndefined();
  });

  it("passes the standalone platform through to better-sqlite3 prebuild-install", () => {
    const { options } = nativeModulesScript.parseStandaloneArguments([
      "/tmp/linux-unpacked",
      "--electron-version=41.7.0",
      "--arch=x64",
      "--platform=linux",
    ]);
    const electronVersion = options.electronVersion;
    if (electronVersion === undefined) {
      throw new Error("Expected the standalone Electron version argument");
    }

    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: options.arch,
        electronVersion,
        platform: options.platform,
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=41.7.0",
      "--arch=x64",
      "--platform=linux",
    ]);
  });

  it("preserves the macOS better-sqlite3 prebuild-install arguments", () => {
    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: "arm64",
        electronVersion: "41.7.0",
        platform: "darwin",
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=41.7.0",
      "--arch=arm64",
      "--platform=darwin",
    ]);
  });

  it("installs native plugin build packages for arm64 and x64", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "..", "..", "package.json"),
      "utf8",
    );
    const packageJson = workspacePackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.pnpm.supportedArchitectures).toEqual({
      cpu: ["arm64", "x64"],
      os: ["current"],
    });
  });

  it("disables in-place native rebuilds so the shared pnpm store is not mutated", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.npmRebuild).toBe(false);
  });

  it("excludes source maps from packaged app files", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.files).toContain("!**/*.map");
  });

  it("copies the app scaffold template as a dedicated file set", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.files).toContainEqual({
      filter: ["**/*"],
      from: "node_modules/bb-app/server/dist/app-scaffold-template",
      to: "node_modules/bb-app/server/dist/app-scaffold-template",
    });
  });

  it("patches packaged node-pty helper path handling", async () => {
    const appOutDir = await mkdtemp(
      resolve(tmpdir(), "bb-desktop-native-modules-"),
    );
    const nodePtyPackageDir = resolve(
      appOutDir,
      "bb.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
    );
    const rebuiltNativeDir = resolve(nodePtyPackageDir, "build", "Release");
    const unixTerminalPath = resolve(
      nodePtyPackageDir,
      "lib",
      "unixTerminal.js",
    );
    const helperPath = resolve(
      nodePtyPackageDir,
      "prebuilds",
      "darwin-arm64",
      "spawn-helper",
    );
    const rebuiltHelperPath = resolve(rebuiltNativeDir, "spawn-helper");

    try {
      await mkdir(rebuiltNativeDir, { recursive: true });
      await writeFile(resolve(rebuiltNativeDir, "pty.node"), "rebuilt");
      await writeFile(rebuiltHelperPath, "rebuilt-helper");
      await chmod(rebuiltHelperPath, 0o644);
      await mkdir(dirname(unixTerminalPath), { recursive: true });
      await writeFile(
        unixTerminalPath,
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      await mkdir(dirname(helperPath), { recursive: true });
      await writeFile(helperPath, "helper");
      await chmod(helperPath, 0o644);
      const result = await runNativePrepScript(appOutDir);

      expect(result.exitCode).toBe(0);
      await expect(
        access(resolve(rebuiltNativeDir, "pty.node")),
      ).resolves.toBeUndefined();
      await expect(readFile(unixTerminalPath, "utf8")).resolves.toContain(
        "helperPath.replace(/app\\.asar(?!\\.unpacked)/g, 'app.asar.unpacked')",
      );
      expect((await stat(helperPath)).mode & 0o777).toBe(0o755);
      expect((await stat(rebuiltHelperPath)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(appOutDir, { force: true, recursive: true });
    }
  });

  it("points mac signing entitlements at checked-in plist files", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(config.mac.entitlementsInherit).toBe(
      "build/entitlements.mac.inherit.plist",
    );

    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlements)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlementsInherit)),
    ).resolves.toBeUndefined();
  });

  it("packages macOS artifacts for arm64 only", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.target).toEqual([
      { arch: ["arm64"], target: "dmg" },
      { arch: ["arm64"], target: "zip" },
    ]);
  });

  it("packages a Linux AppImage for x64", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.linux).toMatchObject({
      category: "Development",
      executableName: "bb",
      target: [{ arch: ["x64"], target: "AppImage" }],
    });
    expect(config.toolsets.appimage).toBe("1.0.3");
    await expect(
      access(resolve(desktopPackageRoot, config.linux.icon)),
    ).resolves.toBeUndefined();
  });

  it("grants audio input to the signed app and helper processes", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const entitlementPaths = [
      config.mac.entitlements,
      config.mac.entitlementsInherit,
    ];

    for (const entitlementPath of entitlementPaths) {
      const entitlements = await readFile(
        resolve(desktopPackageRoot, entitlementPath),
        "utf8",
      );

      expect(entitlements).toMatch(audioInputEntitlementPattern);
    }
  });

  it("keeps the updater provider pointed at desktop-latest release assets", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.publish[0]).toMatchObject(DESKTOP_AUTO_UPDATE_FEED_CONFIG);
    expect(DESKTOP_AUTO_UPDATE_FEED_CONFIG.url).toBe(
      "https://github.com/get-bb/bb/releases/download/desktop-latest/",
    );
  });

  it("creates a separate nightly app identity and update feed", async () => {
    const { config } = await readResolvedConfig({
      BB_DESKTOP_RELEASE_CHANNEL: "nightly",
    });
    const nightlyRelease = createDesktopReleaseInfo("nightly");

    expect(config.appId).toBe("dev.bb.desktop.nightly");
    expect(config.productName).toBe("bb Nightly");
    expect(config.artifactName).toBe("bb-nightly-${version}-${arch}.${ext}");
    expect(config.linux.icon).toBe("assets/icon-nightly.png");
    expect(config.linux.executableName).toBe("bb-nightly");
    expect(config.mac.icon).toBe("assets/icon-nightly.icns");
    await expect(
      access(resolve(desktopPackageRoot, config.mac.icon)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, "assets/icon-nightly.png")),
    ).resolves.toBeUndefined();
    expect(config.publish[0]).toEqual({
      channel: "nightly",
      provider: "generic",
      url: nightlyRelease.updateReleaseBaseUrl,
    });
  });

  it("rejects unknown desktop release channels", async () => {
    const result = await runConfigScript({
      BB_DESKTOP_RELEASE_CHANNEL: "canary",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "BB_DESKTOP_RELEASE_CHANNEL must be latest or nightly",
    );
  });

  it("signs local builds via keychain auto-discovery when signing secrets are absent", async () => {
    const { config } = await readResolvedConfig({});

    expect(config.mac).not.toHaveProperty("identity");
    expect(config.mac.notarize).toBe(false);
    expect(config.dmg.sign).toBe(false);
  });

  it("keeps builds unsigned when keychain auto-discovery is explicitly disabled", async () => {
    const { config } = await readResolvedConfig({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });

    expect(config.mac.identity).toBeNull();
    expect(config.mac.notarize).toBe(false);
  });

  it("rejects partial signing secret sets", async () => {
    const partialAppleCredentials = await runConfigScript({
      APPLE_ID: "sawyer@example.com",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
    });

    expect(partialAppleCredentials.exitCode).toBe(1);
    expect(partialAppleCredentials.stderr).toContain(
      "Incomplete macOS signing/notarization environment.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Present: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Missing: APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.",
    );
  });

  it("enables app signing and notarization when signing and Apple credentials are complete", async () => {
    const completeAppleCredentials = await readResolvedConfig({
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_ID: "sawyer@example.com",
      APPLE_TEAM_ID: "TEAMID1234",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
      CSC_NAME: "Sawyer Hood (TEAMID1234)",
    });

    expect(completeAppleCredentials.config.mac.identity).toBe(
      "Sawyer Hood (TEAMID1234)",
    );
    expect(completeAppleCredentials.config.mac.notarize).toBe(true);
    expect(completeAppleCredentials.config.dmg.sign).toBe(false);
  });
});
