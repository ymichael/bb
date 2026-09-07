import {
  EMPTY_PROVIDER_NATIVE_ROOTS,
  isNamespacedGlyph,
  isPluginOwnedIconPath,
} from "@bb/domain";
import type { NormalizedPluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import type {
  AvailableModel,
  ProviderComposerAction,
  ProviderExtensionKinds,
  ProviderInfo,
  ProviderOptionDescriptor,
} from "@bb/domain";
import type {
  PluginProviderDeclaration,
  PluginProviderOptionDescriptor,
  PluginProviderOptionsContext,
} from "@get-bb/plugin-sdk";
import { deriveValidatedProviderOptions } from "@get-bb/plugin-sdk/internal/host-policy";
import type {
  ProviderRegistration,
  ProviderServerCapabilities,
} from "./provider-registry.js";

const REASONING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

const DEFAULT_SERVICE_TIERS: readonly ProviderOptionDescriptor[] = [
  { id: "default", label: "Default" },
  { id: "fast", label: "Fast" },
];

function toOptionDescriptors(
  declared: readonly PluginProviderOptionDescriptor[],
): ProviderOptionDescriptor[] {
  return declared.map((option) => ({
    id: option.id,
    label: option.label,
    ...(option.description === undefined
      ? {}
      : { description: option.description }),
  }));
}

function projectReasoningLevels(
  declaration: PluginProviderDeclaration,
): ProviderOptionDescriptor[] {
  if (declaration.reasoningLevels !== undefined) {
    return toOptionDescriptors(declaration.reasoningLevels);
  }
  return declaration.capabilities.reasoningLevels.map((level) => ({
    id: level,
    label: REASONING_LEVEL_LABELS[level] ?? level,
  }));
}

function projectServiceTiers(
  declaration: PluginProviderDeclaration,
): ProviderOptionDescriptor[] | undefined {
  if (declaration.serviceTiers !== undefined) {
    return toOptionDescriptors(declaration.serviceTiers);
  }
  return declaration.capabilities.supportsServiceTier
    ? [...DEFAULT_SERVICE_TIERS]
    : undefined;
}

function projectExtensionKinds(
  pluginId: string,
  declaration: PluginProviderDeclaration,
): ProviderExtensionKinds | undefined {
  const declared = declaration.extensionKinds;
  if (declared === undefined) return undefined;
  const kinds: ProviderExtensionKinds = {};
  for (const [name, kind] of Object.entries(declared)) {
    kinds[`${pluginId}/${name}`] = {
      item: kind.item !== undefined,
      state: kind.state !== undefined,
    };
  }
  return kinds;
}

export function projectFallbackModels(
  declaration: PluginProviderDeclaration,
): AvailableModel[] {
  const fallback = declaration.models?.fallback ?? [];
  return fallback.map((model) => ({
    id: model.id,
    model: model.id,
    displayName: model.displayName,
    description: model.description,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map(
      (effort) => ({
        reasoningEffort: effort.reasoningEffort,
        description: effort.description,
      }),
    ),
    defaultReasoningEffort: model.defaultReasoningEffort,
    isDefault: model.isDefault,
  }));
}

function buildProviderLogoUrl(
  providerId: string,
  iconHash: string | null,
): string {
  const path = `/api/v1/system/providers/${providerId}/logo`;
  return iconHash === null ? path : `${path}?h=${iconHash}`;
}

export function buildPluginProviderRegistration(args: {
  available: boolean;
  pluginId: string;
  declaration: NormalizedPluginProviderDeclaration;
  iconHash: string | null;
  readSettings: () => PluginProviderOptionsContext["settings"];
}): Omit<ProviderRegistration, "pluginId" | "iconNames"> {
  const { declaration } = args;
  const { capabilities } = declaration;
  const {
    supportsThreadArchive,
    supportsThreadRename,
    supportsServiceTier,
    supportsNativeUserQuestion,
    permissionModes,
  } = capabilities;

  const composerActions: ProviderComposerAction[] = [
    { kind: "skills", trigger: "/" },
  ];
  for (const action of declaration.composerActions) {
    composerActions.push(
      action === "plan"
        ? {
            kind: "plan",
            command: { trigger: "/", name: "plan", trailingText: " " },
          }
        : {
            kind: "goal",
            command: { trigger: "/", name: "goal", trailingText: " " },
          },
    );
  }

  const strings = declaration.strings;
  const serviceTiers = projectServiceTiers(declaration);
  const extensionKinds = projectExtensionKinds(args.pluginId, declaration);

  const info: ProviderInfo = {
    id: declaration.id,
    pluginId: args.pluginId,
    displayName: declaration.displayName,
    ...(declaration.family === undefined ? {} : { family: declaration.family }),
    available: args.available,
    maintenance: { ...declaration.maintenance },
    logoUrl:
      declaration.icon !== undefined &&
      (isPluginOwnedIconPath(declaration.icon) ||
        isNamespacedGlyph(declaration.icon))
        ? buildProviderLogoUrl(declaration.id, args.iconHash)
        : null,
    ...(declaration.icon !== undefined &&
    !isPluginOwnedIconPath(declaration.icon) &&
    !isNamespacedGlyph(declaration.icon)
      ? { icon: { glyph: declaration.icon } }
      : {}),
    capabilities: {
      supportsThreadArchive,
      supportsThreadRename,
      supportsServiceTier,
      supportsNativeUserQuestion,
      permissionModes: [...permissionModes],
      supportsFork: capabilities.fork !== "none",
      supportsSessionRewind: capabilities.fork === "checkpoint",
      modelCatalogScope: declaration.models.scope,
    },
    composerActions,
    ...(strings === undefined
      ? {}
      : {
          strings: {
            signInHint: strings.signInHint,
            expiredHint: strings.expiredHint,
            installUrl: strings.installUrl,
            ...(strings.brandPrefix === undefined
              ? {}
              : { brandPrefix: strings.brandPrefix }),
            ...(strings.planModeCopy === undefined
              ? {}
              : { planModeCopy: strings.planModeCopy }),
            ...(strings.iconTint === undefined
              ? {}
              : { iconTint: { ...strings.iconTint } }),
          },
        }),
    reasoningLevels: projectReasoningLevels(declaration),
    ...(serviceTiers === undefined ? {} : { serviceTiers }),
    ...(extensionKinds === undefined ? {} : { extensionKinds }),
  };

  const serverCapabilities: ProviderServerCapabilities = {
    reasoningLevels: [...capabilities.reasoningLevels],
    fork: capabilities.fork,
    supportsManualCompaction: capabilities.supportsManualCompaction,
  };

  return {
    info,
    serverCapabilities,
    bridgeOptions: declaration.experimental_bridgeOptions ?? {},
    extensionKinds: declaration.extensionKinds ?? {},
    visibility: declaration.experimental_visibility ?? "always",
    fallbackModels: projectFallbackModels(declaration),
    envPassthrough: declaration.env?.passthrough ?? [],
    nativeSkillRoots:
      declaration.experimental_nativeSkillRoots ?? EMPTY_PROVIDER_NATIVE_ROOTS,
    nativeCommandRoots:
      declaration.experimental_nativeCommandRoots ??
      EMPTY_PROVIDER_NATIVE_ROOTS,
    resolvesNativeRoots: declaration.experimental_resolvesNativeRoots,
    deriveProviderOptions: (context) =>
      deriveValidatedProviderOptions({
        declaration,
        context: { ...context, settings: args.readSettings() },
      }),
  };
}
