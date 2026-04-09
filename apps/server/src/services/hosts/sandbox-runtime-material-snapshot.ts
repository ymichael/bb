import type { HostRuntimeMaterialSnapshot } from "@bb/host-daemon-contract";
import {
  buildCloudAuthRuntimeMaterial,
  type CloudAuthResolvedCredential,
} from "@bb/agent-provider-auth";
import {
  createHostRuntimeMaterialSnapshot,
  isEmptyHostRuntimeMaterialSnapshot,
} from "@bb/host-runtime-material";
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
  return createHostRuntimeMaterialSnapshot({
    env: {
      ...baseEnv,
      ...customEnv,
      ...cloudAuthRuntimeMaterial.env,
    },
    files: cloudAuthRuntimeMaterial.files,
  });
}

export function isEmptySandboxRuntimeMaterialSnapshot(
  snapshot: HostRuntimeMaterialSnapshot,
): boolean {
  return isEmptyHostRuntimeMaterialSnapshot(snapshot);
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
