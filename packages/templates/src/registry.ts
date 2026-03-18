import { templateDefinitions } from "./generated/templates.generated.js";
import type { TemplateId, TemplateVariables } from "./generated/templates.generated.js";

export type { TemplateId, TemplateVariables };

export type TemplateKind = "instruction" | "prompt" | "skill_seed";

export interface TemplateDefinition {
  body: string;
  editingNotes?: string;
  fileName: string;
  id: TemplateId;
  intent?: string;
  kind: TemplateKind;
  summary?: string;
  title?: string;
  variables: Record<string, string>;
}

export interface TemplateMetadata extends Omit<TemplateDefinition, "body"> {}

function isTemplateId(value: string): value is TemplateId {
  return templateDefinitions.some((definition) => definition.id === value);
}

function decodeTemplateDefinitions(): Record<TemplateId, TemplateDefinition> {
  const entries = templateDefinitions.map((definition) => {
    if (!isTemplateId(definition.id)) {
      throw new Error(`Unknown generated template id: ${definition.id}`);
    }
    return [
      definition.id,
      {
        ...definition,
        id: definition.id,
        kind: definition.kind as TemplateKind,
      },
    ] as const;
  });
  return Object.fromEntries(entries) as Record<TemplateId, TemplateDefinition>;
}

export const templateRegistry = decodeTemplateDefinitions();
