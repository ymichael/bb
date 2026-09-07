import type { CSSProperties, ComponentType } from "react";
import { createElement, useSyncExternalStore } from "react";
import { isPresentationTintColor, type ProviderInfo } from "@bb/domain";
import { Icon, ICON_NAMES, type IconName } from "@bb/shared-ui/icon";
import { getPluginSlotSnapshot, subscribePluginSlots } from "./plugin-slots";

interface ProviderIconInfo {
  icon: ComponentType<{ className?: string }>;
  ariaLabel: string;
}

const GenericAcpIcon: ComponentType<{ className?: string }> = ({ className }) =>
  createElement(Icon, { name: "Code", className, "aria-hidden": "true" });

const ACP_FAMILY = "acp";

interface ProviderIconSource {
  logoUrl: string | null;
  icon?: { glyph: string };
  family?: string;
  displayName?: string;
}

function isIconName(name: string): name is IconName {
  return (ICON_NAMES as readonly string[]).includes(name);
}

const declaredGlyphIcons = new Map<
  string,
  ComponentType<{ className?: string }>
>();

function getDeclaredGlyphIcon(
  glyph: string,
): ComponentType<{ className?: string }> | undefined {
  if (!isIconName(glyph)) {
    return undefined;
  }
  const cached = declaredGlyphIcons.get(glyph);
  if (cached !== undefined) {
    return cached;
  }
  const GlyphIcon: ComponentType<{ className?: string }> = ({ className }) =>
    createElement(Icon, { name: glyph, className, "aria-hidden": "true" });
  declaredGlyphIcons.set(glyph, GlyphIcon);
  return GlyphIcon;
}

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

const configuredProviderLogoIcons = new Map<
  string,
  ComponentType<{ className?: string }>
>();

function getConfiguredProviderLogoIcon(
  providerId: string,
  logoUrl: string,
  family: string | undefined,
): ComponentType<{ className?: string }> {
  const cacheKey = `${providerId}\0${logoUrl}\0${family ?? ""}`;
  const cached = configuredProviderLogoIcons.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const ProviderLogoIcon: ComponentType<{ className?: string }> = ({
    className,
  }) =>
    createElement("span", {
      "aria-hidden": "true",
      className: `${className ?? ""} inline-block shrink-0 bg-current`.trim(),
      "data-provider-logo": logoUrl,
      style: providerLogoMaskStyle(logoUrl),
    });
  configuredProviderLogoIcons.set(cacheKey, ProviderLogoIcon);
  return ProviderLogoIcon;
}

function getRegisteredPluginProviderIcon(
  providerId: string,
): ComponentType<{ className?: string }> | undefined {
  return getPluginSlotSnapshot().providerIcons.find(
    (slot) => slot.providerId === providerId,
  )?.icon;
}

const pluginAwareProviderIcons = new Map<
  string,
  ComponentType<{ className?: string }>
>();

function getPluginAwareProviderIcon(
  providerId: string,
  source: ProviderIconSource,
  staticIcon: ComponentType<{ className?: string }> | undefined,
): ComponentType<{ className?: string }> {
  const cacheKey = `${providerId}\0${source.logoUrl ?? ""}\0${source.icon?.glyph ?? ""}\0${source.family ?? ""}`;
  const cached = pluginAwareProviderIcons.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const ProviderIcon: ComponentType<{ className?: string }> = ({
    className,
  }) => {
    "use no memo";
    const pluginIcon = useSyncExternalStore(subscribePluginSlots, () =>
      getRegisteredPluginProviderIcon(providerId),
    );
    const ResolvedIcon = pluginIcon ?? staticIcon;
    return ResolvedIcon === undefined
      ? null
      : createElement(ResolvedIcon, { className });
  };
  pluginAwareProviderIcons.set(cacheKey, ProviderIcon);
  return ProviderIcon;
}

export function getProviderIconInfo(
  providerId: string,
  source: ProviderIconSource | null = null,
): ProviderIconInfo | undefined {
  const resolvedSource = source ?? { logoUrl: null };
  const staticInfo = resolveStaticProviderIconInfo(providerId, resolvedSource);
  const pluginIcon = getRegisteredPluginProviderIcon(providerId);
  if (staticInfo === undefined && pluginIcon === undefined) {
    return undefined;
  }
  return {
    icon: getPluginAwareProviderIcon(
      providerId,
      resolvedSource,
      staticInfo?.icon,
    ),
    ariaLabel:
      resolvedSource.displayName ?? staticInfo?.ariaLabel ?? providerId,
  };
}

function resolveStaticProviderIconInfo(
  providerId: string,
  source: ProviderIconSource,
): ProviderIconInfo | undefined {
  if (source.logoUrl !== null) {
    return {
      icon: getConfiguredProviderLogoIcon(
        providerId,
        source.logoUrl,
        source.family,
      ),
      ariaLabel: "Provider logo",
    };
  }

  const glyphIcon =
    source.icon === undefined
      ? undefined
      : getDeclaredGlyphIcon(source.icon.glyph);
  if (glyphIcon !== undefined) {
    return { icon: glyphIcon, ariaLabel: "Provider icon" };
  }

  if (source.family === ACP_FAMILY) {
    return { icon: GenericAcpIcon, ariaLabel: "ACP provider" };
  }

  return undefined;
}

export function getProviderIconTintStyle(
  provider: Pick<ProviderInfo, "strings"> | undefined,
): CSSProperties | undefined {
  const tint = provider?.strings?.iconTint;
  if (
    tint === undefined ||
    !isPresentationTintColor(tint.light) ||
    !isPresentationTintColor(tint.dark)
  ) {
    return undefined;
  }
  return { color: `light-dark(${tint.light.trim()}, ${tint.dark.trim()})` };
}
