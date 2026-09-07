
import type { ExecPolicyAmendment } from "./ExecPolicyAmendment.js";
import type { NetworkPolicyAmendment } from "./NetworkPolicyAmendment.js";

export type CommandExecutionApprovalDecision = "accept" | "acceptForSession" | { "acceptWithExecpolicyAmendment": { execpolicy_amendment: ExecPolicyAmendment, } } | { "applyNetworkPolicyAmendment": { network_policy_amendment: NetworkPolicyAmendment, } } | "decline" | "cancel";
