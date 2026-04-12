import type {
  PermissionEscalation,
  RuntimePermissionPolicy,
} from "@bb/domain";

export type ResolvedAdapterPermissionPolicy = RuntimePermissionPolicy;

export interface InteractiveRequestPolicyInput {
  permissionEscalation: PermissionEscalation | null;
}

export function resolveAdapterPermissionPolicy(
  input: RuntimePermissionPolicy,
): ResolvedAdapterPermissionPolicy {
  return input;
}

export function shouldAutoDenyInteractiveRequest(
  policy: InteractiveRequestPolicyInput,
): boolean {
  return policy.permissionEscalation === "deny";
}
