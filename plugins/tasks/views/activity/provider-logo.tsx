import type { CSSProperties } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { BotIcon } from "@hugeicons/core-free-icons";
import type { CommentProvider } from "../../shared/contract.js";

const AVATAR_LAYOUT_CLASS =
  "z-[1] mt-px flex size-[22px] shrink-0 items-center justify-center";
const PROVIDER_AVATAR_CLASS = `${AVATAR_LAYOUT_CLASS} rounded-full border border-border bg-secondary text-foreground`;
const FALLBACK_AVATAR_CLASS = `${AVATAR_LAYOUT_CLASS} rounded-full bg-primary text-primary-foreground outline outline-2 outline-background`;

function providerLogoMaskStyle(logoUrl: string): CSSProperties {
  const image = `url("${logoUrl.replace(/["\\]/gu, "\\$&")}")`;
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
    maskSize: "contain",
    WebkitMaskSize: "contain",
  };
}

function ProviderLogoImage({
  provider,
  logoUrl,
}: {
  provider: CommentProvider;
  logoUrl: string;
}) {
  return (
    <span
      role="img"
      aria-label={provider.name}
      className={PROVIDER_AVATAR_CLASS}
    >
      <span
        aria-hidden
        data-provider-logo={logoUrl}
        className="size-4 bg-current"
        style={providerLogoMaskStyle(logoUrl)}
      />
    </span>
  );
}

function GenericAgentAvatar({ name }: { name: string }) {
  return (
    <span role="img" aria-label={name} className={FALLBACK_AVATAR_CLASS}>
      <HugeiconsIcon icon={BotIcon} className="size-3.5" aria-hidden />
    </span>
  );
}

export function CommentProviderAvatar({
  provider,
}: {
  provider: CommentProvider | null;
}) {
  if (provider?.logoUrl != null) {
    return <ProviderLogoImage provider={provider} logoUrl={provider.logoUrl} />;
  }
  return <GenericAgentAvatar name={provider?.name ?? "Agent"} />;
}
