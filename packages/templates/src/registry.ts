import { templateDefinitions } from "./generated/templates.generated.js";

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

export interface TemplateVariables {
  codexBaseInstructions: Record<string, never>;
  codexCommitMessage: {
    diffDescription: string;
    files: string;
    patch: string;
    shortstat: string;
  };
  codexRunMetadata: {
    cleanedPrompt: string;
  };
  dockerAgentNote: Record<string, never>;
  managerAgentInstructions: {
    managerPreferencesContent: string;
    managerWorkspacePath: string;
  };
  openaiResponsesDefaultInstructions: Record<string, never>;
  threadOperationCommit: {
    commitMessageInstruction: string;
    stageInstruction: string;
    targetDescription: string;
  };
  threadOperationCommitFailureFollowUp: {
    exactCommitMessageInstruction?: string;
    errorMessage?: string;
    targetDescription: string;
  };
  threadOperationSquashMerge: {
    commitMessageInstruction: string;
    conflictInstruction: string;
    mergeBaseInstruction: string;
    prepCommitInstruction: string;
    squashMessageInstruction: string;
    targetDescription: string;
  };
  threadOperationSquashMergeCommitFailureFollowUp: {
    errorMessage?: string;
    failureInstruction: string;
  };
  threadOperationSquashMergeConflictFollowUp: {
    conflictFiles?: string;
    mergeBaseBranch: string;
  };
  worktreeAgentInstructions: Record<string, never>;
}

export type TemplateId = keyof TemplateVariables;

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
