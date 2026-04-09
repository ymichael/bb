import { readFile } from "node:fs/promises";
import { accessSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxDaemonArtifacts } from "./types.js";

interface LocalSandboxDaemonArtifact {
  label: string;
  localPath: string;
}

function resolveSandboxHostPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function resolveWorkspaceRoot(): string {
  let currentPath = resolveSandboxHostPackageRoot();

  for (;;) {
    const workspaceManifestPath = resolve(currentPath, "pnpm-workspace.yaml");
    try {
      accessSync(workspaceManifestPath);
      return currentPath;
    } catch {
      const parentPath = resolve(currentPath, "..");
      if (parentPath === currentPath) {
        throw new Error(
          `Unable to locate pnpm-workspace.yaml from ${resolveSandboxHostPackageRoot()}`,
        );
      }
      currentPath = parentPath;
    }
  }
}

function resolveHostDaemonDistPath(fileName: string): string {
  return resolve(resolveWorkspaceRoot(), "apps", "host-daemon", "dist", fileName);
}

function resolveClaudeCodeCliPath(): string {
  return resolve(
    resolveWorkspaceRoot(),
    "packages",
    "agent-runtime",
    "node_modules",
    "@anthropic-ai",
    "claude-agent-sdk",
    "cli.js",
  );
}

function resolvePiPackageManifestPath(): string {
  return resolve(
    resolveWorkspaceRoot(),
    "packages",
    "agent-runtime",
    "node_modules",
    "@mariozechner",
    "pi-coding-agent",
    "package.json",
  );
}

let sandboxDaemonArtifactsPromise: Promise<SandboxDaemonArtifacts> | null = null;

async function readBundleArtifact(
  artifact: LocalSandboxDaemonArtifact,
): Promise<string> {
  try {
    return await readFile(artifact.localPath, "utf8");
  } catch {
    throw new Error(
      `Missing ${artifact.label} bundle at ${artifact.localPath}. Run pnpm exec turbo run bundle --filter=@bb/host-daemon before provisioning sandbox hosts.`,
    );
  }
}

export async function loadSandboxDaemonArtifacts(): Promise<SandboxDaemonArtifacts> {
  if (!sandboxDaemonArtifactsPromise) {
    sandboxDaemonArtifactsPromise = Promise.all([
      readBundleArtifact({
        label: "bb cli",
        localPath: resolveHostDaemonDistPath("bb"),
      }),
      readBundleArtifact({
        label: "claude-code cli",
        localPath: resolveClaudeCodeCliPath(),
      }),
      readBundleArtifact({
        label: "daemon",
        localPath: resolveHostDaemonDistPath("daemon-bundle.mjs"),
      }),
      readBundleArtifact({
        label: "claude-code bridge",
        localPath: resolveHostDaemonDistPath("bb-claude-code-bridge.mjs"),
      }),
      readBundleArtifact({
        label: "pi bridge",
        localPath: resolveHostDaemonDistPath("bb-pi-bridge.mjs"),
      }),
      readBundleArtifact({
        label: "pi package manifest",
        localPath: resolvePiPackageManifestPath(),
      }),
    ])
      .then(([
        bbCli,
        claudeCodeCli,
        daemon,
        claudeCodeBridge,
        piBridge,
        piPackageManifest,
      ]) => ({
        bbCli,
        claudeCodeCli,
        claudeCodeBridge,
        daemon,
        piPackageManifest,
        piBridge,
      }))
      .catch((error: unknown) => {
        sandboxDaemonArtifactsPromise = null;
        throw error;
      });
  }

  return sandboxDaemonArtifactsPromise;
}
