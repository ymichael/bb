import { jsonValueSchema } from "@bb/domain";
import type { SystemMachineProvider } from "@bb/server-contract";
import type { PluginMachineProviderAvailabilityContext } from "@get-bb/plugin-sdk/machine-provider";
import { z } from "zod";
import type { WorkSessionDeps } from "../../types.js";
import { decideWithinBox } from "../threads/dispatch-hooks.js";
import { requirePublicProject } from "../lib/entity-lookup.js";
import {
  invokeMachineProvider,
  machineProviderDecisionTimeoutMs,
  type PluginMachineProviderRecord,
} from "../plugins/plugin-machine-provider-registry.js";

type Availability = SystemMachineProvider["availability"];

const availabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available") }).strict(),
  z
    .object({
      status: z.literal("setup-required"),
      message: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      message: z.string().min(1).max(500),
    })
    .strict(),
]);

let availabilityCache = new WeakMap<
  PluginMachineProviderRecord["provider"],
  Map<string, Promise<Availability>>
>();
let emptyInputsCache = new WeakMap<
  PluginMachineProviderRecord["provider"],
  Promise<boolean>
>();

export function invalidateMachineProviderAvailability(): void {
  availabilityCache = new WeakMap();
  emptyInputsCache = new WeakMap();
}

export function machineProviderAcceptsEmptyInputs(
  record: PluginMachineProviderRecord,
): Promise<boolean> {
  const cached = emptyInputsCache.get(record.provider);
  if (cached !== undefined) return cached;
  const resolved = resolveEmptyInputs(record);
  emptyInputsCache.set(record.provider, resolved);
  return resolved;
}

async function resolveEmptyInputs(
  record: PluginMachineProviderRecord,
): Promise<boolean> {
  const schema = record.provider.inputs;
  if (schema === null) return true;
  const invocation = await invokeMachineProvider(
    record,
    `"${record.provider.id}" machine provider empty inputs`,
    async () => schema["~standard"].validate({}),
  );
  if (!invocation.ok || invocation.value.issues !== undefined) return false;
  return jsonValueSchema.safeParse(invocation.value.value).success;
}

export async function resolveMachineProviderAvailability(
  deps: WorkSessionDeps,
  record: PluginMachineProviderRecord,
  query: { projectId?: string },
): Promise<Availability> {
  const project =
    query.projectId === undefined
      ? null
      : requirePublicProject(deps.db, query.projectId);
  if (
    record.provider.requires.gitRemote &&
    project !== null &&
    project.gitRemoteUrl === null
  ) {
    return {
      status: "unavailable",
      message: "This project has no git remote.",
    };
  }
  const context: PluginMachineProviderAvailabilityContext = {
    project,
    gitRemote: project?.gitRemoteUrl ?? null,
  };
  const key = JSON.stringify(context);
  let providerCache = availabilityCache.get(record.provider);
  if (providerCache === undefined) {
    providerCache = new Map();
    availabilityCache.set(record.provider, providerCache);
  }
  const cached = providerCache.get(key);
  if (cached !== undefined) return cached;
  const resolved = invokeAvailability(record, context);
  providerCache.set(key, resolved);
  return resolved;
}

async function invokeAvailability(
  record: PluginMachineProviderRecord,
  context: PluginMachineProviderAvailabilityContext,
): Promise<Availability> {
  const availability = record.provider.availability;
  if (availability === null) return { status: "available" };
  const invocation = await invokeMachineProvider(
    record,
    `"${record.provider.id}" machine provider availability`,
    () =>
      decideWithinBox(
        () => Promise.resolve(availability(context)),
        machineProviderDecisionTimeoutMs(),
      ),
  );
  const failure = !invocation.ok
    ? invocation.error
    : invocation.value.ok
      ? null
      : invocation.value.error;
  if (failure !== null) {
    return {
      status: "unavailable",
      message: `Plugin "${record.pluginId}" could not determine availability: ${failure}`,
    };
  }
  if (!invocation.ok || !invocation.value.ok) {
    return {
      status: "unavailable",
      message: `Plugin "${record.pluginId}" could not determine availability.`,
    };
  }
  const parsed = availabilitySchema.safeParse(invocation.value.value);
  if (!parsed.success) {
    return {
      status: "unavailable",
      message: `Plugin "${record.pluginId}" returned an invalid availability result.`,
    };
  }
  return parsed.data;
}
