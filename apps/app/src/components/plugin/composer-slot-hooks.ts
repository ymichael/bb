import { useMemo, useSyncExternalStore } from "react";
import type { PluginComposerScope } from "@get-bb/plugin-sdk";
import {
  resolveComposerActions,
  resolveComposerBanners,
  resolveComposerDraftObservers,
  resolveComposerEditorEffects,
  resolveComposerPlusMenuItems,
} from "@/lib/plugin-slot-resolvers";
import {
  EMPTY_PLUGIN_SLOT_SNAPSHOT,
  getPluginSlotSnapshot,
  subscribePluginSlots,
} from "@/lib/plugin-slots";

type ComposerScopeKind = PluginComposerScope["kind"] | null;

function useComposerCustomizationRegistrations() {
  return useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().composerCustomizations,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.composerCustomizations,
  );
}

export function useResolvedComposerActions(scopeKind: ComposerScopeKind) {
  const registrations = useComposerCustomizationRegistrations();
  return useMemo(
    () =>
      scopeKind === null
        ? []
        : resolveComposerActions(registrations, scopeKind),
    [registrations, scopeKind],
  );
}

export function useResolvedComposerBanners(scopeKind: ComposerScopeKind) {
  const registrations = useComposerCustomizationRegistrations();
  return useMemo(
    () =>
      scopeKind === null
        ? []
        : resolveComposerBanners(registrations, scopeKind),
    [registrations, scopeKind],
  );
}

export function useResolvedComposerPlusMenuItems(scopeKind: ComposerScopeKind) {
  const registrations = useComposerCustomizationRegistrations();
  return useMemo(
    () =>
      scopeKind === null
        ? []
        : resolveComposerPlusMenuItems(registrations, scopeKind),
    [registrations, scopeKind],
  );
}

export function useResolvedComposerEditor(scopeKind: ComposerScopeKind) {
  const registrations = useComposerCustomizationRegistrations();
  return useMemo(
    () =>
      scopeKind === null
        ? { effects: [], observers: [] }
        : {
            effects: resolveComposerEditorEffects(registrations, scopeKind),
            observers: resolveComposerDraftObservers(registrations, scopeKind),
          },
    [registrations, scopeKind],
  );
}
