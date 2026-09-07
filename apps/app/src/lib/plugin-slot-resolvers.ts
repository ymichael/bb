import type {
  ComposerCustomization,
  ComposerPlusMenuItem,
  PluginComposerScope,
} from "@get-bb/plugin-sdk";
import type {
  PluginComposerCustomizationSlot,
  PluginFileOpenerSlot,
  PluginMessageDirectiveSlot,
  PluginPendingInteractionSlot,
  PluginTimelineRendererSlot,
} from "./plugin-slots";

type ComposerAction = NonNullable<ComposerCustomization["actions"]>[number];
type ComposerBanner = NonNullable<ComposerCustomization["banners"]>[number];
type ComposerEditorEffect = NonNullable<
  NonNullable<ComposerCustomization["richText"]>["effects"]
>[number];
type ComposerDraftObserver = NonNullable<
  NonNullable<ComposerCustomization["richText"]>["onDraftChange"]
>;

interface ResolvedComposerContribution {
  key: string;
  pluginId: string;
  customizationId: string;
  generation: number;
}

export interface ResolvedComposerAction extends ResolvedComposerContribution {
  action: ComposerAction;
}

interface ResolvedComposerBanner extends ResolvedComposerContribution {
  banner: ComposerBanner;
}

export interface ResolvedComposerPlusMenuItem extends ResolvedComposerContribution {
  item: ComposerPlusMenuItem;
}

interface ResolvedComposerEditorEffects extends ResolvedComposerContribution {
  effects: readonly ComposerEditorEffect[];
}

interface ResolvedComposerDraftObserver extends ResolvedComposerContribution {
  onDraftChange: ComposerDraftObserver;
}

function composerContributionKey(
  customization: PluginComposerCustomizationSlot,
  contributionId: string,
): string {
  return [
    customization.pluginId,
    customization.generation,
    customization.id,
    contributionId,
  ].join("/");
}

function resolvedComposerContribution(
  customization: PluginComposerCustomizationSlot,
  contributionId: string,
): ResolvedComposerContribution {
  return {
    key: composerContributionKey(customization, contributionId),
    pluginId: customization.pluginId,
    customizationId: customization.id,
    generation: customization.generation,
  };
}

function composerCustomizationApplies(
  customization: PluginComposerCustomizationSlot,
  scopeKind: PluginComposerScope["kind"],
): boolean {
  return (
    customization.scopes === undefined ||
    customization.scopes.includes(scopeKind)
  );
}

export function resolveComposerActions(
  customizations: readonly PluginComposerCustomizationSlot[],
  scopeKind: PluginComposerScope["kind"],
): readonly ResolvedComposerAction[] {
  const resolved: ResolvedComposerAction[] = [];
  for (const customization of customizations) {
    if (!composerCustomizationApplies(customization, scopeKind)) continue;
    for (const action of customization.actions ?? []) {
      resolved.push({
        ...resolvedComposerContribution(customization, action.id),
        action,
      });
    }
  }
  return resolved;
}

export function resolveComposerBanners(
  customizations: readonly PluginComposerCustomizationSlot[],
  scopeKind: PluginComposerScope["kind"],
): readonly ResolvedComposerBanner[] {
  const resolved: ResolvedComposerBanner[] = [];
  for (const customization of customizations) {
    if (!composerCustomizationApplies(customization, scopeKind)) continue;
    for (const banner of customization.banners ?? []) {
      resolved.push({
        ...resolvedComposerContribution(customization, banner.id),
        banner,
      });
    }
  }
  return resolved;
}

export function resolveComposerPlusMenuItems(
  customizations: readonly PluginComposerCustomizationSlot[],
  scopeKind: PluginComposerScope["kind"],
): readonly ResolvedComposerPlusMenuItem[] {
  const resolved: ResolvedComposerPlusMenuItem[] = [];
  for (const customization of customizations) {
    if (!composerCustomizationApplies(customization, scopeKind)) continue;
    for (const item of customization.plusMenu ?? []) {
      resolved.push({
        ...resolvedComposerContribution(customization, item.id),
        item,
      });
    }
  }
  return resolved;
}

export function resolveComposerEditorEffects(
  customizations: readonly PluginComposerCustomizationSlot[],
  scopeKind: PluginComposerScope["kind"],
): readonly ResolvedComposerEditorEffects[] {
  const resolved: ResolvedComposerEditorEffects[] = [];
  for (const customization of customizations) {
    if (!composerCustomizationApplies(customization, scopeKind)) continue;
    const effects = customization.richText?.effects;
    if (effects === undefined || effects.length === 0) continue;
    resolved.push({
      ...resolvedComposerContribution(customization, "editor-effects"),
      effects,
    });
  }
  return resolved;
}

export function resolveComposerDraftObservers(
  customizations: readonly PluginComposerCustomizationSlot[],
  scopeKind: PluginComposerScope["kind"],
): readonly ResolvedComposerDraftObserver[] {
  const resolved: ResolvedComposerDraftObserver[] = [];
  for (const customization of customizations) {
    if (!composerCustomizationApplies(customization, scopeKind)) continue;
    const onDraftChange = customization.richText?.onDraftChange;
    if (onDraftChange === undefined) continue;
    resolved.push({
      ...resolvedComposerContribution(customization, "draft-observer"),
      onDraftChange,
    });
  }
  return resolved;
}

export function resolvePendingInteraction(
  registrations: readonly PluginPendingInteractionSlot[],
  pluginId: string,
  rendererId: string,
): PluginPendingInteractionSlot | null {
  return (
    registrations.find(
      (registration) =>
        registration.pluginId === pluginId && registration.id === rendererId,
    ) ?? null
  );
}

export function resolveTimelineRenderer(
  registrations: readonly PluginTimelineRendererSlot[],
  target:
    | { kind: "extension"; extensionKind: string }
    | { kind: "tool"; providerPluginId: string | null },
): PluginTimelineRendererSlot | null {
  if (target.kind === "extension") {
    return (
      registrations.find(
        (registration) => registration.kind === target.extensionKind,
      ) ?? null
    );
  }
  if (target.providerPluginId === null) {
    return null;
  }
  return (
    registrations.find(
      (registration) =>
        registration.kind === "tool" &&
        registration.pluginId === target.providerPluginId,
    ) ?? null
  );
}

export type ResolvedMessageDirective =
  | { status: "ok"; slot: PluginMessageDirectiveSlot }
  | { status: "collision"; pluginIds: readonly string[] };

function resolveMessageDirectiveClaimants(
  claimants: readonly PluginMessageDirectiveSlot[],
): ResolvedMessageDirective | null {
  if (claimants.length === 0) return null;
  const only = claimants[0];
  if (claimants.length === 1 && only !== undefined) {
    return { status: "ok", slot: only };
  }
  return {
    status: "collision",
    pluginIds: [
      ...new Set(claimants.map((claimant) => claimant.pluginId)),
    ].sort(),
  };
}

export function resolveMessageDirectiveRegistry(
  registrations: readonly PluginMessageDirectiveSlot[],
): ReadonlyMap<string, ResolvedMessageDirective> {
  const claimantsById = new Map<string, PluginMessageDirectiveSlot[]>();
  for (const registration of registrations) {
    const claimants = claimantsById.get(registration.id);
    if (claimants === undefined) {
      claimantsById.set(registration.id, [registration]);
    } else {
      claimants.push(registration);
    }
  }

  const resolved = new Map<string, ResolvedMessageDirective>();
  for (const [id, claimants] of claimantsById) {
    const directive = resolveMessageDirectiveClaimants(claimants);
    if (directive !== null) resolved.set(id, directive);
  }
  return resolved;
}

export type ResolvedReplacement<Registration> =
  | { kind: "owner" }
  | { kind: "plugin"; registration: Registration };

const OWNER_REPLACEMENT: ResolvedReplacement<never> = { kind: "owner" };

export function resolveReplacement<Registration>(
  registrations: readonly Registration[],
  applies?: (registration: Registration) => boolean,
): ResolvedReplacement<Registration> {
  const registration =
    applies === undefined
      ? registrations[0]
      : registrations.find((candidate) => applies(candidate));
  return registration === undefined
    ? OWNER_REPLACEMENT
    : { kind: "plugin", registration };
}

export type FileOpenerOverride =
  | "builtin"
  | { pluginId: string; openerId: string };

export type FileOpenerPreferenceMap = Record<string, string>;

export const BUILT_IN_FILE_OPENER_PREFERENCE = "__builtin__";

export function getFileExtension(path: string): string | null {
  const name = path.split("/").at(-1) ?? path;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return null;
  return name.slice(dotIndex + 1).toLowerCase();
}

export function buildFileOpenerRef(opener: {
  pluginId: string;
  id: string;
}): string {
  return `${opener.pluginId}:${opener.id}`;
}

export function resolveFileOpenerReplacement(args: {
  registrations: readonly PluginFileOpenerSlot[];
  preference?: FileOpenerPreferenceMap;
  path: string;
  override?: FileOpenerOverride;
}): ResolvedReplacement<PluginFileOpenerSlot> {
  const override = args.override;
  if (override === "builtin") return OWNER_REPLACEMENT;
  if (override !== undefined) {
    return resolveReplacement(
      args.registrations,
      (candidate) =>
        candidate.pluginId === override.pluginId &&
        candidate.id === override.openerId,
    );
  }

  const extension = getFileExtension(args.path);
  if (extension === null) return OWNER_REPLACEMENT;
  const preference = args.preference?.[extension];
  if (preference === BUILT_IN_FILE_OPENER_PREFERENCE) {
    return OWNER_REPLACEMENT;
  }
  return resolveReplacement(
    args.registrations,
    (candidate) =>
      candidate.extensions.includes(extension) &&
      (preference === undefined ||
        buildFileOpenerRef(candidate) === preference),
  );
}
