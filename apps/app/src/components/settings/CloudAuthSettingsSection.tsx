import type { CloudAuthProviderId } from "@bb/agent-providers";
import type {
  CloudAuthConnection,
} from "@bb/server-contract";
import { StatusPill, type StatusPillVariant } from "@bb/ui-core";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { SettingsRowList } from "@/components/settings/SettingsRow";
import { CONNECTED_DOT_CLASS } from "@/components/settings/constants";

const CLOUD_AUTH_STATUS_DISPLAY: Record<
  CloudAuthConnection["status"],
  { pillVariant: StatusPillVariant; label: string }
> = {
  connected: { pillVariant: "emphasis", label: "Connected" },
  invalid: { pillVariant: "destructive", label: "Needs attention" },
  missing: { pillVariant: "outline", label: "Not connected" },
};

type CloudAuthNoticeMap = Partial<Record<CloudAuthProviderId, string>>;

interface CloudAuthRowProps {
  activeAttemptProviderId: CloudAuthProviderId | null;
  connection: CloudAuthConnection;
  connectPending: boolean;
  disconnectPending: boolean;
  notice: string | null;
  onCancel(): void;
  onConnect(providerId: CloudAuthProviderId): void;
  onDisconnect(providerId: CloudAuthProviderId): void;
}

function CloudAuthRow({
  activeAttemptProviderId,
  connection,
  connectPending,
  disconnectPending,
  notice,
  onCancel,
  onConnect,
  onDisconnect,
}: CloudAuthRowProps) {
  const isPendingAttempt = activeAttemptProviderId === connection.providerId;
  const isConnected = connection.status === "connected";

  return (
    <div className="py-1.5 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3 text-sm">
        <span className="min-w-0 truncate">
          {connection.displayName}
          {connection.label ? (
            <span className="ml-1.5 text-xs text-muted-foreground">{connection.label}</span>
          ) : null}
        </span>
        {isConnected ? (
          <span className={CONNECTED_DOT_CLASS} title="Connected" />
        ) : isPendingAttempt ? (
          <StatusPill variant="secondary">Connecting…</StatusPill>
        ) : (
          <StatusPill variant={CLOUD_AUTH_STATUS_DISPLAY[connection.status].pillVariant}>
            {CLOUD_AUTH_STATUS_DISPLAY[connection.status].label}
          </StatusPill>
        )}
        <span className="flex-1" />
        <div className="flex shrink-0 gap-1.5">
          {isPendingAttempt ? (
            <Button
              size="sm"
              variant="destructive"
              onClick={onCancel}
            >
              Cancel
            </Button>
          ) : connection.status === "missing" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={connectPending || disconnectPending}
              onClick={() => onConnect(connection.providerId)}
            >
              Connect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={connectPending || disconnectPending}
              onClick={() => onDisconnect(connection.providerId)}
            >
              Disconnect
            </Button>
          )}
        </div>
      </div>
      {connection.errorMessage ? (
        <p className="text-xs text-destructive">{connection.errorMessage}</p>
      ) : null}
      {notice ? (
        <p className="text-xs text-muted-foreground">{notice}</p>
      ) : null}
    </div>
  );
}

interface CloudAuthSettingsSectionProps {
  activeAttemptProviderId: CloudAuthProviderId | null;
  connectPending: boolean;
  connections: CloudAuthConnection[];
  disconnectPending: boolean;
  isLoading: boolean;
  notices: CloudAuthNoticeMap;
  onCancel(): void;
  onConnect(providerId: CloudAuthProviderId): void;
  onDisconnect(providerId: CloudAuthProviderId): void;
}

export function CloudAuthSettingsSection({
  activeAttemptProviderId,
  connectPending,
  connections,
  disconnectPending,
  isLoading,
  notices,
  onCancel,
  onConnect,
  onDisconnect,
}: CloudAuthSettingsSectionProps) {
  return (
    <SettingsCard
      title="Agent Credentials"
      description="Connect your subscriptions to power agents running in a sandbox."
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <SettingsRowList>
          {connections.map((connection) => (
            <CloudAuthRow
              key={connection.providerId}
              activeAttemptProviderId={activeAttemptProviderId}
              connection={connection}
              connectPending={connectPending}
              disconnectPending={disconnectPending}
              notice={notices[connection.providerId] ?? null}
              onCancel={onCancel}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
            />
          ))}
        </SettingsRowList>
      )}
    </SettingsCard>
  );
}
