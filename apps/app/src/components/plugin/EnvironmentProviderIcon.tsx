import type { SystemEnvironmentProvider } from "@bb/server-contract";
import { Icon } from "@bb/shared-ui/icon";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { pluginIconName } from "./PluginIcon";

export function EnvironmentProviderIcon({
  provider,
  className,
}: {
  provider: SystemEnvironmentProvider;
  className?: string;
}) {
  const info = getProviderIconInfo(provider.id, {
    logoUrl: provider.logoUrl,
    displayName: provider.displayName,
    ...(provider.icon === null ? {} : { icon: { glyph: provider.icon } }),
  });
  const ProviderIcon = info?.icon;
  return ProviderIcon === undefined ? (
    <Icon name={pluginIconName(provider.icon)} className={className} />
  ) : (
    <ProviderIcon className={className} />
  );
}
