import {
  EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS,
  providerNativeRootsAreEmpty,
  providerResolvedNativeRootsSchema,
  type ProviderNativeRootSet,
  type ProviderResolvedNativeRoots,
} from "@bb/domain";
import type {
  HostDaemonOnlineRpcResultForCommand,
  HostDaemonRetryableOnlineRpcCommand,
} from "@bb/host-daemon-contract";
import { experimental_nativeRootsHostContract } from "@get-bb/plugin-sdk/host";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { AppDeps, WorkSessionDeps } from "../../types.js";
import {
  callHostRetryableOnlineRpc,
  hostCommandTimeoutError,
} from "../hosts/online-rpc.js";
import { callPluginHostRpc } from "../plugins/plugin-host-rpc.js";
import type { ProviderRegistration } from "./provider-registry.js";

export const PROVIDER_NATIVE_ROOTS_CACHE_TTL_MS = 10_000;

interface CacheEntry {
  pluginId: string;
  registrationRevision: number;
  expiresAt: number;
  value: Promise<ProviderResolvedNativeRoots>;
}

export interface ProviderNativeRootsCache {
  invalidate(pluginId?: string): void;
  /** @internal The cached or in-flight answer for a key, or undefined. */
  lookup(
    key: string,
    registrationRevision: number,
  ): Promise<ProviderResolvedNativeRoots> | undefined;
  /** @internal Record an in-flight answer for a key. */
  store(
    key: string,
    entry: {
      pluginId: string;
      registrationRevision: number;
      value: Promise<ProviderResolvedNativeRoots>;
    },
  ): void;
}

export function createProviderNativeRootsCache(
  options: { now?: () => number; ttlMs?: number } = {},
): ProviderNativeRootsCache {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PROVIDER_NATIVE_ROOTS_CACHE_TTL_MS;
  const entries = new Map<string, CacheEntry>();
  return {
    invalidate(pluginId) {
      if (pluginId === undefined) {
        entries.clear();
        return;
      }
      for (const [key, entry] of entries) {
        if (entry.pluginId === pluginId) entries.delete(key);
      }
    },
    lookup(key, registrationRevision) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (
        entry.registrationRevision !== registrationRevision ||
        entry.expiresAt <= now()
      ) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    store(key, entry) {
      const stored: CacheEntry = { ...entry, expiresAt: now() + ttlMs };
      entries.set(key, stored);
      const restamp = (): void => {
        if (entries.get(key) === stored) stored.expiresAt = now() + ttlMs;
      };
      void entry.value.then(restamp, restamp);
    },
  };
}

export const PROVIDER_LISTING_BUDGET_FLOOR_MS = 1_000;

export interface ProviderListingBudget {
  remainingMs(): number;
}

export function createProviderListingBudget(
  options: { totalMs?: number; now?: () => number } = {},
): ProviderListingBudget {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.totalMs ?? COMMAND_TIMEOUT_MS);
  return {
    remainingMs() {
      const remaining = deadline - now();
      if (remaining < PROVIDER_LISTING_BUDGET_FLOOR_MS) {
        throw hostCommandTimeoutError();
      }
      return remaining;
    },
  };
}

export type ProviderNativeRootsDeps = WorkSessionDeps &
  Pick<AppDeps, "logger" | "providerNativeRoots">;

export function providerHasNativeRootSurface(
  registration: ProviderRegistration,
): boolean {
  return (
    registration.resolvesNativeRoots ||
    !providerNativeRootsAreEmpty(registration.nativeSkillRoots) ||
    !providerNativeRootsAreEmpty(registration.nativeCommandRoots)
  );
}

function cacheKey(args: {
  pluginId: string;
  providerId: string;
  hostId: string;
  cwd: string | null;
}): string {
  return JSON.stringify([
    args.pluginId,
    args.providerId,
    args.hostId,
    args.cwd ?? "",
  ]);
}

interface ResolveNativeRootsArgs {
  registration: ProviderRegistration;
  hostId: string;
  cwd: string | null;
  timeoutMs: number;
}

async function callResolveNativeRoots(
  deps: ProviderNativeRootsDeps,
  args: ResolveNativeRootsArgs,
): Promise<ProviderResolvedNativeRoots> {
  const { registration } = args;
  const pluginId = registration.pluginId;
  const providerId = registration.info.id;
  const fields = { pluginId, providerId, hostId: args.hostId, cwd: args.cwd };
  const artifact = deps.pluginHostArtifacts.get(pluginId);
  if (artifact === undefined) {
    deps.logger.warn(
      fields,
      `Plugin "${pluginId}" resolves native roots for provider "${providerId}" but has no live bb.host artifact; listing its declared roots only`,
    );
    return EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS;
  }
  try {
    return providerResolvedNativeRootsSchema.parse(
      await callPluginHostRpc(deps, {
        pluginId,
        contract: experimental_nativeRootsHostContract,
        method: "resolveNativeRoots",
        input: { providerId, cwd: args.cwd },
        hostId: args.hostId,
        timeoutMs: args.timeoutMs,
        artifact,
      }),
    );
  } catch (error) {
    deps.logger.warn(
      { ...fields, err: error },
      `Plugin "${pluginId}" failed to resolve native roots for provider "${providerId}"; listing its declared roots only`,
    );
    return EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS;
  }
}

export async function resolveProviderResolvedNativeRoots(
  deps: ProviderNativeRootsDeps,
  args: ResolveNativeRootsArgs,
): Promise<ProviderResolvedNativeRoots> {
  const { registration } = args;
  if (!registration.resolvesNativeRoots) {
    return EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS;
  }
  const pluginId = registration.pluginId;
  const key = cacheKey({
    pluginId,
    providerId: registration.info.id,
    hostId: args.hostId,
    cwd: args.cwd,
  });
  const registrationRevision = deps.providerRegistry.getRegistrationRevision();
  const cached = deps.providerNativeRoots.lookup(key, registrationRevision);
  if (cached !== undefined) {
    return cached;
  }
  const value = callResolveNativeRoots(deps, args);
  deps.providerNativeRoots.store(key, {
    pluginId,
    registrationRevision,
    value,
  });
  return value;
}

export async function resolveProviderNativeRootSet(
  deps: ProviderNativeRootsDeps,
  args: ResolveNativeRootsArgs,
): Promise<ProviderNativeRootSet> {
  const { registration } = args;
  const resolved = await resolveProviderResolvedNativeRoots(deps, args);
  return {
    skills: {
      user: [...registration.nativeSkillRoots.user],
      project: [...registration.nativeSkillRoots.project],
    },
    commands: {
      user: [...registration.nativeCommandRoots.user],
      project: [...registration.nativeCommandRoots.project],
    },
    resolved: {
      skills: [...resolved.skills],
      commands: [...resolved.commands],
    },
  };
}

type ProviderNativeRootScanType = "host.list_commands" | "host.list_skills";
type ProviderNativeRootScanResult<TType extends ProviderNativeRootScanType> =
  HostDaemonOnlineRpcResultForCommand<
    Extract<HostDaemonRetryableOnlineRpcCommand, { type: TType }>
  >;

interface ScanProviderNativeRootsArgs {
  registration: ProviderRegistration;
  hostId: string;
  cwd: string | null;
}

export function scanProviderNativeRoots(
  deps: ProviderNativeRootsDeps,
  args: ScanProviderNativeRootsArgs & { type: "host.list_commands" },
): Promise<ProviderNativeRootScanResult<"host.list_commands">>;
export function scanProviderNativeRoots(
  deps: ProviderNativeRootsDeps,
  args: ScanProviderNativeRootsArgs & { type: "host.list_skills" },
): Promise<ProviderNativeRootScanResult<"host.list_skills">>;
export async function scanProviderNativeRoots(
  deps: ProviderNativeRootsDeps,
  args: ScanProviderNativeRootsArgs & { type: ProviderNativeRootScanType },
): Promise<ProviderNativeRootScanResult<ProviderNativeRootScanType>> {
  const budget = createProviderListingBudget();
  const nativeRoots = await resolveProviderNativeRootSet(deps, {
    registration: args.registration,
    hostId: args.hostId,
    cwd: args.cwd,
    timeoutMs: budget.remainingMs(),
  });
  const scan = {
    providerId: args.registration.info.id,
    cwd: args.cwd,
    nativeRoots,
  };
  return callHostRetryableOnlineRpc(deps, {
    hostId: args.hostId,
    timeoutMs: budget.remainingMs(),
    command:
      args.type === "host.list_commands"
        ? { type: "host.list_commands", ...scan }
        : { type: "host.list_skills", ...scan },
  });
}
