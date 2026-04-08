import { toOptionalString } from "@bb/config/strings";
import type { HostType, SandboxBackendInfo } from "@bb/domain";
import {
  provisionHost as provisionSandboxHost,
  resumeHost as resumeSandboxHost,
  resumeSandbox,
} from "@bb/sandbox-host";
import type {
  ProvisionHostOptions,
  ResumeHostOptions,
  SandboxHostProgressCallbacks,
} from "@bb/sandbox-host";
import { ApiError } from "../../errors.js";
import type { ServerRuntimeConfig } from "../../types.js";
import { buildSandboxDaemonEnv } from "./sandbox-daemon-env.js";
import { hasConfiguredReachablePublicServerUrl } from "./public-server-url.js";
import { hasConfiguredSandboxTemplate } from "./sandbox-config.js";

export type SandboxBackendInfoResolverConfig = Pick<
  ServerRuntimeConfig,
  "e2bApiKey" | "e2bTemplate" | "githubPat" | "publicUrl"
>;

export type SandboxBackendConfig = Pick<
  ServerRuntimeConfig,
  | "anthropicApiKey"
  | "e2bApiKey"
  | "e2bTemplate"
  | "githubPat"
  | "openAiApiKey"
>;

export interface SandboxBackendProvisionArgs {
  config: SandboxBackendConfig;
  enrollKey: string;
  hostId: string;
  hostName: string;
  progressCallbacks?: SandboxHostProgressCallbacks;
  serverUrl: string;
}

export interface SandboxBackendResumeArgs {
  config: SandboxBackendConfig;
  externalId: string;
  hostId: string;
  hostName: string;
  progressCallbacks?: SandboxHostProgressCallbacks;
  serverUrl: string;
}

export interface SandboxBackendDestroyArgs {
  config: SandboxBackendConfig;
  externalId: string;
}

export interface SandboxBackendExtendTimeoutArgs {
  config: SandboxBackendConfig;
  externalId: string;
  timeoutMs: number;
}

export interface SandboxBackendHostRecord {
  id: string;
  name: string;
  provider: string | null;
  type: HostType;
}

export interface SandboxBackend {
  getInfo(config: SandboxBackendInfoResolverConfig): SandboxBackendInfo;
  destroyHost(args: SandboxBackendDestroyArgs): Promise<void>;
  extendHostTimeout(args: SandboxBackendExtendTimeoutArgs): Promise<void>;
  provisionHost(
    args: SandboxBackendProvisionArgs,
  ): ReturnType<typeof provisionSandboxHost>;
  resumeHost(
    args: SandboxBackendResumeArgs,
  ): ReturnType<typeof resumeSandboxHost>;
  suspendHost(args: SandboxBackendDestroyArgs): Promise<void>;
}

const E2B_SANDBOX_BACKEND_INFO = {
  id: "e2b",
  displayName: "E2B",
  capabilities: {
    supportsManagedClone: true,
    supportsManagedWorktree: false,
    supportsSuspend: true,
  },
} satisfies Omit<SandboxBackendInfo, "available">;

function isE2BBackendAvailable(config: SandboxBackendInfoResolverConfig): boolean {
  return (
    config.e2bApiKey !== "" &&
    hasConfiguredSandboxTemplate(config) &&
    config.githubPat !== "" &&
    hasConfiguredReachablePublicServerUrl(config)
  );
}

function requireE2BProvisioningConfig(config: SandboxBackendConfig): void {
  if (config.e2bApiKey === "") {
    throw new ApiError(
      501,
      "not_configured",
      "Sandbox provisioning requires E2B_API_KEY to be configured",
    );
  }
  if (!hasConfiguredSandboxTemplate(config)) {
    throw new ApiError(
      501,
      "not_configured",
      "Sandbox provisioning requires E2B_TEMPLATE to be configured",
    );
  }
  if (config.githubPat === "") {
    throw new ApiError(
      501,
      "not_configured",
      "Sandbox provisioning requires BB_GITHUB_PAT to be configured",
    );
  }
}

export function assertSandboxProvisioningConfig(
  sandboxType: string,
  config: SandboxBackendConfig,
): void {
  switch (sandboxType) {
    case "e2b":
      requireE2BProvisioningConfig(config);
      return;
    default:
      createSandboxBackendForId(sandboxType);
  }
}

function buildProvisionHostOptions(
  args: SandboxBackendProvisionArgs,
): ProvisionHostOptions {
  return {
    apiKey: args.config.e2bApiKey,
    daemonEnv: buildSandboxDaemonEnv(args.config),
    enrollKey: args.enrollKey,
    hostId: args.hostId,
    hostName: args.hostName,
    progressCallbacks: args.progressCallbacks,
    serverUrl: args.serverUrl,
    template: args.config.e2bTemplate === "" ? undefined : args.config.e2bTemplate,
  };
}

function buildResumeHostOptions(
  args: SandboxBackendResumeArgs,
): ResumeHostOptions {
  return {
    apiKey: toOptionalString(args.config.e2bApiKey),
    daemonEnv: buildSandboxDaemonEnv(args.config),
    externalId: args.externalId,
    hostId: args.hostId,
    hostName: args.hostName,
    progressCallbacks: args.progressCallbacks,
    serverUrl: args.serverUrl,
  };
}

const e2bSandboxBackend: SandboxBackend = {
  getInfo(config) {
    return {
      ...E2B_SANDBOX_BACKEND_INFO,
      available: isE2BBackendAvailable(config),
    };
  },
  async destroyHost(args) {
    const sandbox = await resumeSandbox(args.externalId, {
      apiKey: toOptionalString(args.config.e2bApiKey),
    });
    await sandbox.kill();
  },
  async extendHostTimeout(args) {
    const sandbox = await resumeSandbox(args.externalId, {
      apiKey: toOptionalString(args.config.e2bApiKey),
    });
    await sandbox.setTimeout(args.timeoutMs);
  },
  provisionHost(args) {
    requireE2BProvisioningConfig(args.config);
    return provisionSandboxHost(buildProvisionHostOptions(args));
  },
  resumeHost(args) {
    return resumeSandboxHost(buildResumeHostOptions(args));
  },
  async suspendHost(args) {
    const sandbox = await resumeSandbox(args.externalId, {
      apiKey: toOptionalString(args.config.e2bApiKey),
    });
    await sandbox.pause();
  },
};

const sandboxBackends = new Map<string, SandboxBackend>([
  ["e2b", e2bSandboxBackend],
]);

export function listAvailableSandboxBackends(
  config: SandboxBackendInfoResolverConfig,
): SandboxBackendInfo[] {
  return [...sandboxBackends.values()].map((backend) => backend.getInfo(config));
}

export function createSandboxBackendForId(sandboxType: string): SandboxBackend {
  const backend = sandboxBackends.get(sandboxType);
  if (backend) {
    return backend;
  }

  const backendIds = [...sandboxBackends.keys()];
  throw new ApiError(
    400,
    "invalid_request",
    `Unsupported sandbox backend "${sandboxType}". Available backends: ${backendIds.join(", ")}`,
  );
}

export function requireSandboxBackendForHost(
  host: SandboxBackendHostRecord,
): SandboxBackend {
  if (host.type !== "ephemeral") {
    throw new ApiError(
      500,
      "internal_error",
      `Host ${host.id} is not an ephemeral sandbox host`,
    );
  }
  if (!host.provider) {
    throw new ApiError(
      500,
      "internal_error",
      `Sandbox host ${host.id} is missing a backend provider`,
    );
  }
  return createSandboxBackendForId(host.provider);
}
