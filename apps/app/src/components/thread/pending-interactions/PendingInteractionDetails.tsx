import { type ReactNode } from "react";
import {
  type PendingInteraction,
  formatPendingInteractionCommandApprovalDecision,
  summarizePendingInteractionRequestedMacOsPermissions,
  summarizePendingInteractionRequestedPermissions,
} from "@bb/domain";
import {
  DetailCard,
  DetailRow,
} from "@bb/ui-core";

interface PermissionPathListProps {
  label: string;
  paths: readonly string[];
}

function PermissionPathList({
  label,
  paths,
}: PermissionPathListProps) {
  if (paths.length === 0) {
    return null;
  }

  return (
    <DetailRow
      label={label}
      align="start"
      valueClassName="space-y-1"
    >
      {paths.map((path) => (
        <code
          key={path}
          className="block rounded bg-background/70 px-2 py-1 font-mono text-xs text-foreground"
        >
          {path}
        </code>
      ))}
    </DetailRow>
  );
}

export function renderPendingInteractionDetails(
  interaction: PendingInteraction,
): ReactNode {
  switch (interaction.payload.kind) {
    case "command_approval":
      return (
        <DetailCard className="bg-background/50">
          {interaction.payload.command ? (
            <DetailRow label="Command" align="start">
              <code className="whitespace-pre-wrap break-all font-mono text-xs text-foreground">
                {interaction.payload.command}
              </code>
            </DetailRow>
          ) : null}
          {interaction.payload.cwd ? (
            <DetailRow label="Working dir" align="start">
              <code className="break-all font-mono text-xs text-foreground">
                {interaction.payload.cwd}
              </code>
            </DetailRow>
          ) : null}
          {interaction.payload.reason ? (
            <DetailRow label="Reason" align="start">
              <span>{interaction.payload.reason}</span>
            </DetailRow>
          ) : null}
          {interaction.payload.requestedPermissions ? (
            <DetailRow label="Permissions" align="start">
              <div className="space-y-1">
                {summarizePendingInteractionRequestedPermissions(
                  interaction.payload.requestedPermissions,
                ).map((summary) => (
                  <div key={summary}>{summary}</div>
                ))}
              </div>
            </DetailRow>
          ) : null}
          {interaction.payload.availableDecisions
            .filter((decision) => typeof decision !== "string")
            .map((decision) => (
              <DetailRow
                key={formatPendingInteractionCommandApprovalDecision(decision)}
                label={
                  decision.kind === "accept_with_exec_policy_amendment"
                    ? "Exec policy amendment"
                    : "Network policy amendment"
                }
                align="start"
              >
                {decision.kind === "accept_with_exec_policy_amendment" ? (
                  <div className="space-y-1">
                    {decision.execPolicyAmendment.map((amendment) => (
                      <code
                        key={amendment}
                        className="block rounded bg-background/70 px-2 py-1 font-mono text-xs text-foreground"
                      >
                        {amendment}
                      </code>
                    ))}
                  </div>
                ) : (
                  <code className="break-all font-mono text-xs text-foreground">
                    {decision.networkPolicyAmendment.action} {decision.networkPolicyAmendment.host}
                  </code>
                )}
              </DetailRow>
            ))}
        </DetailCard>
      );
    case "file_change_approval":
      return (
        <DetailCard className="bg-background/50">
          {interaction.payload.reason ? (
            <DetailRow label="Reason" align="start">
              <span>{interaction.payload.reason}</span>
            </DetailRow>
          ) : null}
          {interaction.payload.grantRoot ? (
            <DetailRow label="Grant root" align="start">
              <code className="break-all font-mono text-xs text-foreground">
                {interaction.payload.grantRoot}
              </code>
            </DetailRow>
          ) : null}
        </DetailCard>
      );
    case "permission_request":
      return (
        <DetailCard className="bg-background/50">
          {interaction.payload.toolName ? (
            <DetailRow label="Tool">
              <span>{interaction.payload.toolName}</span>
            </DetailRow>
          ) : null}
          {interaction.payload.reason ? (
            <DetailRow label="Reason" align="start">
              <span>{interaction.payload.reason}</span>
            </DetailRow>
          ) : null}
          {interaction.payload.permissions.network?.enabled === true ? (
            <DetailRow label="Network">
              <span>Enabled</span>
            </DetailRow>
          ) : null}
          {interaction.payload.permissions.macos !== null ? (
            <DetailRow label="macOS" align="start">
              <div className="space-y-1">
                {summarizePendingInteractionRequestedMacOsPermissions(
                  interaction.payload.permissions.macos,
                ).map((summary) => (
                  <div key={summary}>{summary}</div>
                ))}
              </div>
            </DetailRow>
          ) : null}
          {interaction.payload.permissions.fileSystem ? (
            <>
              <PermissionPathList
                label="Read paths"
                paths={interaction.payload.permissions.fileSystem.read}
              />
              <PermissionPathList
                label="Write paths"
                paths={interaction.payload.permissions.fileSystem.write}
              />
            </>
          ) : null}
        </DetailCard>
      );
    case "user_input_request":
      return null;
  }
}
