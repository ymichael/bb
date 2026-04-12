import type {
  PermissionEscalation,
  PermissionMode,
} from "@bb/domain";

export interface AdapterPermissionPolicyInput {
  permissionEscalation?: PermissionEscalation;
  permissionMode?: PermissionMode;
}

export type ResolvedAdapterPermissionPolicy =
  | {
      permissionEscalation: null;
      permissionMode: "full";
    }
  | {
      permissionEscalation: PermissionEscalation;
      permissionMode: "readonly" | "workspace-write";
    };

export interface InteractiveRequestPolicyInput {
  permissionEscalation?: PermissionEscalation | null;
}

export function resolveAdapterPermissionPolicy(
  input: AdapterPermissionPolicyInput | undefined,
): ResolvedAdapterPermissionPolicy {
  // Adapter calls are a runtime boundary: tests and provider-audit can invoke
  // them directly, so normalize absent policy exactly once before translation.
  const permissionMode = input?.permissionMode ?? "full";

  if (permissionMode === "full") {
    return {
      permissionEscalation: null,
      permissionMode,
    };
  }

  return {
    permissionEscalation: input?.permissionEscalation ?? "ask",
    permissionMode,
  };
}

export function shouldAutoDenyInteractiveRequest(
  policy: InteractiveRequestPolicyInput,
): boolean {
  return policy.permissionEscalation === "deny";
}
