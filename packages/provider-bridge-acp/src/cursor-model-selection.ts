import { reasoningLevelValues } from "@bb/domain";
import type { AvailableModel, ReasoningLevel } from "@bb/domain";
import { agentModelFamilyId } from "./bridge/model-catalog.js";

interface CursorParameterizedSelection {
  modelId: string;
  reasoningLevel?: ReasoningLevel;
}

const CURSOR_LEGACY_FAMILY_SELECTIONS: Readonly<
  Record<string, CursorParameterizedSelection>
> = {
  "claude-4-sonnet": { modelId: "claude-sonnet-4" },
  "claude-4.5-opus": { modelId: "claude-opus-4-5" },
  "claude-4.5-sonnet": { modelId: "claude-sonnet-4-5" },
  "claude-4.6-opus": { modelId: "claude-opus-4-6" },
  "claude-4.6-sonnet": { modelId: "claude-sonnet-4-6" },
  "gemini-3.6-flash-minimal": {
    modelId: "gemini-3.6-flash",
    reasoningLevel: "low",
  },
  "gpt-5.1-codex-max": { modelId: "gpt-5.1" },
};

function bareCursorFamilyId(model: string): string {
  const familyId = model === "auto" ? "default" : agentModelFamilyId(model);
  return familyId.startsWith("cursor-")
    ? familyId.slice("cursor-".length)
    : familyId;
}

export function cursorParameterizedSelection(
  model: string,
  reasoningLevel: ReasoningLevel | undefined,
): CursorParameterizedSelection {
  const familyId = bareCursorFamilyId(model);
  const selection = CURSOR_LEGACY_FAMILY_SELECTIONS[familyId] ?? {
    modelId: familyId,
  };
  return selection.reasoningLevel !== undefined || reasoningLevel === undefined
    ? selection
    : { ...selection, reasoningLevel };
}

function cursorCatalogModel(model: AvailableModel): {
  model: AvailableModel;
  directFamily: boolean;
} {
  const selection = cursorParameterizedSelection(
    model.id,
    model.defaultReasoningEffort,
  );
  const efforts = new Map<
    ReasoningLevel,
    AvailableModel["supportedReasoningEfforts"][number]
  >();
  for (const effort of model.supportedReasoningEfforts) {
    const level =
      cursorParameterizedSelection(model.id, effort.reasoningEffort)
        .reasoningLevel ?? effort.reasoningEffort;
    if (!efforts.has(level)) {
      efforts.set(level, { ...effort, reasoningEffort: level });
    }
  }
  return {
    model: {
      ...model,
      id: selection.modelId,
      model: selection.modelId,
      supportedReasoningEfforts: [...efforts.values()].sort(
        (a, b) =>
          reasoningLevelValues.indexOf(a.reasoningEffort) -
          reasoningLevelValues.indexOf(b.reasoningEffort),
      ),
      defaultReasoningEffort:
        selection.reasoningLevel ?? model.defaultReasoningEffort,
    },
    directFamily: bareCursorFamilyId(model.id) === selection.modelId,
  };
}

export function buildCursorParameterizedModelCatalog(
  models: readonly AvailableModel[],
): AvailableModel[] {
  const normalized = new Map<
    string,
    { model: AvailableModel; directFamily: boolean }
  >();
  for (const model of models) {
    const candidate = cursorCatalogModel(model);
    const current = normalized.get(candidate.model.id);
    if (current === undefined) {
      normalized.set(candidate.model.id, candidate);
      continue;
    }
    const preferred =
      candidate.directFamily && !current.directFamily ? candidate : current;
    const efforts = new Map(
      preferred.model.supportedReasoningEfforts.map((effort) => [
        effort.reasoningEffort,
        effort,
      ]),
    );
    for (const effort of [
      ...current.model.supportedReasoningEfforts,
      ...candidate.model.supportedReasoningEfforts,
    ]) {
      if (!efforts.has(effort.reasoningEffort)) {
        efforts.set(effort.reasoningEffort, effort);
      }
    }
    normalized.set(candidate.model.id, {
      model: {
        ...preferred.model,
        supportedReasoningEfforts: [...efforts.values()].sort(
          (a, b) =>
            reasoningLevelValues.indexOf(a.reasoningEffort) -
            reasoningLevelValues.indexOf(b.reasoningEffort),
        ),
        isDefault: current.model.isDefault || candidate.model.isDefault,
      },
      directFamily: preferred.directFamily,
    });
  }
  return [...normalized.values()].map((entry) => entry.model);
}
