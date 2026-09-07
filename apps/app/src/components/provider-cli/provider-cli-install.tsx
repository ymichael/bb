import { useSyncExternalStore } from "react";
import type {
  ProviderCliInstallAction,
  ProviderCliKey,
  ProviderCliStatus,
  ProviderCliStatusResponse,
} from "@bb/host-daemon-contract";
import { ProviderCliInstallLogDialog } from "@/components/dialogs/ProviderCliInstallLogDialog";
import {
  closeProviderCliInstallLog,
  getProviderCliInstallSnapshot,
  startProviderCliInstall,
  subscribeProviderCliInstalls,
} from "@/components/provider-cli/provider-cli-install-store";

export interface ProviderCliStatusEntry {
  provider: ProviderCliKey;
  status: ProviderCliStatus;
}

export interface ProviderCliIssue {
  provider: ProviderCliKey;
  status: ProviderCliStatus;
  action: ProviderCliStatus["installAction"];
  title: string;
  description: string;
  fingerprint: string;
}

export interface ProviderCliActionableIssue extends ProviderCliIssue {
  action: ProviderCliInstallAction;
}

export function providerCliEntries(
  status: ProviderCliStatusResponse,
): ProviderCliStatusEntry[] {
  return Object.entries(status).map(([provider, providerStatus]) => ({
    provider,
    status: providerStatus,
  }));
}

export function isProviderCliUpdateIssue(issue: ProviderCliIssue): boolean {
  return issue.status.installed;
}

export function buildProviderCliIssue(
  entry: ProviderCliStatusEntry,
): ProviderCliIssue | null {
  const { provider, status } = entry;
  if (!status.installed) {
    return {
      provider,
      status,
      action: status.installAction,
      title: `${status.displayName} CLI not installed`,
      description: `Install ${status.displayName} so bb can start ${status.displayName} sessions.`,
      fingerprint: `${provider}:missing:${status.latestVersion ?? "latest"}`,
    };
  }

  if (status.versionUnsupported) {
    const currentVersion = status.currentVersion ?? "Installed version unknown";
    const minimumVersion = status.minimumSupportedVersion ?? "a newer version";
    const requiredDescription = status.minimumSupportedVersion
      ? `required ${status.minimumSupportedVersion}+`
      : "requires a newer version";
    return {
      provider,
      status,
      action: status.installAction,
      title: `${status.displayName} update needed`,
      description: `${currentVersion}; ${requiredDescription}`,
      fingerprint: [
        provider,
        "unsupported",
        status.installSource,
        status.currentVersion ?? "unknown",
        minimumVersion,
        status.executablePath ?? status.executableName,
      ].join(":"),
    };
  }

  if (status.needsUpdate) {
    const currentVersion = status.currentVersion ?? "Installed version unknown";
    const description =
      status.latestVersion === null
        ? `${currentVersion}; newer release available`
        : `${currentVersion} -> ${status.latestVersion}`;
    const fingerprint = [
      provider,
      "outdated",
      status.installSource,
      status.currentVersion ?? "unknown",
      status.latestVersion ?? "unknown",
      status.executablePath ?? status.executableName,
    ].join(":");
    return {
      provider,
      status,
      action: status.installAction,
      title: `${status.displayName} update available`,
      description,
      fingerprint,
    };
  }

  return null;
}

export function isProviderCliIssue(
  issue: ProviderCliIssue | null,
): issue is ProviderCliIssue {
  return issue !== null;
}

export function hasProviderCliAction(
  issue: ProviderCliIssue,
): issue is ProviderCliActionableIssue {
  return issue.action !== null;
}

export function useProviderCliInstallRunner() {
  const snapshot = useSyncExternalStore(
    subscribeProviderCliInstalls,
    getProviderCliInstallSnapshot,
  );

  return {
    failuresByJobKey: snapshot.failuresByJobKey,
    queuedJobKeys: snapshot.queuedJobKeys,
    runningJobKey: snapshot.runningJobKey,
    startInstall: startProviderCliInstall,
  };
}

export function ProviderCliInstallLogDialogHost() {
  const snapshot = useSyncExternalStore(
    subscribeProviderCliInstalls,
    getProviderCliInstallSnapshot,
  );

  return (
    <ProviderCliInstallLogDialog
      state={snapshot.logDialogState}
      onClose={closeProviderCliInstallLog}
    />
  );
}
