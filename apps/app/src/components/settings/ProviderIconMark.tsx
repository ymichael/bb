import type { ComponentType } from "react";
import type { ProviderInfo } from "@bb/domain";
import { getProviderIconTintStyle } from "@/lib/provider-icon";

interface ProviderIconMarkProps {
  provider: Pick<ProviderInfo, "id" | "strings">;
  icon: ComponentType<{ className?: string }>;
  className?: string;
}

export function ProviderIconMark({
  provider,
  icon: Mark,
  className,
}: ProviderIconMarkProps) {
  const tintStyle = getProviderIconTintStyle(provider);
  if (tintStyle === undefined) {
    return <Mark className={className} />;
  }
  return (
    <span
      className="contents"
      style={tintStyle}
      data-provider-icon-tint={provider.id}
    >
      <Mark className={className} />
    </span>
  );
}
