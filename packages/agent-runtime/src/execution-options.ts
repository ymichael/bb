import type { ProviderAdapter } from "./provider-adapter.js";
import type { AgentRuntimeExecutionOptions } from "./types.js";
import type { ProviderExecutionContext } from "./provider-adapter.js";
import { resolveAdapterPermissionPolicy } from "./shared/permission-policy.js";

interface AssertProviderSupportsExecutionOptionsArgs {
  adapter: ProviderAdapter;
  options: AgentRuntimeExecutionOptions;
  providerId: string;
}

interface ToProviderExecutionContextArgs {
  envVars: Record<string, string>;
  execOpts: AgentRuntimeExecutionOptions;
  instructions: string | undefined;
}

interface SameExecutionSettingsArgs {
  left: AgentRuntimeExecutionOptions;
  right: AgentRuntimeExecutionOptions;
}

export function assertProviderSupportsExecutionOptions(
  args: AssertProviderSupportsExecutionOptionsArgs,
): void {
  if (
    args.options.serviceTier !== undefined &&
    args.options.serviceTier !== "default" &&
    !args.adapter.capabilities.supportsServiceTier
  ) {
    throw new Error(
      `Provider "${args.providerId}" does not support service tiers.`,
    );
  }

  if (
    !args.adapter.capabilities.supportedPermissionModes.includes(
      args.options.permissionMode,
    )
  ) {
    throw new Error(
      `Provider "${args.providerId}" does not support permission mode "${args.options.permissionMode}".`,
    );
  }
}

export function sameExecutionSettings(
  args: SameExecutionSettingsArgs,
): boolean {
  return (
    args.left.model === args.right.model &&
    args.left.serviceTier === args.right.serviceTier &&
    args.left.reasoningLevel === args.right.reasoningLevel &&
    args.left.permissionMode === args.right.permissionMode &&
    args.left.permissionEscalation === args.right.permissionEscalation
  );
}

export function toProviderExecutionContext(args: ToProviderExecutionContextArgs): ProviderExecutionContext {
  const permissionPolicy = resolveAdapterPermissionPolicy(args.execOpts);
  return {
    model: args.execOpts.model,
    serviceTier: args.execOpts.serviceTier,
    reasoningLevel: args.execOpts.reasoningLevel,
    ...permissionPolicy,
    instructions: args.instructions,
    envVars: args.envVars,
  };
}
