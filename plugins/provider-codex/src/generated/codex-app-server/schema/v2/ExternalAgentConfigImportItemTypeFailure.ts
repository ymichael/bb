
import type { ExternalAgentConfigMigrationItemType } from "./ExternalAgentConfigMigrationItemType.js";

export type ExternalAgentConfigImportItemTypeFailure = { itemType: ExternalAgentConfigMigrationItemType, errorType: string | null, subErrorType: string | null, failureStage: string, message: string, cwd: string | null, source: string | null, };
