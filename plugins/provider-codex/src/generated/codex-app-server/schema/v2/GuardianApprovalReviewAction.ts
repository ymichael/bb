
import type { AbsolutePathBuf } from "../AbsolutePathBuf.js";
import type { GuardianCommandSource } from "./GuardianCommandSource.js";
import type { NetworkApprovalProtocol } from "./NetworkApprovalProtocol.js";
import type { RequestPermissionProfile } from "./RequestPermissionProfile.js";

export type GuardianApprovalReviewAction = { "type": "command", source: GuardianCommandSource, command: string, cwd: AbsolutePathBuf, } | { "type": "execve", source: GuardianCommandSource, program: string, argv: Array<string>, cwd: AbsolutePathBuf, } | { "type": "applyPatch", cwd: AbsolutePathBuf, files: Array<AbsolutePathBuf>, } | { "type": "networkAccess", target: string, host: string, protocol: NetworkApprovalProtocol, port: number, } | { "type": "mcpToolCall", server: string, toolName: string, connectorId: string | null, connectorName: string | null, toolTitle: string | null, } | { "type": "requestPermissions", reason: string | null, permissions: RequestPermissionProfile, };
