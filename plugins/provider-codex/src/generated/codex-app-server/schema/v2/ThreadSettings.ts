
import type { AbsolutePathBuf } from "../AbsolutePathBuf.js";
import type { CollaborationMode } from "../CollaborationMode.js";
import type { Personality } from "../Personality.js";
import type { ReasoningEffort } from "../ReasoningEffort.js";
import type { ReasoningSummary } from "../ReasoningSummary.js";
import type { ActivePermissionProfile } from "./ActivePermissionProfile.js";
import type { ApprovalsReviewer } from "./ApprovalsReviewer.js";
import type { AskForApproval } from "./AskForApproval.js";
import type { SandboxPolicy } from "./SandboxPolicy.js";

export type ThreadSettings = {cwd: AbsolutePathBuf, approvalPolicy: AskForApproval, approvalsReviewer: ApprovalsReviewer, sandboxPolicy: SandboxPolicy, activePermissionProfile: ActivePermissionProfile | null, model: string, modelProvider: string, serviceTier: string | null, effort: ReasoningEffort | null, summary: ReasoningSummary | null, collaborationMode: CollaborationMode, personality: Personality | null};
