import { atomWithStorage } from "jotai/utils";
import { createJsonLocalStorage } from "@/lib/browser-storage";
import {
  resolveReplacement,
  type ResolvedReplacement,
} from "@/lib/plugin-slot-resolvers";

export const AUTOMATIC_REPLACEMENT_PROVIDER = "__automatic__";

export const BUILT_IN_REPLACEMENT_PROVIDER = "__builtin__";

interface ReplacementProviderIdentity {
  pluginId: string;
  id: string;
}

export function replacementProviderKey(
  slot: ReplacementProviderIdentity,
): string {
  return `${slot.pluginId}/${slot.id}`;
}

export function createReplacementPreferenceAtom(storageKey: string) {
  return atomWithStorage<string>(
    storageKey,
    AUTOMATIC_REPLACEMENT_PROVIDER,
    createJsonLocalStorage<string>(),
    { getOnInit: true },
  );
}

export function resolvePreferredReplacement<
  Slot extends ReplacementProviderIdentity,
>(
  slots: readonly Slot[],
  preference: string = AUTOMATIC_REPLACEMENT_PROVIDER,
): ResolvedReplacement<Slot> {
  if (preference === BUILT_IN_REPLACEMENT_PROVIDER) return { kind: "owner" };
  return resolveReplacement(
    slots,
    preference === AUTOMATIC_REPLACEMENT_PROVIDER
      ? undefined
      : (candidate) => replacementProviderKey(candidate) === preference,
  );
}
