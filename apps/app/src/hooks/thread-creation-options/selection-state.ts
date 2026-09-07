import type { PermissionMode, ReasoningLevel, ServiceTier } from "@bb/domain";
import type {
  CreateExecutionInputSources,
  ExecutionInputFieldSource,
  ExistingThreadExecutionInputSources,
  SystemProvidersQuery,
} from "@bb/server-contract";
import type {
  StoredPermissionMode,
  StoredReasoningLevel,
  StoredServiceTier,
} from "./persisted-selection-fields";

type ThreadCreationOptionsScope = "new-thread" | "component-local";

export interface ThreadPromptSelections {
  selectedProviderId: string;
  selectedModel: string;
  serviceTier: ServiceTier | undefined;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
  environmentSelectionValue: string;
}

export type ThreadPromptField = keyof ThreadPromptSelections;

export type ScopedExecutionInputSources =
  | CreateExecutionInputSources
  | ExistingThreadExecutionInputSources;

export interface UsePromptModelReasoningOptions {
  enabled?: boolean;
  environmentId?: string;
  environmentHostId?: string;
  scope?: ThreadCreationOptionsScope;
  resetKey?: string | number | null;
  initialProviderId?: string;
  preferReadyProviderWhenUnset?: boolean;
  initialModel?: string;
  initialServiceTier?: ServiceTier;
  initialReasoningLevel?: ReasoningLevel;
  initialPermissionMode?: PermissionMode;
  initialEnvironmentSelectionValue?: string;
  preferenceProjectId?: string | null;
  resolveProviderRouting?: (
    environmentSelectionValue: string,
  ) => SystemProvidersQuery;
}

export interface UseNewThreadCreationOptions extends UsePromptModelReasoningOptions {
  scope?: "new-thread";
}

export interface UseComponentLocalCreationOptions extends UsePromptModelReasoningOptions {
  scope: "component-local";
}

interface StoredCreateExecutionValues {
  selectedProviderId: string;
  selectedModel: string;
  serviceTier: StoredServiceTier;
  reasoningLevel: StoredReasoningLevel;
  permissionMode: StoredPermissionMode;
}

interface EffectiveCreateExecutionValues {
  selectedProviderId: string;
  selectedModel: string;
  serviceTier: ServiceTier | undefined;
  reasoningLevel: ReasoningLevel;
  permissionMode: PermissionMode;
}

interface BuildExecutionInputSourcesArgs {
  effectiveValues: EffectiveCreateExecutionValues;
  forceExplicitModel?: boolean;
  initialProviderSource?: ExecutionInputFieldSource;
  scope: ThreadCreationOptionsScope;
  storedValues: StoredCreateExecutionValues;
  touchedFields: ReadonlySet<ThreadPromptField>;
}

interface SyncThreadPromptSelectionsArgs {
  currentSelections: ThreadPromptSelections;
  nextSelections: ThreadPromptSelections;
  touchedFields: ReadonlySet<ThreadPromptField>;
}

interface UpdateThreadPromptSelectionsArgs {
  currentSelections: ThreadPromptSelections;
  field: ThreadPromptField;
  value: ThreadPromptSelections[ThreadPromptField];
}

interface ResolveCreateExecutionInputSourceArgs {
  hasStoredValue: boolean;
  hasValue: boolean;
  initialSource?: ExecutionInputFieldSource;
  touched: boolean;
}

interface ResolvePermissionModeSelectionArgs {
  rawPermissionMode: PermissionMode;
  permissionModes: readonly PermissionMode[];
}

function hasValue(value: string): boolean {
  return value.length > 0;
}

function resolveCreateExecutionInputSource({
  hasStoredValue,
  hasValue,
  initialSource,
  touched,
}: ResolveCreateExecutionInputSourceArgs):
  | ExecutionInputFieldSource
  | undefined {
  if (!hasValue) {
    return undefined;
  }
  if (touched) {
    return "explicit";
  }
  if (hasStoredValue) {
    return "client-preference";
  }
  return initialSource;
}

export function getInitialThreadPromptSelections(
  options?: UsePromptModelReasoningOptions,
): ThreadPromptSelections {
  return {
    selectedProviderId: options?.initialProviderId ?? "",
    selectedModel: options?.initialModel ?? "",
    serviceTier: options?.initialServiceTier,
    reasoningLevel: options?.initialReasoningLevel ?? "medium",
    permissionMode: options?.initialPermissionMode ?? "auto",
    environmentSelectionValue: options?.initialEnvironmentSelectionValue ?? "",
  };
}

export function syncUntouchedThreadPromptSelections({
  currentSelections,
  nextSelections,
  touchedFields,
}: SyncThreadPromptSelectionsArgs): ThreadPromptSelections {
  let changed = false;
  const updatedSelections = { ...currentSelections };

  if (
    !touchedFields.has("selectedProviderId") &&
    currentSelections.selectedProviderId !== nextSelections.selectedProviderId
  ) {
    updatedSelections.selectedProviderId = nextSelections.selectedProviderId;
    changed = true;
  }
  if (
    !touchedFields.has("selectedModel") &&
    currentSelections.selectedModel !== nextSelections.selectedModel
  ) {
    updatedSelections.selectedModel = nextSelections.selectedModel;
    changed = true;
  }
  if (
    !touchedFields.has("serviceTier") &&
    currentSelections.serviceTier !== nextSelections.serviceTier
  ) {
    updatedSelections.serviceTier = nextSelections.serviceTier;
    changed = true;
  }
  if (
    !touchedFields.has("reasoningLevel") &&
    currentSelections.reasoningLevel !== nextSelections.reasoningLevel
  ) {
    updatedSelections.reasoningLevel = nextSelections.reasoningLevel;
    changed = true;
  }
  if (
    !touchedFields.has("permissionMode") &&
    currentSelections.permissionMode !== nextSelections.permissionMode
  ) {
    updatedSelections.permissionMode = nextSelections.permissionMode;
    changed = true;
  }
  if (
    !touchedFields.has("environmentSelectionValue") &&
    currentSelections.environmentSelectionValue !==
      nextSelections.environmentSelectionValue
  ) {
    updatedSelections.environmentSelectionValue =
      nextSelections.environmentSelectionValue;
    changed = true;
  }

  return changed ? updatedSelections : currentSelections;
}

export function updateThreadPromptSelections({
  currentSelections,
  field,
  value,
}: UpdateThreadPromptSelectionsArgs): ThreadPromptSelections {
  if (currentSelections[field] === value) {
    return currentSelections;
  }

  return {
    ...currentSelections,
    [field]: value,
  };
}

export function buildExecutionInputSources({
  effectiveValues,
  forceExplicitModel = false,
  initialProviderSource,
  scope,
  storedValues,
  touchedFields,
}: BuildExecutionInputSourcesArgs): ScopedExecutionInputSources {
  const usesStoredValues = scope === "new-thread";
  const hasTouchedExecutionField =
    touchedFields.has("selectedProviderId") ||
    touchedFields.has("selectedModel") ||
    touchedFields.has("serviceTier") ||
    touchedFields.has("reasoningLevel") ||
    touchedFields.has("permissionMode");
  const forcesExplicitExecutionFields =
    scope === "component-local" && hasTouchedExecutionField;

  if (!usesStoredValues && scope !== "component-local") {
    return {};
  }

  const providerSource = resolveCreateExecutionInputSource({
    hasStoredValue:
      usesStoredValues &&
      hasValue(storedValues.selectedProviderId) &&
      storedValues.selectedProviderId === effectiveValues.selectedProviderId,
    hasValue: hasValue(effectiveValues.selectedProviderId),
    initialSource: initialProviderSource,
    touched: touchedFields.has("selectedProviderId"),
  });
  const modelSource = resolveCreateExecutionInputSource({
    hasStoredValue:
      usesStoredValues &&
      hasValue(storedValues.selectedModel) &&
      storedValues.selectedModel === effectiveValues.selectedModel,
    hasValue: hasValue(effectiveValues.selectedModel),
    touched:
      forceExplicitModel ||
      forcesExplicitExecutionFields ||
      touchedFields.has("selectedModel"),
  });
  const serviceTierSource = resolveCreateExecutionInputSource({
    hasStoredValue:
      usesStoredValues &&
      storedValues.serviceTier !== "" &&
      storedValues.serviceTier === effectiveValues.serviceTier,
    hasValue: effectiveValues.serviceTier !== undefined,
    touched: forcesExplicitExecutionFields || touchedFields.has("serviceTier"),
  });
  const reasoningLevelSource = resolveCreateExecutionInputSource({
    hasStoredValue: usesStoredValues && storedValues.reasoningLevel !== "",
    hasValue: hasValue(effectiveValues.reasoningLevel),
    touched:
      forcesExplicitExecutionFields || touchedFields.has("reasoningLevel"),
  });
  const permissionModeSource = resolveCreateExecutionInputSource({
    hasStoredValue: usesStoredValues && storedValues.permissionMode !== "",
    hasValue: hasValue(effectiveValues.permissionMode),
    touched:
      forcesExplicitExecutionFields || touchedFields.has("permissionMode"),
  });

  if (scope === "component-local") {
    return {
      ...(modelSource ? { model: modelSource } : {}),
      ...(serviceTierSource ? { serviceTier: serviceTierSource } : {}),
      ...(reasoningLevelSource ? { reasoningLevel: reasoningLevelSource } : {}),
      ...(permissionModeSource ? { permissionMode: permissionModeSource } : {}),
    };
  }

  return {
    ...(providerSource ? { providerId: providerSource } : {}),
    ...(modelSource ? { model: modelSource } : {}),
    ...(serviceTierSource ? { serviceTier: serviceTierSource } : {}),
    ...(reasoningLevelSource ? { reasoningLevel: reasoningLevelSource } : {}),
    ...(permissionModeSource ? { permissionMode: permissionModeSource } : {}),
  };
}

export function resolvePermissionModeSelection({
  rawPermissionMode,
  permissionModes,
}: ResolvePermissionModeSelectionArgs): PermissionMode {
  if (permissionModes.includes(rawPermissionMode)) {
    return rawPermissionMode;
  }
  if (permissionModes.includes("auto")) {
    return "auto";
  }
  if (permissionModes.includes("full")) {
    return "full";
  }
  return permissionModes[0] ?? "auto";
}

export function formatModelLabel(value: string): string {
  return value
    .split("-")
    .map((part) => {
      if (part.toLowerCase() === "gpt") return "GPT";
      if (/^\d+(\.\d+)*$/.test(part)) return part;
      if (/^[a-z]+$/i.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      return part;
    })
    .join("-");
}
