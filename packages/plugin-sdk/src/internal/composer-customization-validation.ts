import type {
  ComposerCustomization,
  PluginComposerThreadRowStatus,
} from "@get-bb/plugin-sdk";

export const PLUGIN_SLOT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const PLUGIN_MESSAGE_DIRECTIVE_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

type RejectionReporter = (reason: string) => void;

/**
 * Parse the runtime value handed to
 * `PluginContentScriptContext.experimental_setThreadRowStatus`. `undefined`
 * means the value was rejected; `null` remains the explicit clear operation.
 */
export function normalizePluginThreadRowStatus(
  value: unknown,
  onRejected: RejectionReporter,
): PluginComposerThreadRowStatus | null | undefined {
  const kind = "contentScript.experimental_setThreadRowStatus";
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    onRejected(`${kind}: status must be null or a non-array object`);
    return undefined;
  }

  const status = value as Record<string, unknown>;
  const icon = status.icon;
  if (typeof icon !== "string" || icon.trim() === "") {
    onRejected(`${kind}: "icon" must be a non-blank string`);
    return undefined;
  }
  const label = status.label;
  if (typeof label !== "string" || label.trim() === "") {
    onRejected(`${kind}: "label" must be a non-blank string`);
    return undefined;
  }
  const tone = status.tone;
  if (
    tone !== undefined &&
    tone !== "default" &&
    tone !== "running" &&
    tone !== "success" &&
    tone !== "error"
  ) {
    onRejected(
      `${kind}: "tone" must be "default", "running", "success", or "error" when set`,
    );
    return undefined;
  }

  return {
    icon: icon.trim(),
    label: label.trim(),
    ...(tone !== undefined ? { tone } : {}),
  };
}

export function requireSlotId(kind: string, value: unknown): string {
  if (typeof value !== "string" || !PLUGIN_SLOT_ID_PATTERN.test(value)) {
    throw new Error(
      `${kind}: "id" must match ${String(PLUGIN_SLOT_ID_PATTERN)}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function requireEnvironmentProviderId(
  kind: string,
  value: unknown,
): string {
  if (typeof value !== "string" || !PLUGIN_SLOT_ID_PATTERN.test(value)) {
    throw new Error(
      `${kind}: "environmentProviderId" must match ${String(PLUGIN_SLOT_ID_PATTERN)}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Provider ids follow the same character rules as slot ids, but they name a
 * provider the host knows (`codex`, `acp-cursor`), not a per-plugin slot.
 */
export function requireProviderId(kind: string, value: unknown): string {
  if (typeof value !== "string" || !PLUGIN_SLOT_ID_PATTERN.test(value)) {
    throw new Error(
      `${kind}: "providerId" must match ${String(PLUGIN_SLOT_ID_PATTERN)}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * A timeline renderer kind: `"tool"` (the plugin's providers' generic tool
 * items) or a namespaced extension kind `"<pluginId>/<name>"` (lowercase
 * letters, digits and `-` on both sides, the grammar of
 * `extensionKindSchema`). Ownership of the namespace is enforced by the host
 * against the loading plugin's id, which the collector does not know.
 */
export const PLUGIN_TIMELINE_RENDERER_KIND_PATTERN =
  /^(tool|[a-z0-9-]+\/[a-z0-9-]+)$/u;

export function requireTimelineRendererKind(
  kind: string,
  value: unknown,
): string {
  if (
    typeof value !== "string" ||
    !PLUGIN_TIMELINE_RENDERER_KIND_PATTERN.test(value)
  ) {
    throw new Error(
      `${kind}: "kind" must be "tool" or "<pluginId>/<name>" (lowercase letters, digits, "-"), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function requireMessageDirectiveId(
  kind: string,
  value: unknown,
): string {
  if (
    typeof value !== "string" ||
    !PLUGIN_MESSAGE_DIRECTIVE_ID_PATTERN.test(value)
  ) {
    throw new Error(
      `${kind}: "id" must match ${String(PLUGIN_MESSAGE_DIRECTIVE_ID_PATTERN)}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function requireNonEmptyString(
  kind: string,
  field: string,
  value: unknown,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${kind}: "${field}" must be a non-empty string`);
  }
  return value;
}

export function requireOptionalString(
  kind: string,
  field: string,
  value: unknown,
): string | undefined {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${kind}: "${field}" must be a string when set`);
  }
  return value;
}

export function requireComponent<T>(kind: string, value: unknown): T {
  if (typeof value !== "function") {
    throw new Error(`${kind}: "component" must be a React component function`);
  }
  return value as T;
}

function requireFunction<T>(kind: string, field: string, value: unknown): T {
  if (typeof value !== "function") {
    throw new Error(`${kind}: "${field}" must be a function`);
  }
  return value as T;
}

export function requireUniqueId(
  kind: string,
  seen: Set<string>,
  id: string,
): void {
  if (seen.has(id)) {
    throw new Error(`${kind}: duplicate id "${id}"`);
  }
  seen.add(id);
}

function parseContributionArray<T extends { id: string }>(
  kind: string,
  value: unknown,
  onRejected: RejectionReporter,
  parse: (entryKind: string, value: unknown) => T,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    onRejected(`${kind}: must be an array when set`);
    return undefined;
  }
  const seenIds = new Set<string>();
  const parsed: T[] = [];
  for (const [index, entry] of value.entries()) {
    const entryKind = `${kind}[${index}]`;
    try {
      const parsedEntry = parse(entryKind, entry);
      requireUniqueId(entryKind, seenIds, parsedEntry.id);
      parsed.push(parsedEntry);
    } catch (error) {
      onRejected(error instanceof Error ? error.message : String(error));
    }
  }
  return parsed;
}

function parseRegions(
  kind: string,
  registration: Record<string, unknown>,
  onRejected: RejectionReporter,
): Pick<
  ComposerCustomization,
  "actions" | "banners" | "plusMenu" | "richText"
> {
  const actions = parseContributionArray<
    NonNullable<ComposerCustomization["actions"]>[number]
  >(`${kind}.actions`, registration.actions, onRejected, (entryKind, value) => {
    const entry = value as Record<string, unknown> | null;
    return {
      id: requireSlotId(entryKind, entry?.id),
      component: requireComponent(entryKind, entry?.component),
    };
  });
  const banners = parseContributionArray<
    NonNullable<ComposerCustomization["banners"]>[number]
  >(`${kind}.banners`, registration.banners, onRejected, (entryKind, value) => {
    const entry = value as Record<string, unknown> | null;
    const id = requireSlotId(entryKind, entry?.id);
    const chrome = entry?.chrome;
    if (chrome !== undefined && chrome !== "card" && chrome !== "bare") {
      throw new Error(
        `${entryKind}: "chrome" must be "card" or "bare" when set`,
      );
    }
    return {
      id,
      ...(chrome !== undefined ? { chrome } : {}),
      component: requireComponent(entryKind, entry?.component),
    };
  });
  const plusMenu = parseContributionArray<
    NonNullable<ComposerCustomization["plusMenu"]>[number]
  >(
    `${kind}.plusMenu`,
    registration.plusMenu,
    onRejected,
    (entryKind, value) => {
      const entry = value as Record<string, unknown> | null;
      const id = requireSlotId(entryKind, entry?.id);
      const icon = requireOptionalString(entryKind, "icon", entry?.icon);
      const description = requireOptionalString(
        entryKind,
        "description",
        entry?.description,
      );
      const disabled = entry?.disabled;
      if (
        disabled !== undefined &&
        typeof disabled !== "boolean" &&
        typeof disabled !== "function"
      ) {
        throw new Error(
          `${entryKind}: "disabled" must be a boolean or function when set`,
        );
      }
      return {
        id,
        label: requireNonEmptyString(entryKind, "label", entry?.label),
        ...(icon !== undefined ? { icon } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(disabled !== undefined
          ? {
              disabled: disabled as NonNullable<
                NonNullable<
                  ComposerCustomization["plusMenu"]
                >[number]["disabled"]
              >,
            }
          : {}),
        run: requireFunction<
          NonNullable<ComposerCustomization["plusMenu"]>[number]["run"]
        >(entryKind, "run", entry?.run),
      };
    },
  );

  let richText: ComposerCustomization["richText"];
  if (registration.richText !== undefined) {
    const raw = registration.richText as Record<string, unknown> | null;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      onRejected(`${kind}.richText: must be an object when set`);
    } else {
      const effects = parseContributionArray<
        NonNullable<
          NonNullable<ComposerCustomization["richText"]>["effects"]
        >[number]
      >(
        `${kind}.richText.effects`,
        raw.effects,
        onRejected,
        (entryKind, value) => {
          const entry = value as Record<string, unknown> | null;
          return {
            id: requireSlotId(entryKind, entry?.id),
            match: requireFunction<
              NonNullable<
                NonNullable<ComposerCustomization["richText"]>["effects"]
              >[number]["match"]
            >(entryKind, "match", entry?.match),
            className: requireNonEmptyString(
              entryKind,
              "className",
              entry?.className,
            ),
          };
        },
      );
      const onDraftChange = raw.onDraftChange;
      if (onDraftChange !== undefined && typeof onDraftChange !== "function") {
        onRejected(
          `${kind}.richText: "onDraftChange" must be a function when set`,
        );
      }
      richText = {
        ...(effects !== undefined ? { effects } : {}),
        ...(typeof onDraftChange === "function"
          ? {
              onDraftChange: onDraftChange as NonNullable<
                ComposerCustomization["richText"]
              >["onDraftChange"],
            }
          : {}),
      };
    }
  }

  return {
    ...(actions !== undefined ? { actions } : {}),
    ...(banners !== undefined ? { banners } : {}),
    ...(plusMenu !== undefined ? { plusMenu } : {}),
    ...(richText !== undefined ? { richText } : {}),
  };
}

/**
 * Validate one registration while isolating composer customization failures.
 * The host and test harness inject their own rejection reporters.
 */
export function collectComposerCustomization(
  registration: unknown,
  seenIds: Set<string>,
  onRejected: RejectionReporter,
): ComposerCustomization | null {
  const kind = "composer.customize";
  try {
    const raw = registration as Record<string, unknown> | null;
    const id = requireSlotId(kind, raw?.id);
    const scopes = raw?.scopes;
    if (scopes !== undefined) {
      if (!Array.isArray(scopes)) {
        throw new Error(`${kind}: "scopes" must be an array when set`);
      }
      for (const scope of scopes) {
        if (
          scope !== "thread" &&
          scope !== "queued-message" &&
          scope !== "side-chat" &&
          scope !== "new-thread"
        ) {
          throw new Error(
            `${kind}: invalid scope kind ${JSON.stringify(scope)}`,
          );
        }
      }
    }
    requireUniqueId(kind, seenIds, id);
    return {
      id,
      ...(scopes !== undefined ? { scopes: [...scopes] } : {}),
      ...parseRegions(`${kind}(${id})`, raw ?? {}, onRejected),
    };
  } catch (error) {
    onRejected(error instanceof Error ? error.message : String(error));
    return null;
  }
}
