
import type { Personality } from "../Personality.js";
import type { JsonValue } from "../serde_json/JsonValue.js";
import type { ApprovalsReviewer } from "./ApprovalsReviewer.js";
import type { AskForApproval } from "./AskForApproval.js";
import type { SandboxMode } from "./SandboxMode.js";
import type { ThreadSource } from "./ThreadSource.js";
import type { ThreadStartSource } from "./ThreadStartSource.js";

export type ThreadStartParams = {model?: string | null, modelProvider?: string | null, serviceTier?: string | null | null, cwd?: string | null, approvalPolicy?: AskForApproval | null,

approvalsReviewer?: ApprovalsReviewer | null, sandbox?: SandboxMode | null, config?: { [key in string]?: JsonValue } | null, serviceName?: string | null, baseInstructions?: string | null, developerInstructions?: string | null, personality?: Personality | null, ephemeral?: boolean | null, sessionStartSource?: ThreadStartSource | null,

threadSource?: ThreadSource | null};
