import type { SystemMachineProvider } from "@bb/server-contract";
import { Icon } from "@bb/shared-ui/icon";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { pluginIconName } from "./PluginIcon";

export function MachineProviderIcon({
  provider,
  className,
}: {
  provider: SystemMachineProvider;
  className?: string;
}) {
  if (provider.icon === null) return null;
  const info = getProviderIconInfo(provider.id, {
    logoUrl: provider.logoUrl,
    displayName: provider.displayName,
    icon: { glyph: provider.icon },
  });
  const ProviderIcon = info?.icon;
  return ProviderIcon === undefined ? (
    <Icon name={pluginIconName(provider.icon)} className={className} />
  ) : (
    <ProviderIcon className={className} />
  );
}
