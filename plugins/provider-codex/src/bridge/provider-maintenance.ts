import {
  type ProviderHealthResult,
  type ProviderInstallationRunResult,
  type ProviderInstallationStatus,
  type ProviderUsage,
  type ProviderUsageResult,
  type ProviderUsageWindow,
  experimental_clampPercent as clampPercent,
  experimental_commandOutput as commandOutput,
  experimental_compareVersions as compareVersions,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_npmGlobalInstallCommand as npmGlobalInstallCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_npmLatestVersion as npmLatestVersion,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { fetchChatGpt } from "../ai/chatgpt-fetch.js";
import {
  readCodexAuthFile,
  type CodexAuthCredentials,
} from "../ai/codex-auth.js";

const CODEX_MINIMUM_SUPPORTED_VERSION = "0.136.0";
const CODEX_REWIND_MINIMUM_SUPPORTED_VERSION = "0.143.0";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const USAGE_FETCH_TIMEOUT_MS = 15_000;
const CODEX_NPM_PACKAGE = "@openai/codex";

function fetchCodexUsage(headers: Headers): Promise<Response> {
  return fetchChatGpt({
    url: CODEX_USAGE_URL,
    init: (cloudflareHeaders) => {
      const requestHeaders = new Headers(headers);
      for (const [key, value] of cloudflareHeaders) {
        requestHeaders.set(key, value);
      }
      return {
        headers: requestHeaders,
        signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
      };
    },
  });
}

async function readCredentials(): Promise<CodexAuthCredentials | null> {
  const auth = await readCodexAuthFile();
  switch (auth.state) {
    case "ok":
      return auth.credentials;
    case "missing":
    case "unusable":
      return null;
    case "unreadable":
    case "malformed":
      throw auth.error;
  }
}

function minimumSupportedVersionForRequirement(
  requirement?: "thread_rewind",
): string {
  return requirement === "thread_rewind"
    ? CODEX_REWIND_MINIMUM_SUPPORTED_VERSION
    : CODEX_MINIMUM_SUPPORTED_VERSION;
}

function codexUpdateCommand(): {
  command: string;
  args: string[];
  displayCommand: string;
} {
  const args = ["update"];
  return {
    command: "codex",
    args,
    displayCommand: formatCommand("codex", args),
  };
}

export async function getCodexProviderInstallationStatus(
  requirement?: "thread_rewind",
): Promise<ProviderInstallationStatus> {
  const minimumSupportedVersion =
    minimumSupportedVersionForRequirement(requirement);
  const [resolvedExecutable, versionOutput, latestVersion, npmGlobal] =
    await Promise.all([
      resolveExecutablePath("codex"),
      commandOutput("codex", ["--version"]),
      npmLatestVersion(CODEX_NPM_PACKAGE),
      probeNpmGlobalPackage(CODEX_NPM_PACKAGE),
    ]);
  const installed = resolvedExecutable !== null || versionOutput !== null;
  const currentVersion = versionFrom(versionOutput);
  const needsUpdate =
    installed &&
    currentVersion !== null &&
    latestVersion !== null &&
    compareVersions(latestVersion, currentVersion) > 0;
  const versionUnsupported =
    installed &&
    (currentVersion === null
      ? requirement === "thread_rewind"
      : compareVersions(currentVersion, minimumSupportedVersion) < 0);
  const actionKind = !installed
    ? "install"
    : needsUpdate || versionUnsupported
      ? "update"
      : null;

  return {
    executableName: "codex",
    executablePath: resolvedExecutable,
    installed,
    installSource: npmGlobalInstallSource({
      installed,
      executablePath: resolvedExecutable,
      npmBin: npmGlobal.npmBin,
    }),
    currentVersion,
    latestVersion,
    minimumSupportedVersion,
    npmPackageName: CODEX_NPM_PACKAGE,
    npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
    installAction:
      actionKind === null
        ? null
        : {
            kind: actionKind,
            label: actionKind === "install" ? "Install" : "Update",
            command:
              actionKind === "install"
                ? npmGlobalInstallCommand(CODEX_NPM_PACKAGE).displayCommand
                : codexUpdateCommand().displayCommand,
          },
    needsUpdate,
    versionUnsupported,
  };
}

export async function getCodexProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await getCodexProviderInstallationStatus();
  return buildCodexProviderInstallationRun(status, action);
}

function buildCodexProviderInstallationRun(
  status: ProviderInstallationStatus,
  action: "install" | "update",
): ProviderInstallationRunResult {
  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message: `Codex ${action} is no longer available on this host.`,
    };
  }
  return {
    available: true,
    command:
      action === "install"
        ? npmGlobalInstallCommand(CODEX_NPM_PACKAGE)
        : codexUpdateCommand(),
    verification: installationVerification(status, action),
  };
}

function healthResult(
  status:
    | "ready"
    | "not_installed"
    | "unauthenticated"
    | "expired"
    | "unsupported_version"
    | "unknown",
  args: {
    accountEmail?: string | null;
    installedVersion?: string | null;
    statusMessage?: string | null;
  } = {},
): ProviderHealthResult {
  return {
    supported: true,
    health: {
      status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: CODEX_MINIMUM_SUPPORTED_VERSION,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: "codex login",
    },
  };
}

export async function getCodexProviderHealth(): Promise<ProviderHealthResult> {
  if ((await resolveExecutablePath("codex")) === null) {
    return healthResult("not_installed");
  }
  const version = await readCliVersion("codex");
  if (
    version !== null &&
    compareVersions(version, CODEX_MINIMUM_SUPPORTED_VERSION) < 0
  ) {
    return healthResult("unsupported_version", { installedVersion: version });
  }
  try {
    const credentials = await readCredentials();
    if (credentials === null) {
      return healthResult("unauthenticated", { installedVersion: version });
    }
    if (credentials.type === "chatgpt" && credentials.expired) {
      return healthResult("expired", {
        accountEmail: credentials.accountEmail,
        installedVersion: version,
      });
    }
    return healthResult("ready", {
      accountEmail:
        credentials.type === "chatgpt" ? credentials.accountEmail : null,
      installedVersion: version,
    });
  } catch (error) {
    return healthResult("unknown", {
      installedVersion: version,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

const codexUsageWindowSchema = z.object({
  used_percent: z.number(),
  reset_at: z.number().nullish(),
  limit_window_seconds: z.number().nullish(),
});

const codexUsageResponseSchema = z.object({
  plan_type: z.string().nullish(),
  rate_limit: z
    .object({
      primary_window: codexUsageWindowSchema.nullish(),
      secondary_window: codexUsageWindowSchema.nullish(),
    })
    .nullish(),
});

function usageWindow(
  value: z.infer<typeof codexUsageWindowSchema> | null | undefined,
  fallbackLabel: string,
): ProviderUsageWindow | null {
  if (!value) return null;
  return {
    label:
      value.limit_window_seconds === 604_800 ? "Weekly limit" : fallbackLabel,
    usedPercent: clampPercent(value.used_percent),
    resetsAt:
      value.reset_at == null || !Number.isFinite(value.reset_at)
        ? null
        : new Date(value.reset_at * 1000).toISOString(),
  };
}

function planLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const labels: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    team: "Team",
    business: "Business",
    education: "Education",
    edu: "Education",
    enterprise: "Enterprise",
  };
  return labels[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

function normalizeUsage(raw: unknown, email: string | null): ProviderUsage {
  const parsed = codexUsageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Codex usage response was malformed.",
      planLabel: null,
      accountEmail: email,
    };
  }
  const windows = [
    usageWindow(parsed.data.rate_limit?.primary_window, "Current session"),
    usageWindow(parsed.data.rate_limit?.secondary_window, "Weekly limit"),
  ].filter((window): window is ProviderUsageWindow => window !== null);
  return {
    status: "ok",
    accountEmail: email,
    planLabel: planLabel(parsed.data.plan_type),
    windows,
  };
}

export async function getCodexProviderUsage(): Promise<ProviderUsageResult> {
  if ((await resolveExecutablePath("codex")) === null) {
    return { supported: true, usage: { status: "not_installed" } };
  }
  let credentials: CodexAuthCredentials | null;
  try {
    credentials = await readCredentials();
  } catch (error) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        planLabel: null,
        accountEmail: null,
      },
    };
  }
  if (credentials === null) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  if (credentials.type === "apiKey") {
    return {
      supported: true,
      usage: {
        status: "error",
        message:
          "Codex is authenticated with an API key, which has no subscription usage limits.",
        planLabel: null,
        accountEmail: null,
      },
    };
  }
  if (credentials.expired) {
    return { supported: true, usage: { status: "expired" } };
  }
  try {
    const headers = new Headers({
      Authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      originator: "bb",
      "User-Agent": "bb-provider-codex",
      Accept: "application/json",
    });
    if (credentials.isFedrampAccount) headers.set("X-OpenAI-Fedramp", "true");
    const response = await fetchCodexUsage(headers);
    if (response.status === 401) {
      return { supported: true, usage: { status: "expired" } };
    }
    if (!response.ok) {
      return {
        supported: true,
        usage: {
          status: "error",
          message: `Codex usage request failed (HTTP ${response.status}).`,
          planLabel: null,
          accountEmail: credentials.accountEmail,
        },
      };
    }
    return {
      supported: true,
      usage: normalizeUsage(await response.json(), credentials.accountEmail),
    };
  } catch (error) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        planLabel: null,
        accountEmail: credentials.accountEmail,
      },
    };
  }
}

export const __testing = {
  buildProviderInstallationRun: buildCodexProviderInstallationRun,
  minimumSupportedVersionForRequirement,
  normalizeUsage,
};
