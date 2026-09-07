import { reasoningLevelValues } from "@bb/domain";
import type { AvailableModel, ReasoningLevel, ServiceTier } from "@bb/domain";
import type { AcpConfigOption, AcpSessionModels } from "../wire.js";

interface RawAgentModel {
  id: string;
  displayName: string;
}

export const ACP_NATIVE_REASONING_EFFORTS: AvailableModel["supportedReasoningEfforts"] =
  [
    {
      reasoningEffort: "medium",
      description: "Reasoning effort is managed by the connected ACP agent.",
    },
  ];

export interface AcpNativeReasoningSupport {
  supportedReasoningEfforts: AvailableModel["supportedReasoningEfforts"];
  defaultReasoningEffort: ReasoningLevel;
}

interface AgentModelVariant extends RawAgentModel {
  effort: ReasoningLevel;
  effortToken: string | undefined;
  fast: boolean;
  thinking: boolean;
}

const MODEL_LINE_PATTERN = /^(\S+) - (.+)$/;
const BARE_PROVIDER_MODEL_LINE_PATTERN = /^\S+\/\S+$/;
const BULLETED_MODEL_LINE_PATTERN = /^[*-]\s+(\S+)(?:\s+\([^)]*\))?$/u;

const EFFORT_TOKENS: ReadonlyArray<readonly [string, ReasoningLevel]> = [
  ["extra-high", "xhigh"],
  ["medium", "medium"],
  ["xhigh", "xhigh"],
  ["high", "high"],
  ["low", "low"],
  ["max", "max"],
  ["none", "none"],
];

const FAST_TAIL = "-fast";
const THINKING_TOKEN = "thinking";

export interface AgentModelCatalog {
  models: AvailableModel[];
  resolveVariant(args: {
    model: string;
    reasoningLevel?: ReasoningLevel;
    serviceTier?: ServiceTier;
  }): string | undefined;
}

export function parseAgentModelLines(stdout: string): RawAgentModel[] {
  const models: RawAgentModel[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const match = MODEL_LINE_PATTERN.exec(trimmed);
    if (!match) {
      const bulletMatch = BULLETED_MODEL_LINE_PATTERN.exec(trimmed);
      if (bulletMatch) {
        const [, id] = bulletMatch;
        models.push({ id, displayName: id });
        continue;
      }
      if (BARE_PROVIDER_MODEL_LINE_PATTERN.test(trimmed)) {
        models.push({ id: trimmed, displayName: trimmed });
      }
      continue;
    }
    const [, id, displayName] = match;
    models.push({ id, displayName });
  }
  return models;
}

export function findAcpModelConfigOption(
  configOptions: readonly AcpConfigOption[] | undefined,
): AcpConfigOption | undefined {
  const options = configOptions ?? [];
  return (
    options.find((option) => option.category === "model") ??
    options.find((option) => option.id === "model")
  );
}

export function findAcpThoughtLevelConfigOption(
  configOptions: readonly AcpConfigOption[] | undefined,
): AcpConfigOption | undefined {
  return (configOptions ?? []).find(
    (option) => option.category === "thought_level",
  );
}

const ACP_NATIVE_REASONING_LEVEL_BY_VALUE: Readonly<
  Partial<Record<string, ReasoningLevel>>
> = {
  none: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  ultracode: "ultracode",
  max: "max",
  ultra: "ultra",
};

const ACP_NATIVE_REASONING_VALUE_CANDIDATES_BY_LEVEL: Readonly<
  Partial<Record<ReasoningLevel, readonly string[]>>
> = {
  none: ["none"],
  low: ["low", "minimal"],
  medium: ["medium"],
  high: ["high"],
  xhigh: ["xhigh"],
  ultracode: ["ultracode", "xhigh"],
  max: ["max", "xhigh"],
  ultra: ["ultra", "max"],
};

function acpNativeValueToReasoningLevel(
  value: string | undefined,
): ReasoningLevel | undefined {
  return value === undefined
    ? undefined
    : ACP_NATIVE_REASONING_LEVEL_BY_VALUE[value];
}

export function acpNativeReasoningLevelToValue(
  level: ReasoningLevel,
  thoughtLevelOption: AcpConfigOption,
): string | undefined {
  const candidateValues = ACP_NATIVE_REASONING_VALUE_CANDIDATES_BY_LEVEL[level];
  if (candidateValues === undefined) {
    return undefined;
  }
  const values = new Set(
    (thoughtLevelOption.options ?? []).map((o) => o.value),
  );
  return candidateValues.find((value) => values.has(value));
}

export function buildAcpNativeReasoningSupport(
  thoughtLevelOption: AcpConfigOption | undefined,
): AcpNativeReasoningSupport {
  const options = thoughtLevelOption?.options ?? [];
  const seen = new Set<ReasoningLevel>();
  const matchedValueByLevel = new Map<ReasoningLevel, string>();
  const supportedReasoningEfforts: AvailableModel["supportedReasoningEfforts"] =
    [];
  for (const option of options) {
    const level = acpNativeValueToReasoningLevel(option.value);
    if (level === undefined) {
      continue;
    }
    if (seen.has(level)) {
      const previousValue = matchedValueByLevel.get(level);
      if (previousValue !== level && option.value === level) {
        const effort = supportedReasoningEfforts.find(
          (candidate) => candidate.reasoningEffort === level,
        );
        if (effort) {
          effort.description = option.name ?? option.value;
        }
        matchedValueByLevel.set(level, option.value);
      }
      continue;
    }
    seen.add(level);
    matchedValueByLevel.set(level, option.value);
    supportedReasoningEfforts.push({
      reasoningEffort: level,
      description: option.name ?? option.value,
    });
  }
  supportedReasoningEfforts.sort(
    (a, b) =>
      reasoningLevelValues.indexOf(a.reasoningEffort) -
      reasoningLevelValues.indexOf(b.reasoningEffort),
  );
  if (supportedReasoningEfforts.length === 0) {
    return {
      supportedReasoningEfforts:
        thoughtLevelOption === undefined ? ACP_NATIVE_REASONING_EFFORTS : [],
      defaultReasoningEffort: "medium",
    };
  }
  const currentLevel = acpNativeValueToReasoningLevel(
    thoughtLevelOption?.currentValue,
  );
  const supportedLevels = supportedReasoningEfforts.map(
    (effort) => effort.reasoningEffort,
  );
  return {
    supportedReasoningEfforts,
    defaultReasoningEffort:
      currentLevel !== undefined && supportedLevels.includes(currentLevel)
        ? currentLevel
        : supportedReasoningEfforts[0].reasoningEffort,
  };
}

export function buildModelCatalogFromConfigOptions(
  modelOption: AcpConfigOption | undefined,
  reasoningByModel?: ReadonlyMap<string, AcpNativeReasoningSupport>,
): AvailableModel[] {
  const options = modelOption?.options ?? [];
  if (options.length === 0) {
    return [];
  }
  const currentValue = modelOption?.currentValue;
  const models = options.map((option, index): AvailableModel => {
    const isDefault =
      currentValue !== undefined ? option.value === currentValue : index === 0;
    const reasoning = reasoningByModel?.get(option.value) ?? {
      supportedReasoningEfforts: ACP_NATIVE_REASONING_EFFORTS,
      defaultReasoningEffort: "medium" as ReasoningLevel,
    };
    return {
      id: option.value,
      model: option.value,
      displayName: option.name ?? option.value,
      description: "",
      supportedReasoningEfforts: reasoning.supportedReasoningEfforts,
      defaultReasoningEffort: reasoning.defaultReasoningEffort,
      isDefault,
    };
  });
  return models.some((model) => model.isDefault)
    ? models
    : models.map((model, index) =>
        index === 0 ? { ...model, isDefault: true } : model,
      );
}

export function buildModelCatalogFromSessionModels(
  sessionModels: AcpSessionModels | undefined,
): AvailableModel[] {
  const availableModels = sessionModels?.availableModels ?? [];
  if (availableModels.length === 0) {
    return [];
  }
  const currentModelId = sessionModels?.currentModelId;
  const models = availableModels.map((model, index): AvailableModel => {
    const isDefault =
      currentModelId !== undefined
        ? model.modelId === currentModelId
        : index === 0;
    return {
      id: model.modelId,
      model: model.modelId,
      displayName: model.name ?? model.modelId,
      description: model.description ?? "",
      supportedReasoningEfforts: ACP_NATIVE_REASONING_EFFORTS,
      defaultReasoningEffort: "medium",
      isDefault,
    };
  });
  return models.some((model) => model.isDefault)
    ? models
    : models.map((model, index) =>
        index === 0 ? { ...model, isDefault: true } : model,
      );
}

function splitVariant(id: string): {
  familyKey: string;
  effort: ReasoningLevel;
  effortToken: string | undefined;
  fast: boolean;
  thinking: boolean;
} {
  let rest = id;
  let fast = false;
  if (rest.endsWith(FAST_TAIL)) {
    fast = true;
    rest = rest.slice(0, -FAST_TAIL.length);
  }
  let thinking = false;
  if (rest.endsWith(`-${THINKING_TOKEN}`)) {
    thinking = true;
    rest = rest.slice(0, -(THINKING_TOKEN.length + 1));
  } else if (rest.includes(`-${THINKING_TOKEN}-`)) {
    thinking = true;
    rest = rest.replace(`-${THINKING_TOKEN}-`, "-");
  }
  for (const [token, effort] of EFFORT_TOKENS) {
    if (rest.endsWith(`-${token}`)) {
      return {
        familyKey: rest.slice(0, -(token.length + 1)),
        effort,
        effortToken: token,
        fast,
        thinking,
      };
    }
  }
  return {
    familyKey: rest,
    effort: "medium",
    effortToken: undefined,
    fast,
    thinking,
  };
}

export function agentModelFamilyId(id: string): string {
  return splitVariant(id).familyKey;
}

const EFFORT_DISPLAY_WORDS: Readonly<Record<string, string>> = {
  "extra-high": "Extra High",
  medium: "Medium",
  xhigh: "Extra High",
  high: "High",
  low: "Low",
  max: "Max",
  ultra: "Ultra",
  none: "None",
};

function familyDisplayName(
  displayName: string,
  effortToken: string | undefined,
): string {
  const word = effortToken ? EFFORT_DISPLAY_WORDS[effortToken] : undefined;
  if (!word) {
    return cleanDisplayName(displayName);
  }
  return cleanDisplayName(
    displayName.replace(new RegExp(`(^|\\s)${word}(?=\\s|$)`), "$1"),
  );
}

function cleanDisplayName(name: string): string {
  return name
    .replace(/\s*\((?:NO ZDR|default|current)\)/gi, "")
    .replace(/(^|\s)(?:1M|Thinking)(?=\s|$)/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

interface VariantTier {
  normal?: string;
  fast?: string;
}

export function buildAgentModelCatalog(
  rawModels: readonly RawAgentModel[],
): AgentModelCatalog | null {
  const families = new Map<string, AgentModelVariant[]>();
  for (const raw of rawModels) {
    const { familyKey, effort, effortToken, fast, thinking } = splitVariant(
      raw.id,
    );
    const members = families.get(familyKey) ?? [];
    members.push({ ...raw, effort, effortToken, fast, thinking });
    families.set(familyKey, members);
  }
  if (families.size === 0) {
    return null;
  }

  const models: AvailableModel[] = [];
  const variantsByFamilyId = new Map<
    string,
    Map<ReasoningLevel, VariantTier>
  >();
  const defaultEffortByFamilyId = new Map<string, ReasoningLevel>();
  for (const members of families.values()) {
    const hasThinking = members.some((m) => m.thinking);
    const leveled = members.map((member) => ({
      member,
      level: member.thinking
        ? member.effort
        : hasThinking
          ? ("none" as ReasoningLevel)
          : member.effort,
    }));

    const byLevel = new Map<ReasoningLevel, VariantTier>();
    const repEffortByCell = new Map<string, ReasoningLevel>();
    for (const { member, level } of leveled) {
      const slot: keyof VariantTier = member.fast ? "fast" : "normal";
      const tier = byLevel.get(level) ?? {};
      const cellKey = `${level}:${slot}`;
      const upgradesNoneRep =
        level === "none" &&
        member.effort === "medium" &&
        repEffortByCell.get(cellKey) !== "medium";
      if (tier[slot] === undefined || upgradesNoneRep) {
        tier[slot] = member.id;
        repEffortByCell.set(cellKey, member.effort);
        byLevel.set(level, tier);
      }
    }

    const nonFast = leveled.filter((entry) => !entry.member.fast);
    const pool = nonFast.length > 0 ? nonFast : leveled;
    const defaultEntry =
      pool.find((entry) => entry.level === "medium") ??
      pool.find((entry) => entry.level !== "none") ??
      pool[0];
    const defaultVariant = defaultEntry.member;

    const levelsInLadderOrder = [...byLevel.keys()].sort(
      (a, b) =>
        reasoningLevelValues.indexOf(a) - reasoningLevelValues.indexOf(b),
    );
    const nameByLevel = new Map<ReasoningLevel, string>();
    for (const { member, level } of leveled) {
      if (!nameByLevel.has(level)) {
        nameByLevel.set(level, member.displayName);
      }
    }

    models.push({
      id: defaultVariant.id,
      model: defaultVariant.id,
      displayName: familyDisplayName(
        defaultVariant.displayName,
        defaultVariant.effortToken,
      ),
      description: "",
      supportedReasoningEfforts: levelsInLadderOrder.map((level) => ({
        reasoningEffort: level,
        description: nameByLevel.get(level) ?? "",
      })),
      defaultReasoningEffort: defaultEntry.level,
      isDefault: models.length === 0,
    });
    variantsByFamilyId.set(defaultVariant.id, byLevel);
    defaultEffortByFamilyId.set(defaultVariant.id, defaultEntry.level);
  }

  return {
    models,
    resolveVariant({ model, reasoningLevel, serviceTier }) {
      const byLevel = variantsByFamilyId.get(model);
      if (!byLevel) {
        return undefined;
      }
      const level = reasoningLevel ?? defaultEffortByFamilyId.get(model);
      const tier = level === undefined ? undefined : byLevel.get(level);
      if (!tier) {
        return undefined;
      }
      if (serviceTier === "fast" && tier.fast !== undefined) {
        return tier.fast;
      }
      return tier.normal ?? tier.fast;
    },
  };
}

interface SplitPrimaryModelsResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

export function splitPrimaryModels(
  catalogModels: readonly AvailableModel[],
  primaryModels: readonly string[],
): SplitPrimaryModelsResult {
  const primaryIds = new Set(primaryModels);
  const modelsById = new Map(catalogModels.map((model) => [model.id, model]));
  const models = primaryModels.flatMap((id) => {
    const model = modelsById.get(id);
    return model ? [model] : [];
  });
  if (models.length === 0) {
    return { models: [...catalogModels], selectedOnlyModels: [] };
  }
  const selectedOnlyModels = catalogModels.filter(
    (model) => !primaryIds.has(model.id),
  );
  if (models.some((model) => model.isDefault)) {
    return {
      models,
      selectedOnlyModels: selectedOnlyModels.map((model) =>
        model.isDefault ? { ...model, isDefault: false } : model,
      ),
    };
  }
  return {
    models: models.map((model, index) =>
      index === 0 ? { ...model, isDefault: true } : model,
    ),
    selectedOnlyModels: selectedOnlyModels.map((model) =>
      model.isDefault ? { ...model, isDefault: false } : model,
    ),
  };
}
