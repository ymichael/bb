import type { EnvironmentMachineSelection, JsonValue } from "@bb/domain";
import type {
  CreateThreadRequest,
  SystemEnvironmentProvider,
} from "@bb/server-contract";
import { parseEnvironmentValue } from "@/components/pickers/environment-picker-value";

interface ResolveRootComposeThreadEnvironmentArgs {
  environmentValue: string;
  projectId: string | undefined;
  environmentProviders?: readonly SystemEnvironmentProvider[];
  providerHostId?: string | null;
  providerMachine?: EnvironmentMachineSelection | null;
  providerInputs?: JsonValue | null;
}

export function resolveRootComposeThreadEnvironment(
  args: ResolveRootComposeThreadEnvironmentArgs,
): CreateThreadRequest["environment"] | null {
  if (!args.projectId) return null;
  const parsed = parseEnvironmentValue(args.environmentValue);
  if (!parsed) return null;

  if (parsed.type === "provider") {
    const provider = args.environmentProviders?.find(
      (candidate) => candidate.id === parsed.environmentProviderId,
    );
    if (provider === undefined) return null;
    const machine =
      args.providerMachine ??
      (args.providerHostId === undefined || args.providerHostId === null
        ? null
        : { type: "existing" as const, hostId: args.providerHostId });
    if (machine === null) return null;
    const inputs =
      provider.inputs === null ? null : (args.providerInputs ?? null);
    if (provider.inputs !== null && inputs === null) return null;
    return {
      type: "provider",
      environmentProviderId: provider.id,
      machine,
      inputs,
    };
  }

  if (parsed.environmentId === null) return null;
  return { type: "reuse", environmentId: parsed.environmentId };
}
