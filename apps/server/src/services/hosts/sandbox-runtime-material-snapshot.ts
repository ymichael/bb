import { createHash } from "node:crypto";
import type { HostRuntimeMaterialSnapshot } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps, ServerRuntimeConfig } from "../../types.js";

type SandboxRuntimeMaterialConfig = Pick<
  ServerRuntimeConfig,
  "anthropicApiKey" | "githubPat" | "openAiApiKey"
>;

const snapshotCache = new WeakMap<
  SandboxRuntimeMaterialConfig,
  HostRuntimeMaterialSnapshot
>();

function buildManagedRuntimeEnv(
  config: SandboxRuntimeMaterialConfig,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (config.githubPat !== "") {
    env.GITHUB_TOKEN = config.githubPat;
  }
  if (config.openAiApiKey !== "") {
    env.OPENAI_API_KEY = config.openAiApiKey;
  }
  if (config.anthropicApiKey !== "") {
    env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }

  return env;
}

function toStableEnvEntries(
  env: Record<string, string>,
): Array<readonly [string, string]> {
  return Object.entries(env).sort(([left], [right]) => left.localeCompare(right));
}

function buildSnapshotVersion(env: Record<string, string>): string {
  const stableEntries = JSON.stringify(toStableEnvEntries(env));
  return createHash("sha256").update(stableEntries).digest("hex");
}

export function buildSandboxRuntimeMaterialSnapshot(
  config: SandboxRuntimeMaterialConfig,
): HostRuntimeMaterialSnapshot {
  const cached = snapshotCache.get(config);
  if (cached) {
    return cached;
  }

  const env = buildManagedRuntimeEnv(config);
  const snapshot = {
    env,
    version: buildSnapshotVersion(env),
  };
  snapshotCache.set(config, snapshot);
  return snapshot;
}

export function isEmptySandboxRuntimeMaterialSnapshot(
  snapshot: HostRuntimeMaterialSnapshot,
): boolean {
  return Object.keys(snapshot.env).length === 0;
}

export function readSandboxRuntimeMaterialSnapshotForVersion(
  deps: Pick<AppDeps, "config">,
  args: { version: string },
): HostRuntimeMaterialSnapshot {
  const desiredSnapshot = buildSandboxRuntimeMaterialSnapshot(deps.config);
  if (desiredSnapshot.version !== args.version) {
    throw new ApiError(
      409,
      "stale_runtime_material_version",
      "Requested runtime material version is no longer current",
    );
  }
  return desiredSnapshot;
}
