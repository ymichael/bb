import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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
  experimental_downloadedInstallerCommand as downloadedInstallerCommand,
  experimental_formatCommand as formatCommand,
  experimental_installationVerification as installationVerification,
  experimental_npmCommand as npmCommand,
  experimental_npmGlobalInstallSource as npmGlobalInstallSource,
  experimental_probeNpmGlobalPackage as probeNpmGlobalPackage,
  experimental_readCliVersion as readCliVersion,
  experimental_resolveExecutablePath as resolveExecutablePath,
  experimental_versionFrom as versionFrom,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const USAGE_FETCH_TIMEOUT_MS = 15_000;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";
const CLAUDE_INSTALL_SCRIPT_URL = "https://claude.ai/install.sh";

const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
    subscriptionType: z.string().nullish(),
    rateLimitTier: z.string().nullish(),
  }),
});
type ClaudeCredentials = z.infer<
  typeof claudeCredentialsSchema
>["claudeAiOauth"];

const claudeAccountSchema = z.object({
  oauthAccount: z
    .object({ emailAddress: z.string().email().nullish() })
    .nullish(),
});

function claudeExecutable(): string {
  return process.env.BB_CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
}

function claudeDistTags(value: string | null): {
  latest: string;
  stable: string | null;
} | null {
  if (value === null) return null;
  try {
    const parsed = z
      .object({
        latest: z.string().min(1),
        stable: z.string().min(1).optional(),
      })
      .safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    const latest = versionFrom(parsed.data.latest);
    if (latest === null) return null;
    return {
      latest,
      stable:
        parsed.data.stable === undefined
          ? latest
          : versionFrom(parsed.data.stable),
    };
  } catch {
    return null;
  }
}

function claudeDoctor(value: string | null): {
  installMethod: "native" | "npm-global" | "package-manager" | "unknown" | null;
  updateChannel: "latest" | "stable" | null;
} {
  const running =
    value === null ? null : /^Running:\s+([^\s(]+)/mu.exec(value)?.[1];
  const channel =
    value === null
      ? null
      : /^Auto-update channel:\s+(latest|stable)\s*$/mu.exec(value)?.[1];
  return {
    installMethod:
      running === "native" || running === "npm-global"
        ? running
        : running !== null && running !== undefined
          ? ["homebrew", "winget", "apt", "dnf", "apk"].includes(running)
            ? "package-manager"
            : "unknown"
          : null,
    updateChannel:
      channel === "latest" || channel === "stable" ? channel : null,
  };
}

function isDefaultNativeClaudePath(executablePath: string | null): boolean {
  if (executablePath === null) return false;
  const normalized = executablePath.replace(/\\/gu, "/");
  return (
    normalized.endsWith("/.local/bin/claude") ||
    (process.platform === "win32" &&
      normalized.endsWith("/.local/bin/claude.exe"))
  );
}

export async function getClaudeProviderInstallationStatus(): Promise<ProviderInstallationStatus> {
  const command = claudeExecutable();
  const [
    resolvedExecutable,
    versionOutput,
    tagsOutput,
    npmGlobal,
    doctorOutput,
  ] = await Promise.all([
    resolveExecutablePath(command),
    commandOutput(command, ["--version"]),
    commandOutput(npmCommand(), [
      "view",
      CLAUDE_NPM_PACKAGE,
      "dist-tags",
      "--json",
    ]),
    probeNpmGlobalPackage(CLAUDE_NPM_PACKAGE),
    commandOutput(command, ["doctor"]),
  ]);
  const installed = resolvedExecutable !== null || versionOutput !== null;
  const currentVersion = versionFrom(versionOutput);
  const doctor = claudeDoctor(doctorOutput);
  const tags = claudeDistTags(tagsOutput);
  const latestVersion =
    doctor.updateChannel === null || tags === null
      ? null
      : tags[doctor.updateChannel];
  const definitelyNeedsUnknownChannelUpdate =
    installed &&
    currentVersion !== null &&
    tags?.stable !== null &&
    tags?.stable !== undefined &&
    compareVersions(tags.latest, currentVersion) > 0 &&
    compareVersions(tags.stable, currentVersion) > 0;
  const needsUpdate =
    installed && currentVersion !== null && latestVersion !== null
      ? compareVersions(latestVersion, currentVersion) > 0
      : definitelyNeedsUnknownChannelUpdate;
  const installSource = npmGlobalInstallSource({
    installed,
    executablePath: resolvedExecutable,
    npmBin: npmGlobal.npmBin,
  });
  const nativeFallback =
    doctor.installMethod === null &&
    installSource === "external" &&
    isDefaultNativeClaudePath(resolvedExecutable);
  const canRunUpdate =
    doctor.installMethod === "native" ||
    nativeFallback ||
    (installSource === "npmGlobal" &&
      (doctor.installMethod === null || doctor.installMethod === "npm-global"));
  const actionKind = !installed
    ? "install"
    : needsUpdate && canRunUpdate
      ? "update"
      : null;
  const displayCommand =
    actionKind === "install"
      ? downloadedInstallerCommand(CLAUDE_INSTALL_SCRIPT_URL).displayCommand
      : formatCommand(command, ["update"]);
  return {
    executableName: command,
    executablePath: resolvedExecutable,
    installed,
    installSource,
    currentVersion,
    latestVersion,
    minimumSupportedVersion: null,
    npmPackageName: CLAUDE_NPM_PACKAGE,
    npmGlobalPackageVersion: npmGlobal.npmGlobalPackageVersion,
    installAction:
      actionKind === null
        ? null
        : {
            kind: actionKind,
            label: actionKind === "install" ? "Install" : "Update",
            command: displayCommand,
          },
    needsUpdate,
    versionUnsupported: false,
  };
}

export async function getClaudeProviderInstallationRun(
  action: "install" | "update",
): Promise<ProviderInstallationRunResult> {
  const status = await getClaudeProviderInstallationStatus();
  return buildClaudeProviderInstallationRun(status, action);
}

function buildClaudeProviderInstallationRun(
  status: ProviderInstallationStatus,
  action: "install" | "update",
): ProviderInstallationRunResult {
  if (status.installAction?.kind !== action) {
    return {
      available: false,
      message: `Claude Code ${action} is no longer available on this host.`,
    };
  }
  const command = claudeExecutable();
  const execution =
    action === "install"
      ? downloadedInstallerCommand(CLAUDE_INSTALL_SCRIPT_URL)
      : {
          command,
          args: ["update"],
          displayCommand: formatCommand(command, ["update"]),
        };
  return {
    available: true,
    command: execution,
    verification: installationVerification(status, action),
  };
}

async function readKeychainCredentials(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const argumentSets = [
    [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-a",
      os.userInfo().username,
      "-w",
    ],
    ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
  ];
  for (const args of argumentSets) {
    try {
      const { stdout } = await execFileAsync("security", args, {
        timeout: 10_000,
      });
      if (stdout.trim()) return stdout.trim();
    } catch {}
  }
  return null;
}

function parseCredentials(raw: string): ClaudeCredentials | null {
  const trimmed = raw.trim();
  const candidates = [trimmed];
  if (/^(?:[0-9a-f]{2})+$/iu.test(trimmed)) {
    candidates.push(Buffer.from(trimmed, "hex").toString("utf8"));
  }
  for (const candidate of candidates) {
    try {
      const parsed = claudeCredentialsSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data.claudeAiOauth;
    } catch {}
  }
  return null;
}

async function readCredentials(): Promise<ClaudeCredentials | null> {
  const keychainCredentials = await readKeychainCredentials();
  if (keychainCredentials !== null) {
    const parsed = parseCredentials(keychainCredentials);
    if (parsed !== null) return parsed;
  }
  try {
    return parseCredentials(
      await fs.readFile(
        path.join(os.homedir(), ".claude", ".credentials.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}

async function readAccountEmail(): Promise<string | null> {
  try {
    const parsed = claudeAccountSchema.safeParse(
      JSON.parse(
        await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8"),
      ),
    );
    return parsed.success
      ? (parsed.data.oauthAccount?.emailAddress ?? null)
      : null;
  } catch {
    return null;
  }
}

function planLabel(credentials: ClaudeCredentials): string | null {
  const maxMatch = (credentials.rateLimitTier ?? "").match(/max_(\d+)x/u);
  if (maxMatch) return `Max (${maxMatch[1]}x)`;
  const subscription = credentials.subscriptionType;
  return subscription
    ? subscription.charAt(0).toUpperCase() + subscription.slice(1)
    : null;
}

function healthResult(
  status: "ready" | "not_installed" | "unauthenticated" | "expired" | "unknown",
  args: {
    accountEmail?: string | null;
    planLabel?: string | null;
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
      planLabel: args.planLabel ?? null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: null,
      canInstall: true,
      canUpdate: status !== "not_installed",
      loginCommand: "claude /login",
    },
  };
}

export async function getClaudeProviderHealth(): Promise<ProviderHealthResult> {
  const command = claudeExecutable();
  if ((await resolveExecutablePath(command)) === null) {
    return healthResult("not_installed");
  }
  const version = await readCliVersion(command);
  try {
    const [credentials, email] = await Promise.all([
      readCredentials(),
      readAccountEmail(),
    ]);
    if (!credentials) {
      return healthResult("unauthenticated", { installedVersion: version });
    }
    const known = {
      accountEmail: email,
      planLabel: planLabel(credentials),
      installedVersion: version,
    };
    return credentials.expiresAt != null && Date.now() >= credentials.expiresAt
      ? healthResult("expired", known)
      : healthResult("ready", known);
  } catch (error) {
    return healthResult("unknown", {
      installedVersion: version,
      statusMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

const claudeUsageWindowSchema = z.object({
  utilization: z.number().nullish(),
  resets_at: z.string().nullish(),
});

const claudeScopedUsageLimitSchema = z
  .object({
    kind: z.string(),
    scope: z
      .object({
        model: z
          .object({ display_name: z.string().trim().min(1).nullish() })
          .nullish(),
        surface: z.null().optional(),
      })
      .nullish(),
    percent: z.number().nullish(),
    resets_at: z.string().nullish(),
  })
  .passthrough();

const claudeUsageResponseSchema = z
  .object({
    five_hour: claudeUsageWindowSchema.nullish(),
    seven_day: claudeUsageWindowSchema.nullish(),
    limits: z
      .array(claudeScopedUsageLimitSchema.nullable().catch(null))
      .nullish()
      .catch([]),
  })
  .passthrough();

function resetIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function usageWindow(
  value: z.infer<typeof claudeUsageWindowSchema> | null | undefined,
  label: string,
): ProviderUsageWindow | null {
  if (!value || value.utilization == null) return null;
  return {
    label,
    usedPercent: clampPercent(value.utilization),
    resetsAt: resetIso(value.resets_at),
  };
}

function scopedWindows(
  limits:
    | (z.infer<typeof claudeScopedUsageLimitSchema> | null)[]
    | null
    | undefined,
): ProviderUsageWindow[] {
  const windows: ProviderUsageWindow[] = [];
  const seen = new Set<string>();
  for (const limit of limits ?? []) {
    const label = limit?.scope?.model?.display_name;
    if (
      limit == null ||
      limit.kind !== "weekly_scoped" ||
      label == null ||
      limit.percent == null ||
      seen.has(label.toLowerCase())
    ) {
      continue;
    }
    seen.add(label.toLowerCase());
    windows.push({
      label,
      usedPercent: clampPercent(limit.percent),
      resetsAt: resetIso(limit.resets_at),
    });
  }
  return windows;
}

function normalizeUsage(
  raw: unknown,
  credentials: ClaudeCredentials,
  email: string | null,
): ProviderUsage {
  const parsed = claudeUsageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Claude usage response was malformed.",
      planLabel: planLabel(credentials),
      accountEmail: email,
    };
  }
  const windows = [
    usageWindow(parsed.data.five_hour, "Current session"),
    usageWindow(parsed.data.seven_day, "Weekly limit"),
    ...scopedWindows(parsed.data.limits),
  ].filter((window): window is ProviderUsageWindow => window !== null);
  return {
    status: "ok",
    accountEmail: email,
    planLabel: planLabel(credentials),
    windows,
  };
}

export async function getClaudeProviderUsage(): Promise<ProviderUsageResult> {
  const command = claudeExecutable();
  if ((await resolveExecutablePath(command)) === null) {
    return { supported: true, usage: { status: "not_installed" } };
  }
  const [credentials, email] = await Promise.all([
    readCredentials(),
    readAccountEmail(),
  ]);
  if (!credentials) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  if (credentials.expiresAt != null && Date.now() >= credentials.expiresAt) {
    return { supported: true, usage: { status: "expired" } };
  }
  const known = { planLabel: planLabel(credentials), accountEmail: email };
  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
      signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
    });
    if (response.status === 401) {
      return { supported: true, usage: { status: "expired" } };
    }
    if (!response.ok) {
      return {
        supported: true,
        usage: {
          status: "error",
          message:
            response.status === 429
              ? "Anthropic temporarily throttled this usage check. This does not mean your Claude limit is exhausted. Try again later."
              : `Claude usage request failed (HTTP ${response.status}).`,
          ...known,
        },
      };
    }
    return {
      supported: true,
      usage: normalizeUsage(await response.json(), credentials, email),
    };
  } catch (error) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        ...known,
      },
    };
  }
}

export const __testing = {
  buildProviderInstallationRun: buildClaudeProviderInstallationRun,
  normalizeUsage,
};
