import { inspectWorkflowSource, type LiteralAgentSelection } from "./parser.js";
import type { ParsedWorkflow } from "./types.js";

interface CatalogProvider {
  id: string;
  available: boolean;
}

interface CatalogModel {
  id: string;
  model: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
}

interface ModelCatalog {
  models: CatalogModel[];
  selectedOnlyModels: CatalogModel[];
  modelLoadError: { providerId: string; code: string } | null;
}

export interface WorkflowCatalogDependencies {
  listProviders(environmentId: string): Promise<CatalogProvider[]>;
  loadModels(environmentId: string, providerId: string): Promise<ModelCatalog>;
}

export interface WorkflowValidationSummary {
  valid: true;
  sourceBytes: number;
  metadata: ParsedWorkflow["metadata"];
  literalSelections: LiteralAgentSelection[];
}

function tupleDescription(selection: LiteralAgentSelection): string {
  return `${selection.provider}/${selection.model}/${selection.reasoningLevel}`;
}

export async function validateWorkflowSource(
  source: string,
  environmentId: string,
  catalog: WorkflowCatalogDependencies,
): Promise<WorkflowValidationSummary> {
  const inspected = inspectWorkflowSource(source);
  if (inspected.literalSelections.length > 0) {
    const providers = await catalog.listProviders(environmentId);
    const catalogs = new Map<string, ModelCatalog>();
    for (const selection of inspected.literalSelections) {
      const provider = providers.find(
        (candidate) => candidate.id === selection.provider,
      );
      if (provider === undefined || !provider.available) {
        throw new Error(
          `Unavailable provider for literal workflow selection ${tupleDescription(selection)}${selection.line === null ? "" : ` at line ${selection.line}`}`,
        );
      }
      let models = catalogs.get(provider.id);
      if (models === undefined) {
        try {
          models = await catalog.loadModels(environmentId, provider.id);
        } catch (error) {
          throw new Error(
            `Model-load error for provider ${provider.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        catalogs.set(provider.id, models);
      }
      if (models.modelLoadError !== null) {
        throw new Error(
          `Model-load error for provider ${provider.id}: ${models.modelLoadError.code}`,
        );
      }
      const model = models.models.find(
        (candidate) =>
          candidate.id === selection.model ||
          candidate.model === selection.model,
      );
      if (model === undefined) {
        throw new Error(
          `Model mismatch for literal workflow selection ${tupleDescription(selection)}`,
        );
      }
      if (
        !model.supportedReasoningEfforts.some(
          (effort) => effort.reasoningEffort === selection.reasoningLevel,
        )
      ) {
        throw new Error(
          `Unsupported reasoning level for literal workflow selection ${tupleDescription(selection)}`,
        );
      }
    }
  }
  return {
    valid: true,
    sourceBytes: new TextEncoder().encode(source).byteLength,
    metadata: inspected.workflow.metadata,
    literalSelections: inspected.literalSelections,
  };
}
