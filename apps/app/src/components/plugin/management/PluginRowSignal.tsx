import type { ReactNode } from "react";
import { UPDATE_ACTION_ICON } from "@bb/domain/update-state";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import type { PluginRowSignal } from "./plugin-status";
import { isReadablePluginVersion, UPDATE_ICON_STYLE } from "./plugin-ui";

export function PluginSignalLogo({
  children,
  signal,
  onStatusClick,
}: {
  children: ReactNode;
  signal: Extract<PluginRowSignal, { kind: "status" }> | null;
  onStatusClick: () => void;
}) {
  return (
    <span className="relative flex size-6 items-center justify-center">
      {children}
      {signal ? (
        <span className="absolute -bottom-1 -right-1">
          <PluginRowSignalView
            signal={signal}
            statusPresentation="badge"
            onUpdateClick={() => {}}
            onStatusClick={onStatusClick}
          />
        </span>
      ) : null}
    </span>
  );
}

export function PluginRowSignalView({
  signal,
  onUpdateClick,
  onStatusClick,
  statusPresentation = "standalone",
}: {
  signal: PluginRowSignal;
  onUpdateClick: () => void;
  onStatusClick: () => void;
  statusPresentation?: "standalone" | "badge";
}) {
  if (signal.kind === "update") {
    const readableVersion = isReadablePluginVersion(signal.version)
      ? signal.version
      : null;
    const updateDescription =
      readableVersion === null
        ? "Update available"
        : `Update to ${readableVersion}`;
    return (
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-full"
              style={UPDATE_ICON_STYLE}
              aria-label={updateDescription}
              onClick={onUpdateClick}
            >
              <Icon name={UPDATE_ACTION_ICON} className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{updateDescription}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  const statusDescription =
    signal.detail === null ? signal.label : `${signal.label}: ${signal.detail}`;

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "shrink-0 rounded-full",
              statusPresentation === "badge"
                ? "size-4 bg-card ring-2 ring-card hover:bg-card"
                : "size-7",
              signal.tone === "error"
                ? "text-destructive hover:text-destructive"
                : "text-warning-text hover:text-warning-text",
            )}
            aria-label={statusDescription}
            onClick={onStatusClick}
          >
            <Icon
              name={signal.icon}
              className={statusPresentation === "badge" ? "size-3.5" : "size-4"}
              aria-hidden
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{statusDescription}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
