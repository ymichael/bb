
import type { ExternalAgentConfigImportItemTypeFailure } from "./ExternalAgentConfigImportItemTypeFailure.js";
import type { ExternalAgentConfigImportItemTypeSuccess } from "./ExternalAgentConfigImportItemTypeSuccess.js";
import type { ExternalAgentConfigMigrationItemType } from "./ExternalAgentConfigMigrationItemType.js";

export type ExternalAgentConfigImportTypeResult = { itemType: ExternalAgentConfigMigrationItemType, successes: Array<ExternalAgentConfigImportItemTypeSuccess>, failures: Array<ExternalAgentConfigImportItemTypeFailure>, };
