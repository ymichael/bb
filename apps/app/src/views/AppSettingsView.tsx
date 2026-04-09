import { type ReactNode, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, MoreHorizontal } from "lucide-react";
import type {
  CloudAuthConnection,
  CloudAuthProviderId,
} from "@bb/server-contract";
import { timeAgo } from "@bb/core-ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PageShell } from "@/components/layout/PageShell";
import { SettingsSection } from "@/components/settings/SettingsSection";
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

function SettingsWithControl({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="flex-1">
        <p className="text-sm font-semibold">{label}</p>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="sm:flex sm:min-w-[320px] sm:justify-end">{children}</div>
    </div>
  );
}

const CONNECTED_DOT_CLASS =
  "bg-emerald-500 ring-emerald-500/25 shadow-[0_0_0_4px_rgba(16,185,129,0.16)]";

interface CloudAuthAttemptState {
  attemptId: string;
  providerId: CloudAuthProviderId;
}

type CloudAuthNoticeMap = Partial<Record<CloudAuthProviderId, string>>;

interface CloudAuthRowProps {
  activeAttemptProviderId: CloudAuthProviderId | null;
  connection: CloudAuthConnection;
  connectPending: boolean;
  disconnectPending: boolean;
  notice: string | null;
  onConnect(providerId: CloudAuthProviderId): void;
  onDisconnect(providerId: CloudAuthProviderId): void;
}

interface SandboxEnvVarFormState {
  name: string;
  value: string;
}

function cloudAuthBadgeVariant(
  status: CloudAuthConnection["status"],
): "default" | "destructive" | "outline" {
  switch (status) {
    case "connected":
      return "default";
    case "invalid":
      return "destructive";
    case "missing":
      return "outline";
  }
}

function cloudAuthStatusLabel(
  status: CloudAuthConnection["status"],
): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "invalid":
      return "Needs attention";
    case "missing":
      return "Not connected";
  }
}

function CloudAuthRow({
  activeAttemptProviderId,
  connection,
  connectPending,
  disconnectPending,
  notice,
  onConnect,
  onDisconnect,
}: CloudAuthRowProps) {
  const connectedTime = connection.lastRefreshedAt ?? connection.connectedAt;
  const isPendingAttempt = activeAttemptProviderId === connection.providerId;
  const canDisconnect = connection.status !== "missing";

  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{connection.displayName}</p>
          <Badge variant={cloudAuthBadgeVariant(connection.status)}>
            {cloudAuthStatusLabel(connection.status)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {connection.label ?? "No account connected"}
          {connectedTime ? ` · Updated ${timeAgo(connectedTime)}` : ""}
        </p>
        {connection.errorMessage ? (
          <p className="text-xs text-destructive">{connection.errorMessage}</p>
        ) : null}
        {isPendingAttempt ? (
          <p className="text-xs text-muted-foreground">
            Waiting for browser sign-in to finish…
          </p>
        ) : null}
        {notice ? (
          <p className="text-xs text-muted-foreground">{notice}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={connectPending || disconnectPending}
          onClick={() => onConnect(connection.providerId)}
        >
          {connection.status === "missing" ? "Connect" : "Reconnect"}
        </Button>
        {canDisconnect ? (
          <Button
            size="sm"
            variant="outline"
            disabled={connectPending || disconnectPending}
            onClick={() => onDisconnect(connection.providerId)}
          >
            Disconnect
          </Button>
        ) : null}
      </div>
    </div>
  );
}

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
  const [sandboxEnvForm, setSandboxEnvForm] = useState<SandboxEnvVarFormState>({
    name: "",
    value: "",
  });

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

  const startCloudAuthConnection = useMutation({
    meta: {
      errorMessage: "Failed to start cloud auth connection.",
    },
    mutationFn: (providerId: CloudAuthProviderId) =>
      api.startCloudAuthConnection(providerId),
    onSuccess: (result, providerId) => {
      setCloudAuthNotices((current) => ({
        ...current,
        [providerId]: "Opened the provider sign-in flow in your browser.",
      }));
      setActiveCloudAuthAttempt({
        attemptId: result.attemptId,
        providerId,
      });
      window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
    },
  });

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

  const saveSandboxEnvVar = useMutation({
    meta: {
      errorMessage: "Failed to save sandbox env var.",
    },
    mutationFn: () =>
      api.upsertSandboxEnvVar({
        name: sandboxEnvForm.name,
        value: sandboxEnvForm.value,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: sandboxEnvVarsQueryKey() });
      setSandboxEnvForm({
        name: "",
        value: "",
      });
    },
  });

  const deleteSandboxEnvVar = useMutation({
    meta: {
      errorMessage: "Failed to delete sandbox env var.",
    },
    mutationFn: (name: string) => api.deleteSandboxEnvVar(name),
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
    setCloudAuthNotices((current) => ({
      ...current,
      [attempt.providerId]:
        attempt.status === "completed"
          ? "Connection saved."
          : attempt.errorMessage ?? "Connection did not complete.",
    }));
    setActiveCloudAuthAttempt(null);
  }, [activeCloudAuthAttempt, activeCloudAuthStatus.data, queryClient]);

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <SettingsSection title="Appearance">
          <SettingsWithControl
            label="Theme"
            description="Choose your interface theme."
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

        {sandboxHostSupported ? (
          <>
            <SettingsSection title="Cloud Auth">
              {cloudAuthLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <div className="divide-y divide-border">
                  {(cloudAuthSettings?.connections ?? []).map((connection) => (
                    <CloudAuthRow
                      key={connection.providerId}
                      activeAttemptProviderId={activeCloudAuthAttempt?.providerId ?? null}
                      connection={connection}
                      connectPending={startCloudAuthConnection.isPending}
                      disconnectPending={disconnectCloudAuth.isPending}
                      notice={cloudAuthNotices[connection.providerId] ?? null}
                      onConnect={(providerId) => startCloudAuthConnection.mutate(providerId)}
                      onDisconnect={(providerId) => disconnectCloudAuth.mutate(providerId)}
                    />
                  ))}
                </div>
              )}
            </SettingsSection>

            <SettingsSection title="Sandbox Env Vars">
              <SettingsWithControl
                label="Global runtime env"
                description="These encrypted values are injected into cloud sandboxes and stay masked after save."
              >
                <div className="w-full space-y-3">
                  {sandboxEnvLoading ? (
                    <p className="text-sm text-muted-foreground">Loading…</p>
                  ) : (sandboxEnvVars?.envVars.length ?? 0) === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No custom sandbox env vars saved.
                    </p>
                  ) : (
                    <div className="divide-y divide-border rounded-md border border-border">
                      {sandboxEnvVars?.envVars.map((envVar) => (
                        <div
                          key={envVar.name}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium">{envVar.name}</p>
                            <p className="text-xs text-muted-foreground">
                              Value saved · Updated {timeAgo(envVar.updatedAt)}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={deleteSandboxEnvVar.isPending}
                            onClick={() => deleteSandboxEnvVar.mutate(envVar.name)}
                          >
                            Delete
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <Input
                      aria-label="Sandbox env var name"
                      placeholder="VARIABLE_NAME"
                      value={sandboxEnvForm.name}
                      onChange={(event) =>
                        setSandboxEnvForm((current) => ({
                          ...current,
                          name: event.target.value,
                        }))}
                    />
                    <Input
                      aria-label="Sandbox env var value"
                      placeholder="Value"
                      type="password"
                      value={sandboxEnvForm.value}
                      onChange={(event) =>
                        setSandboxEnvForm((current) => ({
                          ...current,
                          value: event.target.value,
                        }))}
                    />
                    <Button
                      disabled={
                        saveSandboxEnvVar.isPending
                        || sandboxEnvForm.name.trim() === ""
                      }
                      onClick={() => saveSandboxEnvVar.mutate()}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              </SettingsWithControl>
            </SettingsSection>
          </>
        ) : null}

        <SettingsSection title="Hosts">
          {hostsLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : hosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No registered hosts.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {hosts.map((host) => {
                const isConnected = host.status === "connected";
                return (
                  <div
                    key={host.id}
                    className="flex items-center gap-3 py-2 text-sm first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {host.name}
                      <span className="ml-1.5 text-xs text-muted-foreground">{host.id}</span>
                    </span>
                    {isConnected ? (
                      <span
                        className={`size-2 shrink-0 rounded-full ring-1 ring-inset transition-all ${CONNECTED_DOT_CLASS}`}
                        title="Connected"
                      />
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
                  </div>
                );
              })}
            </div>
          )}
        </SettingsSection>
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
