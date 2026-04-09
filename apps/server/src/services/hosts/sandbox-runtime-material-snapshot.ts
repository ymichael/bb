import { createHash } from "node:crypto";
import type { HostRuntimeMaterialSnapshot } from "@bb/host-daemon-contract";
import {
  buildCloudAuthRuntimeMaterial,
  type CloudAuthResolvedCredential,
} from "@bb/agent-provider-auth";
import { ApiError } from "../../errors.js";
import type { AppDeps, ServerRuntimeConfig } from "../../types.js";

type SandboxRuntimeMaterialConfig = Pick<
  ServerRuntimeConfig,
  "anthropicApiKey" | "githubPat" | "openAiApiKey"
>;

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

function toStableFiles(
  snapshot: Pick<HostRuntimeMaterialSnapshot, "files">,
) {
  return snapshot.files
    .map((file) => ({
      contents: file.contents,
      managedBy: file.managedBy,
      mode: file.mode,
      path: file.path,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildSnapshotVersion(snapshot: HostRuntimeMaterialSnapshot): string {
  const stablePayload = JSON.stringify({
    env: toStableEnvEntries(snapshot.env),
    files: toStableFiles(snapshot),
  });
  return createHash("sha256").update(stablePayload).digest("hex");
}

function isResolvedCloudAuthCredential(
  credential: CloudAuthResolvedCredential | null,
): credential is CloudAuthResolvedCredential {
  return credential !== null;
}

export async function buildSandboxRuntimeMaterialSnapshot(
  deps: Pick<AppDeps, "cloudAuth" | "config" | "sandboxEnv">,
): Promise<HostRuntimeMaterialSnapshot> {
  const baseEnv = buildManagedRuntimeEnv(deps.config);
  const customEnv = await deps.sandboxEnv.resolveRuntimeEnv();
  const credentials = (
    await Promise.all([
      deps.cloudAuth.getValidCredential({ providerId: "claude-code" }),
      deps.cloudAuth.getValidCredential({ providerId: "codex" }),
    ])
  ).filter(isResolvedCloudAuthCredential);
  const cloudAuthRuntimeMaterial = buildCloudAuthRuntimeMaterial({
    credentials,
  });
  const snapshot: HostRuntimeMaterialSnapshot = {
    env: {
      ...baseEnv,
      ...customEnv,
      ...cloudAuthRuntimeMaterial.env,
    },
    files: cloudAuthRuntimeMaterial.files,
    version: "",
  };
  return {
    ...snapshot,
    version: buildSnapshotVersion(snapshot),
  };
}

export function isEmptySandboxRuntimeMaterialSnapshot(
  snapshot: HostRuntimeMaterialSnapshot,
): boolean {
  return Object.keys(snapshot.env).length === 0 && snapshot.files.length === 0;
}

export async function readSandboxRuntimeMaterialSnapshotForVersion(
  deps: Pick<AppDeps, "cloudAuth" | "config" | "sandboxEnv">,
  args: { version: string },
): Promise<HostRuntimeMaterialSnapshot> {
  const desiredSnapshot = await buildSandboxRuntimeMaterialSnapshot(deps);
  if (desiredSnapshot.version !== args.version) {
    throw new ApiError(
      409,
      "stale_runtime_material_version",
      "Requested runtime material version is no longer current",
    );
  }
  return desiredSnapshot;
}
