import { getProjectSourceByHost } from "@bb/db";
import { isLocalPathProjectSource, PERSONAL_PROJECT_ID } from "@bb/domain";
import { z } from "zod";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import { jsonValueSchema } from "@bb/domain";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { WorkSessionDeps } from "../../types.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import {
  getNonDestroyedHostWithStatus,
  requirePublicProject,
} from "../lib/entity-lookup.js";
import {
  environmentProviderDecisionTimeoutMs,
  invokeEnvironmentProvider,
  type PluginEnvironmentProviderRecord,
} from "../plugins/plugin-environment-provider-registry.js";
import type { PluginEnvironmentProviderAvailabilityContext } from "@get-bb/plugin-sdk/environment-provider";
import { decideWithinBox } from "../threads/dispatch-hooks.js";

type Availability = SystemEnvironmentProvider["availability"];
type GitCheckoutAvailability =
  | { status: "available" }
  | { status: "unavailable"; message: string };

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

let pluginAvailabilityCache = new WeakMap<
  PluginEnvironmentProviderRecord["provider"],
  Map<string, Promise<Availability>>
>();
let emptyInputsCache = new WeakMap<
  PluginEnvironmentProviderRecord["provider"],
  Promise<boolean>
>();

export function invalidateEnvironmentProviderAvailability(): void {
  pluginAvailabilityCache = new WeakMap();
  emptyInputsCache = new WeakMap();
}

export function environmentProviderAcceptsEmptyInputs(
  record: PluginEnvironmentProviderRecord,
): Promise<boolean> {
  const cached = emptyInputsCache.get(record.provider);
  if (cached !== undefined) return cached;
  const resolved = resolveEmptyInputs(record);
  emptyInputsCache.set(record.provider, resolved);
  return resolved;
}

async function resolveEmptyInputs(
  record: PluginEnvironmentProviderRecord,
): Promise<boolean> {
  const schema = record.provider.inputs;
  if (schema === null) return true;
  const invocation = await invokeEnvironmentProvider(
    record,
    `"${record.provider.id}" environment provider empty inputs`,
    async () => schema["~standard"].validate({}),
  );
  if (!invocation.ok || invocation.value.issues !== undefined) return false;
  return jsonValueSchema.safeParse(invocation.value.value).success;
}

export function resolveEnvironmentProviderAvailability(
  deps: WorkSessionDeps,
  record: PluginEnvironmentProviderRecord,
  query: { projectId: string; hostId?: string },
): Promise<Availability> {
  return resolveAvailability(deps, record, query);
}

function resolvePluginAvailability(
  record: PluginEnvironmentProviderRecord,
  context: PluginEnvironmentProviderAvailabilityContext,
): Promise<Availability> {
  const key = JSON.stringify(context);
  let recordCache = pluginAvailabilityCache.get(record.provider);
  if (recordCache === undefined) {
    recordCache = new Map();
    pluginAvailabilityCache.set(record.provider, recordCache);
  }
  const cached = recordCache.get(key);
  if (cached !== undefined) return cached;
  const resolved = invokePluginAvailability(record, context);
  recordCache.set(key, resolved);
  return resolved;
}

async function invokePluginAvailability(
  record: PluginEnvironmentProviderRecord,
  context: PluginEnvironmentProviderAvailabilityContext,
): Promise<Availability> {
  const availability = record.provider.availability;
  if (availability === null) return { status: "available" };
  const invocation = await invokeEnvironmentProvider(
    record,
    `"${record.provider.id}" environment provider availability`,
    () =>
      decideWithinBox(
        () => Promise.resolve(availability(context)),
        environmentProviderDecisionTimeoutMs(),
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

export async function resolveGitCheckoutAvailability(
  deps: WorkSessionDeps,
  args: { hostId: string; path: string },
): Promise<GitCheckoutAvailability> {
  try {
    const inspection = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.inspect_git_source",
        path: args.path,
        remoteRefresh: "background",
      },
    });
    if (
      inspection.checkout.kind === "unknown" ||
      inspection.checkout.kind === "unborn" ||
      inspection.checkout.headSha === null
    ) {
      return {
        status: "unavailable",
        message: "This project checkout has no usable git branch.",
      };
    }
    return { status: "available" };
  } catch {
    return {
      status: "unavailable",
      message: "This project checkout could not be inspected.",
    };
  }
}

async function resolveAvailability(
  deps: WorkSessionDeps,
  record: PluginEnvironmentProviderRecord,
  query: { projectId: string; hostId?: string },
): Promise<Availability> {
  const project = requirePublicProject(deps.db, query.projectId);
  const host =
    query.hostId === undefined
      ? null
      : getNonDestroyedHostWithStatus(deps, query.hostId);
  if (query.hostId !== undefined && host === null) {
    return {
      status: "unavailable",
      message: "The selected machine is unavailable.",
    };
  }
  const requires = record.provider.requires;
  if (requires.projectless && project.id !== PERSONAL_PROJECT_ID) {
    return {
      status: "unavailable",
      message: "This environment provider is only available without a project.",
    };
  }
  const source =
    host === null ? null : getProjectSourceByHost(deps.db, project.id, host.id);
  const projectCheckout =
    source !== null && isLocalPathProjectSource(source)
      ? { path: source.path }
      : null;
  if (requires.projectCheckout && projectCheckout === null) {
    return {
      status: "unavailable",
      message: "This project has no checkout on the selected machine.",
    };
  }
  if (requires.gitCheckout) {
    if (host === null || projectCheckout === null) {
      return {
        status: "unavailable",
        message: "This project has no git checkout on the selected machine.",
      };
    }
    const availability = await resolveGitCheckoutAvailability(deps, {
      hostId: host.id,
      path: projectCheckout.path,
    });
    if (availability.status !== "available") return availability;
  }
  if (requires.gitRemote && project.gitRemoteUrl === null) {
    return {
      status: "unavailable",
      message: "This project has no git remote.",
    };
  }
  return resolvePluginAvailability(record, {
    project,
    host,
    projectCheckout,
    gitRemote: project.gitRemoteUrl,
  });
}
