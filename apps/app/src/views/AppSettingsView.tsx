import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, MoreHorizontal } from "lucide-react";
import { timeAgo } from "@bb/core-ui";
import type { CloudAuthProviderId } from "@bb/agent-providers";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageShell } from "@/components/layout/PageShell";
import { CloudAuthSettingsSection } from "@/components/settings/CloudAuthSettingsSection";
import { CONNECTED_DOT_CLASS } from "@/components/settings/constants";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { SettingsRow, SettingsRowList } from "@/components/settings/SettingsRow";
import { SandboxEnvVarsSection, type EnvVarEntry } from "@/components/settings/SandboxEnvVarsSection";
import { SettingsWithControl } from "@/components/settings/SettingsWithControl";
import {
  HostDeleteDialog,
  type HostDeleteDialogTarget,
} from "@/components/settings/HostDeleteDialog";
import {
  HostRenameDialog,
  type HostRenameDialogTarget,
} from "@/components/settings/HostRenameDialog";
import { setPreferredTheme, usePreferredTheme } from "@/hooks/useTheme";
import {
  useCloudAuthAttempt,
  useCloudAuthSettings,
  useHosts,
  useSandboxEnvVars,
} from "@/hooks/queries/system-queries";
import {
  allHostQueryKeyPrefix,
  cloudAuthSettingsQueryKey,
  hostsQueryKey,
  projectsQueryKey,
  sandboxEnvVarsQueryKey,
} from "@/hooks/queries/query-keys";
import { sandboxHostSupportedAtom } from "@/lib/atoms";
import * as api from "@/lib/api";

interface CloudAuthAttemptState {
  attemptId: string;
  providerId: CloudAuthProviderId;
}

type CloudAuthNoticeMap = Partial<Record<CloudAuthProviderId, string>>;

export function AppSettingsView() {
  const theme = usePreferredTheme();
  const { data: hosts = [], isLoading: hostsLoading } = useHosts();
  const sandboxHostSupported = useAtomValue(sandboxHostSupportedAtom);
  const { data: cloudAuthSettings, isLoading: cloudAuthLoading } = useCloudAuthSettings(
    sandboxHostSupported,
  );
  const { data: sandboxEnvVars, isLoading: sandboxEnvLoading } = useSandboxEnvVars(
    sandboxHostSupported,
  );
  const queryClient = useQueryClient();

  const [renameTarget, setRenameTarget] = useState<HostRenameDialogTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HostDeleteDialogTarget | null>(null);
  const [activeCloudAuthAttempt, setActiveCloudAuthAttempt] = useState<CloudAuthAttemptState | null>(
    null,
  );
  const [cloudAuthNotices, setCloudAuthNotices] = useState<CloudAuthNoticeMap>({});

  const activeCloudAuthStatus = useCloudAuthAttempt(
    activeCloudAuthAttempt?.attemptId ?? null,
    activeCloudAuthAttempt !== null,
  );

  const renameHost = useMutation({
    meta: {
      errorMessage: "Failed to rename host.",
    },
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.updateHost(id, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: hostsQueryKey() });
      queryClient.invalidateQueries({ queryKey: allHostQueryKeyPrefix() });
      setRenameTarget(null);
    },
  });

  const deleteHost = useMutation({
    meta: {
      errorMessage: "Failed to remove host.",
    },
    mutationFn: ({ id }: { id: string }) => api.deleteHost(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: hostsQueryKey() });
      queryClient.invalidateQueries({ queryKey: allHostQueryKeyPrefix() });
      queryClient.invalidateQueries({ queryKey: projectsQueryKey() });
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
      queryClient.invalidateQueries({ queryKey: cloudAuthSettingsQueryKey() });
      setCloudAuthNotices((current) => ({
        ...current,
        [providerId]: "Connection removed. The next sandbox sync will delete its auth material.",
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
    mutationFn: async ({
      toUpsert,
      toDelete,
    }: {
      toUpsert: EnvVarEntry[];
      toDelete: string[];
    }) => {
      await Promise.all([
        ...toUpsert.map((entry) => api.upsertSandboxEnvVar(entry)),
        ...toDelete.map((name) => api.deleteSandboxEnvVar(name)),
      ]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sandboxEnvVarsQueryKey() });
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

    queryClient.invalidateQueries({ queryKey: cloudAuthSettingsQueryKey() });
    if (attempt.status !== "completed") {
      setCloudAuthNotices((current) => ({
        ...current,
        [attempt.providerId]: attempt.errorMessage ?? "Connection did not complete.",
      }));
    }
    setActiveCloudAuthAttempt(null);
  }, [activeCloudAuthAttempt, activeCloudAuthStatus.data, queryClient]);

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <SettingsSection title="Appearance">
          <SettingsWithControl
            label="Theme"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-between sm:w-48"
                  aria-label="Theme"
                >
                  {theme === "dark" ? "Dark" : "Light"}
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => setPreferredTheme("light")}>
                  Light
                  <Check className={theme === "light" ? "ml-auto size-4" : "ml-auto size-4 opacity-0"} />
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPreferredTheme("dark")}>
                  Dark
                  <Check className={theme === "dark" ? "ml-auto size-4" : "ml-auto size-4 opacity-0"} />
                </DropdownMenuItem>
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
                      <span className="ml-1.5 text-xs text-muted-foreground">{host.id}</span>
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
                            setRenameTarget({ id: host.id, currentName: host.name })
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
                activeAttemptProviderId={activeCloudAuthAttempt?.providerId ?? null}
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
                onDisconnect={(providerId) => disconnectCloudAuth.mutate(providerId)}
              />

              <SandboxEnvVarsSection
                envVars={sandboxEnvVars?.envVars ?? []}
                isLoading={sandboxEnvLoading}
                onSave={(toUpsert, toDelete) =>
                  saveEnvVars.mutate({ toUpsert, toDelete })}
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
