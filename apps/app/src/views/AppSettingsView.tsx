import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, MoreHorizontal } from "lucide-react";
import { timeAgo } from "@bb/core-ui";
import type { CloudAuthProviderId } from "@bb/agent-providers";
import { Button } from "@/components/ui";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui";
import { PageShell } from "@/components/ui";
import { CloudAuthSettingsSection } from "@/components/settings/CloudAuthSettingsSection";
import { CONNECTED_DOT_CLASS } from "@/components/settings/constants";
import {
  SettingsRow,
  SettingsRowList,
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui";
import {
  SandboxEnvVarsSection,
  type EnvVarEntry,
} from "@/components/settings/SandboxEnvVarsSection";
import {
  HostDeleteDialog,
  type HostDeleteDialogTarget,
} from "@/components/dialogs/HostDeleteDialog";
import {
  HostRenameDialog,
  type HostRenameDialogTarget,
} from "@/components/dialogs/HostRenameDialog";
import {
  setPreferredTheme,
  useThemePreference,
  type ThemePreference,
} from "@/hooks/useTheme";
import {
  useCloudAuthAttempt,
  useCloudAuthSettings,
  useSandboxEnvVars,
} from "@/hooks/queries/system-queries";
import { useEffectiveHosts } from "@/hooks/queries/effective-hosts";
import {
  invalidateCloudAuthSettings,
  invalidateHostDeleteDependentQueries,
  invalidateSandboxEnvVars,
  invalidateHostAvailabilityQueries,
} from "@/hooks/cache-effects";
import { sandboxHostSupportedAtom } from "@/lib/system-config-atoms";
import * as api from "@/lib/api";
import { cn } from "@/lib/utils";

interface CloudAuthAttemptState {
  attemptId: string;
  providerId: CloudAuthProviderId;
}

interface RenameHostMutationRequest {
  id: string;
  name: string;
}

interface DeleteHostMutationRequest {
  id: string;
}

interface SaveEnvVarsMutationRequest {
  toDelete: string[];
  toUpsert: EnvVarEntry[];
}

type CloudAuthNoticeMap = Partial<Record<CloudAuthProviderId, string>>;

interface ThemePreferenceOption {
  label: string;
  value: ThemePreference;
}

const THEME_PREFERENCE_OPTIONS: ReadonlyArray<ThemePreferenceOption> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

export function AppSettingsView() {
  const themePreference = useThemePreference();
  const { data: hosts = [], isLoading: hostsLoading } = useEffectiveHosts();
  const sandboxHostSupported = useAtomValue(sandboxHostSupportedAtom);
  const { data: cloudAuthSettings, isLoading: cloudAuthLoading } =
    useCloudAuthSettings(sandboxHostSupported);
  const { data: sandboxEnvVars, isLoading: sandboxEnvLoading } =
    useSandboxEnvVars(sandboxHostSupported);
  const queryClient = useQueryClient();

  const [renameTarget, setRenameTarget] =
    useState<HostRenameDialogTarget | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<HostDeleteDialogTarget | null>(null);
  const [activeCloudAuthAttempt, setActiveCloudAuthAttempt] =
    useState<CloudAuthAttemptState | null>(null);
  const [cloudAuthNotices, setCloudAuthNotices] = useState<CloudAuthNoticeMap>(
    {},
  );

  const activeCloudAuthStatus = useCloudAuthAttempt(
    activeCloudAuthAttempt?.attemptId ?? null,
    activeCloudAuthAttempt !== null,
  );

  const renameHost = useMutation({
    meta: {
      errorMessage: "Failed to rename host.",
    },
    mutationFn: ({ id, name }: RenameHostMutationRequest) =>
      api.updateHost(id, { name }),
    onSuccess: () => {
      invalidateHostAvailabilityQueries({ queryClient });
      setRenameTarget(null);
    },
  });

  const deleteHost = useMutation({
    meta: {
      errorMessage: "Failed to remove host.",
    },
    mutationFn: ({ id }: DeleteHostMutationRequest) => api.deleteHost(id),
    onSuccess: () => {
      invalidateHostDeleteDependentQueries({ queryClient });
      setDeleteTarget(null);
    },
  });

  const authPopupRef = useRef<Window | null>(null);

  const startCloudAuthConnection = useMutation({
    meta: {
      errorMessage: "Failed to start cloud auth connection.",
    },
    mutationFn: (providerId: CloudAuthProviderId) =>
      api.startCloudAuthConnection(providerId),
    onSuccess: (result, providerId) => {
      setActiveCloudAuthAttempt({
        attemptId: result.attemptId,
        providerId,
      });
      const popup = authPopupRef.current;
      if (popup && !popup.closed) {
        popup.location.href = result.authorizationUrl;
      }
    },
    onError: () => {
      const popup = authPopupRef.current;
      if (popup && !popup.closed) {
        popup.close();
      }
      authPopupRef.current = null;
    },
  });

  function handleCloudAuthConnect(providerId: CloudAuthProviderId) {
    const width = 500;
    const height = 700;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
    authPopupRef.current = window.open(
      "about:blank",
      "cloud-auth",
      `width=${width},height=${height},left=${left},top=${top},popup=1`,
    );

    startCloudAuthConnection.mutate(providerId);
  }

  const disconnectCloudAuth = useMutation({
    meta: {
      errorMessage: "Failed to remove cloud auth connection.",
    },
    mutationFn: (providerId: CloudAuthProviderId) =>
      api.deleteCloudAuthProvider(providerId),
    onSuccess: (_, providerId) => {
      invalidateCloudAuthSettings({ queryClient });
      setCloudAuthNotices((current) => ({
        ...current,
        [providerId]:
          "Connection removed. The next sandbox sync will delete its auth material.",
      }));
      if (activeCloudAuthAttempt?.providerId === providerId) {
        setActiveCloudAuthAttempt(null);
      }
    },
  });

  const saveEnvVars = useMutation({
    meta: {
      errorMessage: "Failed to save environment variables.",
    },
    mutationFn: async ({ toUpsert, toDelete }: SaveEnvVarsMutationRequest) => {
      await Promise.all([
        ...toUpsert.map((entry) => api.upsertSandboxEnvVar(entry)),
        ...toDelete.map((name) => api.deleteSandboxEnvVar(name)),
      ]);
    },
    onSuccess: () => {
      invalidateSandboxEnvVars({ queryClient });
    },
  });

  useEffect(() => {
    if (!activeCloudAuthAttempt || !activeCloudAuthStatus.data) {
      return;
    }

    const attempt = activeCloudAuthStatus.data;
    if (attempt.status === "pending") {
      return;
    }

    invalidateCloudAuthSettings({ queryClient });
    if (attempt.status !== "completed") {
      setCloudAuthNotices((current) => ({
        ...current,
        [attempt.providerId]:
          attempt.errorMessage ?? "Connection did not complete.",
      }));
    }
    setActiveCloudAuthAttempt(null);
  }, [activeCloudAuthAttempt, activeCloudAuthStatus.data, queryClient]);

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <SettingsSection title="Appearance">
          <SettingsWithControl label="Theme">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-between sm:w-48"
                  aria-label="Theme"
                >
                  {THEME_PREFERENCE_LABELS[themePreference]}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {THEME_PREFERENCE_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => setPreferredTheme(option.value)}
                  >
                    {option.label}
                    <Check
                      className={cn(
                        "ml-auto",
                        themePreference !== option.value && "opacity-0",
                        COARSE_POINTER_ICON_SIZE_CLASS,
                      )}
                    />
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SettingsWithControl>
        </SettingsSection>

        <SettingsSection title="Hosts">
          {hostsLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : hosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No registered hosts.
            </p>
          ) : (
            <SettingsRowList>
              {hosts.map((host) => {
                const isConnected = host.status === "connected";
                return (
                  <SettingsRow key={host.id}>
                    <span className="min-w-0 flex-1 truncate">
                      {host.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {host.id}
                      </span>
                    </span>
                    {isConnected ? (
                      <span className={CONNECTED_DOT_CLASS} title="Connected" />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Offline · {timeAgo(host.lastSeenAt)}
                      </span>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          aria-label="Host actions"
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem
                          onSelect={() =>
                            setRenameTarget({
                              id: host.id,
                              currentName: host.name,
                            })
                          }
                        >
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() =>
                            setDeleteTarget({ id: host.id, name: host.name })
                          }
                        >
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SettingsRow>
                );
              })}
            </SettingsRowList>
          )}
        </SettingsSection>

        {sandboxHostSupported ? (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Sandbox Hosts</h2>
            <CloudAuthSettingsSection
              activeAttemptProviderId={
                activeCloudAuthAttempt?.providerId ?? null
              }
              connectPending={startCloudAuthConnection.isPending}
              connections={cloudAuthSettings?.connections ?? []}
              disconnectPending={disconnectCloudAuth.isPending}
              isLoading={cloudAuthLoading}
              notices={cloudAuthNotices}
              onCancel={() => {
                if (authPopupRef.current && !authPopupRef.current.closed) {
                  authPopupRef.current.close();
                }
                authPopupRef.current = null;
                setActiveCloudAuthAttempt(null);
              }}
              onConnect={handleCloudAuthConnect}
              onDisconnect={(providerId) =>
                disconnectCloudAuth.mutate(providerId)
              }
            />

            <SandboxEnvVarsSection
              envVars={sandboxEnvVars?.envVars ?? []}
              isLoading={sandboxEnvLoading}
              onSave={(toUpsert, toDelete) =>
                saveEnvVars.mutate({ toUpsert, toDelete })
              }
              savePending={saveEnvVars.isPending}
            />
          </section>
        ) : null}
      </div>

      <HostRenameDialog
        target={renameTarget}
        pending={renameHost.isPending}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        onRename={(id, name) => renameHost.mutate({ id, name })}
      />
      <HostDeleteDialog
        target={deleteTarget}
        pending={deleteHost.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onDelete={(id) => deleteHost.mutate({ id })}
      />
    </PageShell>
  );
}
