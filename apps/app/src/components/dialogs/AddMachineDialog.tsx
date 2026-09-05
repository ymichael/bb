import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import type { Host, JsonValue } from "@bb/domain";
import type { PluginMachineProviderInputsChange } from "@get-bb/plugin-sdk";
import type { SystemMachineProvider } from "@bb/server-contract";
import { z } from "zod";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { MachineProviderIcon } from "@/components/plugin/MachineProviderIcon";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { machineProviderInputsControlRequired } from "@/components/pickers/machine-provider-inputs";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import { useClipboardCopy } from "@/lib/clipboard";
import { isLocalOnlyUrl } from "@/lib/loopback-hostname";
import {
  getPluginConfigurationRoutePath,
  getPluginDetailRoutePath,
} from "@/lib/route-paths";
import { BbHttpError, sdk } from "@/lib/sdk";
import { getMutationErrorMessage } from "@/lib/mutation-errors";
import { usePluginSlots } from "@/lib/plugin-slots";

interface AddMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverUrl: string | null;
}

const connectMachineCodeSchema = z.object({
  code: z.string(),
  expiresAt: z.number(),
  serverUrl: z.string(),
});

const pluginRpcErrorEnvelopeSchema = z.object({
  error: z.object({ message: z.string() }),
});

type ConnectMachineCode = z.infer<typeof connectMachineCodeSchema>;

function isNotPairedRpcError(error: BbHttpError): boolean {
  const envelope = pluginRpcErrorEnvelopeSchema.safeParse(error.body);
  return envelope.success && envelope.data.error.message === "not_paired";
}

type ConnectMachineCodeResult =
  | { kind: "issued"; code: ConnectMachineCode }
  | { kind: "unpaired" }
  | { kind: "disabled" }
  | { kind: "unavailable" };

async function isConnectPluginDisabled(): Promise<boolean> {
  try {
    const { plugins } = await sdk.plugins.list();
    const connect = plugins.find((plugin) => plugin.id === "connect");
    return connect !== undefined && !connect.enabled;
  } catch {
    return false;
  }
}

async function createConnectMachineCode(): Promise<ConnectMachineCodeResult> {
  try {
    const code = await sdk.plugins.callRpc({
      pluginId: "connect",
      method: "createMachineCode",
      input: null,
      outputSchema: connectMachineCodeSchema,
    });
    return { kind: "issued", code };
  } catch (error) {
    if (!(error instanceof BbHttpError)) throw error;
    if (
      error.code === "not_paired" ||
      isNotPairedRpcError(error) ||
      error.status === 404
    ) {
      return { kind: "unpaired" };
    }
    if (error.status === 503) {
      return (await isConnectPluginDisabled())
        ? { kind: "disabled" }
        : { kind: "unavailable" };
    }
    if (error.status === 422) {
      return { kind: "unavailable" };
    }
    throw error;
  }
}

export function AddMachineDialog({
  open,
  onOpenChange,
  serverUrl,
}: AddMachineDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <AddMachineDialogContent
            onOpenChange={onOpenChange}
            serverUrl={serverUrl}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function pairingCommand(
  joinCode: string,
  hostId: string,
  machineCode: ConnectMachineCode | null,
  directServerUrl: string | null,
): string | null {
  const serverUrl = machineCode?.serverUrl ?? directServerUrl;
  if (serverUrl === null) return null;
  const machineFlag =
    machineCode === null ? "" : ` --machine-code ${machineCode.code}`;
  return `curl -fL --progress-meter --connect-timeout 10 --max-time 60 --retry 2 ${serverUrl}/install.sh | sh -s -- --join-code ${joinCode} --host-id ${hostId} --server ${serverUrl}${machineFlag}`;
}

const REMOTE_ACCESS_ROUTE = getPluginConfigurationRoutePath({
  pluginId: "connect",
});
const CONNECT_PLUGIN_ROUTE = getPluginDetailRoutePath({
  pluginId: "connect",
  view: "installed",
});

function UnreachableServerNotice({
  serverUrl,
  reason,
}: {
  serverUrl: string;
  reason: "unpaired" | "disabled";
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-2 rounded-md border border-border bg-muted/40 p-3"
    >
      <p className="text-sm text-foreground">
        Another machine cannot use this address.
      </p>
      <p className="text-xs text-subtle-foreground">
        The pairing command would target{" "}
        <span className="font-mono">{serverUrl}</span>, which points to the
        machine that runs it, not to this bb.{" "}
        {reason === "disabled"
          ? "The Connect plugin is disabled, so remote access is off. Enable it, then come back here to get a pairing command that works from anywhere."
          : "Set up remote access first, then come back here to get a pairing command that works from anywhere."}
      </p>
      <div className="flex items-center gap-2">
        <Button
          asChild
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs"
        >
          {reason === "disabled" ? (
            <Link to={CONNECT_PLUGIN_ROUTE}>Enable the Connect plugin</Link>
          ) : (
            <Link to={REMOTE_ACCESS_ROUTE}>Set up remote access</Link>
          )}
        </Button>
        <a
          href="https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-subtle-foreground underline underline-offset-2"
        >
          Other options
        </a>
      </div>
    </div>
  );
}

function AddMachineDialogContent({
  onOpenChange,
  serverUrl,
}: {
  onOpenChange: (open: boolean) => void;
  serverUrl: string | null;
}) {
  const hostsQuery = useHosts();
  const { providers: machineProviders } = useSystemMachineProviders();
  const machineProviderInputsSlots = usePluginSlots().machineProviderInputs;
  const [selectedMachineProvider, setSelectedMachineProvider] =
    useState<SystemMachineProvider | null>(null);
  const [machineInputs, setMachineInputs] = useState<JsonValue | null>(null);
  const [machineInputsBlocked, setMachineInputsBlocked] = useState<
    string | null
  >(null);
  const machineInputsRegistration =
    selectedMachineProvider === null
      ? undefined
      : machineProviderInputsSlots.find(
          (slot) =>
            slot.machineProviderId === selectedMachineProvider.id &&
            slot.pluginId === selectedMachineProvider.pluginId,
        );
  const MachineInputsComponent = machineInputsRegistration?.component;
  const selectMachineProvider = (provider: SystemMachineProvider): void => {
    setSelectedMachineProvider(provider);
    setMachineInputs(
      provider.inputs === null ? null : provider.acceptsEmptyInputs ? {} : null,
    );
    setMachineInputsBlocked(null);
  };
  const handleMachineInputsChange = (
    next: PluginMachineProviderInputsChange,
  ): void => {
    if (next.status === "blocked") {
      setMachineInputsBlocked(next.reason);
      return;
    }
    setMachineInputsBlocked(null);
    setMachineInputs(next.value);
  };
  const createMachine = useMutation({
    mutationFn: async () => {
      if (selectedMachineProvider === null) {
        throw new Error("Select a machine provider.");
      }
      return sdk.hosts.create({
        machineProviderId: selectedMachineProvider.id,
        projectId: null,
        inputs: machineInputs,
      });
    },
    onSuccess: async () => {
      await hostsQuery.refetch();
      onOpenChange(false);
    },
  });
  const mintJoinCode = useMutation({
    meta: { showErrorToast: false },
    mutationFn: async () => {
      const [join, machine] = await Promise.all([
        sdk.hosts.createJoinCode(),
        createConnectMachineCode(),
      ]);
      return { join, machine };
    },
  });
  const mint = mintJoinCode.mutate;
  useEffect(() => {
    mint();
  }, [mint]);

  const baselineHostIds = useRef<Set<string> | null>(null);
  if (baselineHostIds.current === null && hostsQuery.data !== undefined) {
    baselineHostIds.current = new Set(hostsQuery.data.map((host) => host.id));
  }
  const connectedNewHost: Host | null =
    (baselineHostIds.current !== null
      ? hostsQuery.data?.find(
          (host) =>
            host.status === "connected" &&
            !baselineHostIds.current?.has(host.id),
        )
      : undefined) ?? null;

  const joinCode = mintJoinCode.data?.join ?? null;
  const machineCodeResult = mintJoinCode.data?.machine ?? null;
  const machineCode =
    machineCodeResult?.kind === "issued" ? machineCodeResult.code : null;
  const expiresAt =
    joinCode === null
      ? null
      : Math.min(joinCode.expiresAt, machineCode?.expiresAt ?? Infinity);
  const localOnlyServerUrl =
    serverUrl !== null && isLocalOnlyUrl(serverUrl) ? serverUrl : null;
  const unreachable =
    (machineCodeResult?.kind === "unpaired" ||
      machineCodeResult?.kind === "disabled") &&
    localOnlyServerUrl !== null
      ? { serverUrl: localOnlyServerUrl, reason: machineCodeResult.kind }
      : null;
  const connectUnavailable =
    machineCodeResult?.kind === "unavailable" && localOnlyServerUrl !== null;
  const showCommand =
    joinCode !== null && unreachable === null && !connectUnavailable;

  const [now, setNow] = useState(() => Date.now());
  const hasCountdown = showCommand && expiresAt !== null;
  useEffect(() => {
    if (!hasCountdown) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasCountdown]);
  const remainingMs =
    hasCountdown && expiresAt !== null ? expiresAt - now : null;
  const expired = remainingMs !== null && remainingMs <= 0;
  const command =
    showCommand && joinCode !== null
      ? pairingCommand(
          joinCode.joinCode,
          joinCode.hostId,
          machineCode,
          serverUrl,
        )
      : null;
  const { copied, copy } = useClipboardCopy({ text: command ?? "" });

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a machine</DialogTitle>
        <DialogDescription>
          {unreachable !== null
            ? "Pair a machine to run projects and threads on it."
            : "Run this command on the machine you want to add. It installs bb and keeps the machine connected to this server."}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        {(machineProviders?.length ?? 0) > 0 ? (
          <div className="space-y-2">
            <div className="space-y-1 rounded-md border border-border p-1">
              {machineProviders?.map((provider) => {
                const unavailable =
                  provider.availability?.status === "unavailable";
                return (
                  <button
                    key={provider.id}
                    type="button"
                    disabled={unavailable}
                    onClick={() => selectMachineProvider(provider)}
                    className="flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-sm hover:bg-state-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {provider.icon === null ? null : (
                      <MachineProviderIcon
                        provider={provider}
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {provider.displayName}
                      </span>
                      {provider.availability?.status === "available" ||
                      provider.availability === null ? null : (
                        <span className="block text-xs text-muted-foreground">
                          {provider.availability.message}
                        </span>
                      )}
                    </span>
                    <Icon
                      name="Check"
                      className={cn(
                        "size-4 shrink-0",
                        selectedMachineProvider?.id === provider.id
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </button>
                );
              })}
            </div>
            {selectedMachineProvider === null ? null : (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                {machineInputsRegistration === undefined ||
                MachineInputsComponent === undefined ? null : (
                  <PluginSlotMount
                    pluginId={machineInputsRegistration.pluginId}
                    slotKind="machineProviderInputs"
                    slotId={machineInputsRegistration.machineProviderId}
                  >
                    <MachineInputsComponent
                      projectId={null}
                      value={machineInputs}
                      onChange={handleMachineInputsChange}
                    />
                  </PluginSlotMount>
                )}
                {selectedMachineProvider.availability?.status ===
                "setup-required" ? (
                  <Button asChild size="sm" variant="outline">
                    <Link
                      to={getPluginConfigurationRoutePath({
                        pluginId: selectedMachineProvider.pluginId,
                      })}
                    >
                      Configure {selectedMachineProvider.displayName}
                    </Link>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      createMachine.isPending ||
                      machineInputsBlocked !== null ||
                      (machineProviderInputsControlRequired(
                        selectedMachineProvider,
                      ) &&
                        machineInputsRegistration === undefined) ||
                      (selectedMachineProvider.inputs !== null &&
                        machineInputs === null)
                    }
                    onClick={() => createMachine.mutate()}
                  >
                    {createMachine.isPending
                      ? "Creating machine…"
                      : `Create ${selectedMachineProvider.displayName} machine`}
                  </Button>
                )}
                {machineInputsBlocked === null ? null : (
                  <p className="text-xs text-destructive">
                    {machineInputsBlocked}
                  </p>
                )}
                {createMachine.isError ? (
                  <p className="text-xs text-destructive">
                    {getMutationErrorMessage({
                      error: createMachine.error,
                      fallbackMessage: "Couldn't create the machine.",
                    })}
                  </p>
                ) : null}
              </div>
            )}
            <p className="text-xs font-medium text-muted-foreground">
              Pair your own machine
            </p>
          </div>
        ) : null}
        {mintJoinCode.isError || connectUnavailable ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">
              {connectUnavailable
                ? "Remote access isn't ready yet."
                : getMutationErrorMessage({
                    error: mintJoinCode.error,
                    fallbackMessage: "Couldn't create a join code.",
                  })}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => mintJoinCode.mutate()}
            >
              Try again
            </Button>
          </div>
        ) : unreachable !== null ? (
          <UnreachableServerNotice
            serverUrl={unreachable.serverUrl}
            reason={unreachable.reason}
          />
        ) : command !== null ? (
          <div
            data-add-machine-command
            className="overflow-hidden rounded-md border border-border bg-muted/30"
          >
            <pre className="overflow-x-auto whitespace-pre-wrap break-all p-3 font-mono text-xs text-foreground">
              {command}
            </pre>
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
              {expired ? (
                <>
                  <span className="text-xs text-subtle-foreground">
                    Code expired
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={mintJoinCode.isPending}
                    onClick={() => mintJoinCode.mutate()}
                  >
                    Generate a new code
                  </Button>
                </>
              ) : remainingMs !== null ? (
                <span className="text-xs tabular-nums text-subtle-foreground">
                  Code expires in {formatCountdown(remainingMs)}
                </span>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="ml-auto h-7 px-2.5 text-xs"
                disabled={expired}
                onClick={() => void copy()}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon name="Spinner" className="size-4 shrink-0 animate-spin" />
            Creating a join code…
          </p>
        )}
        {unreachable !== null ? null : (
          <div className="flex items-center gap-2.5 rounded-md bg-muted/40 px-3 py-2.5">
            {connectedNewHost !== null ? (
              <>
                <MachineStatusDot connected />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {connectedNewHost.name} connected
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => onOpenChange(false)}
                >
                  Set up a project on it →
                </Button>
              </>
            ) : (
              <>
                <Icon
                  name="Spinner"
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                />
                <span className="text-sm text-muted-foreground">
                  Waiting for the machine to connect…
                </span>
              </>
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
        >
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
