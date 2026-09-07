import { useEffect, type ReactNode } from "react";
import type { ProviderCliInstallAction } from "@bb/host-daemon-contract";
import { SettingsStoryFixtures } from "../../../.ladle/settings-story-fixtures";
import {
  HOST_IDS,
  makeProviderCliStatus,
} from "../../../.ladle/story-fixtures";
import type { ProviderCliActionableIssue } from "@/components/provider-cli/provider-cli-install";
import { startProviderCliInstall } from "@/components/provider-cli/provider-cli-install-store";
import { SidebarMenu } from "@/components/ui/sidebar";
import { sdk } from "@/lib/sdk";
import { SidebarUpdatesBadge } from "./SidebarUpdatesBadge";

export default { title: "sidebar/Updates badge" };

const action: ProviderCliInstallAction = {
  kind: "update",
  label: "Update",
  command: "codex update",
};
const status = makeProviderCliStatus("codex", {
  currentVersion: "0.150.0",
  latestVersion: "0.151.0",
  needsUpdate: true,
  installAction: action,
});
const issue: ProviderCliActionableIssue = {
  provider: "codex",
  status,
  action,
  title: "Codex update available",
  description: "0.150.0 -> 0.151.0",
  fingerprint: "codex:story",
};

function BadgeStage({ children }: { children?: ReactNode }) {
  return (
    <SettingsStoryFixtures>
      <div className="flex min-h-32 w-80 flex-col rounded-md border border-sidebar-border bg-sidebar p-4 text-sidebar-foreground">
        {children}
        <SidebarMenu className="mt-auto">
          <SidebarUpdatesBadge />
        </SidebarMenu>
      </div>
    </SettingsStoryFixtures>
  );
}

function ActiveProviderUpdate() {
  useEffect(() => {
    const originalInstallProviderCli = sdk.hosts.installProviderCli;
    let finishInstall: (() => void) | null = null;
    const startTimer = window.setTimeout(() => {
      sdk.hosts.installProviderCli = () =>
        new Promise((resolve) => {
          finishInstall = () => {
            resolve([
              {
                type: "completed",
                provider: "codex",
                exitCode: 0,
                signal: null,
                success: true,
              },
            ]);
          };
        });
      startProviderCliInstall({ hostId: HOST_IDS.local, issue });
    }, 0);

    return () => {
      window.clearTimeout(startTimer);
      sdk.hosts.installProviderCli = originalInstallProviderCli;
      finishInstall?.();
    };
  }, []);

  return <BadgeStage />;
}

export function ProviderUpdateAvailable() {
  return <BadgeStage />;
}

export function ProviderUpdateDownloading() {
  return <ActiveProviderUpdate />;
}
