import { useEffect, useMemo } from "react";
import type { ExperimentalPermissionModePickerProps } from "@get-bb/plugin-sdk";
import { PermissionModePicker } from "@/components/pickers/PermissionModePicker";
import { useThreadCreationOptions } from "@/hooks/useThreadCreationOptions";
import { resolvePluginExecutionRouting } from "./plugin-execution-routing";

export function PluginPermissionModePicker({
  providerId,
  value,
  onChange,
  routing,
  align = "end",
  disabled,
  className,
}: ExperimentalPermissionModePickerProps) {
  const resolvedRouting = useMemo(
    () => resolvePluginExecutionRouting(routing),
    [routing],
  );
  const controlledKey = `${resolvedRouting.key}\0${providerId}\0${value}`;
  const controller = useThreadCreationOptions({
    scope: "component-local",
    initialProviderId: providerId,
    initialPermissionMode: value,
    resetKey: controlledKey,
    resolveProviderRouting: () => resolvedRouting.query,
  });
  const providerMatches =
    providerId.length > 0 && controller.selectedProviderId === providerId;

  useEffect(() => {
    if (
      providerMatches &&
      controller.permissionModeIsVerified &&
      controller.permissionMode !== value
    ) {
      onChange(controller.permissionMode);
    }
  }, [
    controller.permissionMode,
    controller.permissionModeIsVerified,
    onChange,
    providerMatches,
    value,
  ]);

  if (!providerMatches) return null;

  return (
    <PermissionModePicker
      value={controller.permissionMode}
      options={controller.permissionModeOptions}
      onChange={onChange}
      supported={controller.permissionModeOptions.length > 0}
      showWhenSingleOption
      align={align}
      disabled={disabled || !controller.permissionModeIsVerified}
      className={className}
    />
  );
}
