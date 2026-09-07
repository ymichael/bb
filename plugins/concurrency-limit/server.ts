import {
  defineRpcContract,
  type BbPluginApi,
  type MessageDispatchHookDecision,
  type PluginThreadEventName,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { concurrencyLimitHostContract } from "./contract.js";
import {
  automaticHostLimit,
  MAX_LIMIT_VALUE,
  resolveHostLimit,
  type HostLimitOverride,
  type LimitConfiguration,
} from "./limits.js";

const CONFIGURATION_KEY = "configuration";
const CAPACITIES_KEY = "host-capacities";
const CONFIGURATION_CHANGED_CHANNEL = "configuration-changed";
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
export const MAX_REASON_LENGTH = 200;

const limitSchema = z.number().int().min(0).max(MAX_LIMIT_VALUE);
const hostOverrideSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    limit: limitSchema,
  })
  .strict();
const configurationShape = {
  globalLimit: limitSchema.nullable(),
  hostOverrides: z.array(hostOverrideSchema).max(256),
};
const configurationSchema = z
  .object(configurationShape)
  .strict()
  .superRefine((configuration, context) => {
    const seen = new Set<string>();
    for (const override of configuration.hostOverrides) {
      if (seen.has(override.hostId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate host override for ${override.hostId}`,
          path: ["hostOverrides"],
        });
      }
      seen.add(override.hostId);
    }
  });
const capacityRecordSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    availableParallelism: z.number().int().positive(),
  })
  .strict();
const capacityRecordsSchema = z.array(capacityRecordSchema).max(256);
const hostConfigurationSchema = z
  .object({
    ...configurationShape,
    hosts: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string(),
          status: z.enum(["connected", "disconnected"]),
          availableParallelism: z.number().int().positive().nullable(),
          automaticLimit: limitSchema,
          effectiveLimit: limitSchema,
          override: limitSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const concurrencyLimitRpcContract = defineRpcContract({
  getConfiguration: {
    input: z.null(),
    output: hostConfigurationSchema,
  },
  setConfiguration: {
    input: configurationSchema,
    output: hostConfigurationSchema,
  },
});

type Configuration = z.infer<typeof configurationSchema>;
type CapacityRecord = z.infer<typeof capacityRecordSchema>;
type RefreshOutcome = "settled" | "retry";

const DEFAULT_CONFIGURATION: Configuration = {
  globalLimit: null,
  hostOverrides: [],
};

const CAPACITY_FREED_EVENTS = [
  "thread.idle",
  "thread.failed",
  "thread.archived",
  "thread.deleted",
] as const satisfies readonly PluginThreadEventName[];

function normalizeConfiguration(
  configuration: LimitConfiguration,
): Configuration {
  return {
    globalLimit: configuration.globalLimit,
    hostOverrides: [...configuration.hostOverrides].sort((left, right) =>
      left.hostId.localeCompare(right.hostId),
    ),
  };
}

function waitDecision(
  limit: number,
  scopeLabel: string,
): MessageDispatchHookDecision {
  const reason = `${limit} of ${limit} running on ${scopeLabel}`;
  return {
    action: "wait",
    reason:
      reason.length <= MAX_REASON_LENGTH
        ? reason
        : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLimitArgument(
  raw: string,
  automaticKeyword: "auto" | "unlimited",
): { ok: true; value: number | null } | { ok: false; message: string } {
  if (raw === automaticKeyword) return { ok: true, value: null };
  if (!/^\d+$/u.test(raw)) {
    return {
      ok: false,
      message: `Limit must be ${automaticKeyword} or a whole number from 0 to ${MAX_LIMIT_VALUE}`,
    };
  }
  const value = Number(raw);
  return value <= MAX_LIMIT_VALUE
    ? { ok: true, value }
    : {
        ok: false,
        message: `Limit must be ${automaticKeyword} or a whole number from 0 to ${MAX_LIMIT_VALUE}`,
      };
}

function setHostOverride(
  configuration: Configuration,
  hostId: string,
  limit: number | null,
): Configuration {
  const hostOverrides = configuration.hostOverrides.filter(
    (override) => override.hostId !== hostId,
  );
  if (limit !== null) hostOverrides.push({ hostId, limit });
  return normalizeConfiguration({
    globalLimit: configuration.globalLimit,
    hostOverrides,
  });
}

function formatHostLine(host: {
  name: string;
  status: "connected" | "disconnected";
  availableParallelism: number | null;
  effectiveLimit: number;
  override: number | null;
}): string {
  const source =
    host.override === null
      ? `auto, ${host.effectiveLimit}`
      : String(host.override);
  const processors =
    host.availableParallelism === null
      ? "processors unknown"
      : `${host.availableParallelism} processors`;
  return `${host.name}: ${source} (${processors}, ${host.status})`;
}

export default async function concurrencyLimitPlugin(
  bb: BbPluginApi,
): Promise<void> {
  const hostClient = bb.hosts.experimental_client({
    contract: concurrencyLimitHostContract,
  });
  const storedConfiguration = configurationSchema.safeParse(
    await bb.storage.kv.get<unknown>(CONFIGURATION_KEY),
  );
  let configuration = storedConfiguration.success
    ? normalizeConfiguration(storedConfiguration.data)
    : DEFAULT_CONFIGURATION;
  const storedCapacities = capacityRecordsSchema.safeParse(
    await bb.storage.kv.get<unknown>(CAPACITIES_KEY),
  );
  const capacities = new Map<string, number>(
    (storedCapacities.success ? storedCapacities.data : []).map((record) => [
      record.hostId,
      record.availableParallelism,
    ]),
  );

  async function readConfiguration() {
    const availableHosts = await bb.sdk.hosts.list();
    return {
      ...configuration,
      hosts: availableHosts.map(({ id, name, status }) => {
        const availableParallelism = capacities.get(id) ?? null;
        const resolved = resolveHostLimit(
          configuration,
          id,
          availableParallelism,
        );
        return {
          id,
          name,
          status,
          availableParallelism,
          automaticLimit: automaticHostLimit(availableParallelism),
          effectiveLimit: resolved.limit,
          override: resolved.mode === "override" ? resolved.limit : null,
        };
      }),
    };
  }

  async function saveConfiguration(next: Configuration): Promise<void> {
    const normalized = normalizeConfiguration(next);
    await bb.storage.kv.set(CONFIGURATION_KEY, normalized);
    configuration = normalized;
    bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
    await bb.experimental_hooks.recheck("message.dispatch");
  }

  async function persistCapacities(): Promise<void> {
    const records: CapacityRecord[] = [...capacities]
      .map(([hostId, availableParallelism]) => ({
        hostId,
        availableParallelism,
      }))
      .sort((left, right) => left.hostId.localeCompare(right.hostId));
    await bb.storage.kv.set(CAPACITIES_KEY, records);
  }

  bb.rpc.register(concurrencyLimitRpcContract, {
    getConfiguration: readConfiguration,
    async setConfiguration(next) {
      await saveConfiguration(next);
      return readConfiguration();
    },
  });

  bb.cli.register({
    name: "concurrency-limit",
    summary: "Configure global and per-host thread limits",
    commands: [
      {
        name: "status",
        summary: "Show effective concurrency limits",
        usage: "bb concurrency-limit status [--json]",
      },
      {
        name: "global",
        summary: "Show or set the overall limit",
        usage: "bb concurrency-limit global [unlimited|<limit>] [--json]",
      },
      {
        name: "host",
        summary: "Show or set one host limit",
        usage: "bb concurrency-limit host <host-id> [auto|<limit>] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter(
        (argument) => argument !== "--json",
      );

      if (command === "status" && args.length === 0) {
        const view = await readConfiguration();
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify(view)
            : [
                `Overall: ${view.globalLimit === null ? "unlimited" : view.globalLimit}`,
                "Automatic host limit: one thread per available processor",
                ...view.hosts.map(formatHostLine),
              ].join("\n"),
        };
      }

      if (command === "global" && args.length <= 1) {
        if (args.length === 1) {
          const parsed = parseLimitArgument(args[0] ?? "", "unlimited");
          if (!parsed.ok) return { exitCode: 1, stderr: parsed.message };
          await saveConfiguration({
            ...configuration,
            globalLimit: parsed.value,
          });
        }
        return {
          exitCode: 0,
          stdout: json
            ? JSON.stringify({ globalLimit: configuration.globalLimit })
            : configuration.globalLimit === null
              ? "Unlimited"
              : String(configuration.globalLimit),
        };
      }

      if (command === "host" && (args.length === 1 || args.length === 2)) {
        const hostId = args[0] ?? "";
        const view = await readConfiguration();
        const selectedHost = view.hosts.find(
          (candidate) => candidate.id === hostId,
        );
        if (selectedHost === undefined) {
          return { exitCode: 1, stderr: `Unknown host: ${hostId}` };
        }
        if (args.length === 2) {
          const parsed = parseLimitArgument(args[1] ?? "", "auto");
          if (!parsed.ok) return { exitCode: 1, stderr: parsed.message };
          await saveConfiguration(
            setHostOverride(configuration, hostId, parsed.value),
          );
        }
        const updated = (await readConfiguration()).hosts.find(
          (candidate) => candidate.id === hostId,
        );
        if (updated === undefined) {
          return { exitCode: 1, stderr: `Unknown host: ${hostId}` };
        }
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(updated) : formatHostLine(updated),
        };
      }

      return {
        exitCode: 1,
        stderr:
          "Usage: bb concurrency-limit <status|global|host> [arguments] [--json]",
      };
    },
  });

  let refreshAllRequested = true;
  const requestedHostIds = new Set<string>();
  let wakeWaiter: (() => void) | null = null;

  function requestRefresh(hostId?: string): void {
    if (hostId === undefined) refreshAllRequested = true;
    else requestedHostIds.add(hostId);
    wakeWaiter?.();
  }

  async function refreshCapacities(
    signal: AbortSignal,
    refreshAll: boolean,
    hostIds: ReadonlySet<string>,
  ): Promise<RefreshOutcome> {
    try {
      const availableHosts = await bb.sdk.hosts.list({ signal });
      let changed = false;
      if (refreshAll) {
        const availableHostIds = new Set(availableHosts.map((host) => host.id));
        for (const hostId of capacities.keys()) {
          if (!availableHostIds.has(hostId)) {
            capacities.delete(hostId);
            changed = true;
          }
        }
      }
      let retry = false;
      const targets = availableHosts.filter(
        (availableHost) =>
          availableHost.status === "connected" &&
          (refreshAll || hostIds.has(availableHost.id)),
      );
      await Promise.all(
        targets.map(async (availableHost) => {
          try {
            const result = await hostClient.call("getCapacity", null, {
              hostId: availableHost.id,
              signal,
            });
            if (
              capacities.get(availableHost.id) !== result.availableParallelism
            ) {
              capacities.set(availableHost.id, result.availableParallelism);
              changed = true;
            }
          } catch (error) {
            if (signal.aborted) return;
            retry = true;
            bb.log.warn(
              `Could not detect capacity for host ${availableHost.id}: ${errorMessage(error)}`,
            );
          }
        }),
      );
      if (changed) {
        await persistCapacities();
        bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
        await bb.experimental_hooks.recheck("message.dispatch");
      }
      return retry ? "retry" : "settled";
    } catch (error) {
      if (!signal.aborted) {
        bb.log.warn(
          `Could not load hosts for capacity detection: ${errorMessage(error)}`,
        );
      }
      return signal.aborted ? "settled" : "retry";
    }
  }

  function waitForRefresh(
    signal: AbortSignal,
    retryDelayMs: number | null,
  ): Promise<"requested" | "retry" | "aborted"> {
    if (signal.aborted) return Promise.resolve("aborted");
    if (refreshAllRequested || requestedHostIds.size > 0) {
      return Promise.resolve("requested");
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;
      const finish = (reason: "requested" | "retry" | "aborted"): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (wakeWaiter === wake) wakeWaiter = null;
        signal.removeEventListener("abort", abort);
        resolve(reason);
      };
      const wake = (): void => finish("requested");
      const abort = (): void => finish("aborted");
      wakeWaiter = wake;
      signal.addEventListener("abort", abort, { once: true });
      if (retryDelayMs !== null) {
        timer = setTimeout(() => finish("retry"), retryDelayMs);
      }
    });
  }

  bb.background.service("capacity-detector", {
    async start(signal) {
      const unsubscribeHost = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
          if (event.changes.includes("host-connected"))
            requestRefresh(event.id);
        },
      });
      const unsubscribeRealtime = bb.sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "connected" && event.reconnected)
            requestRefresh();
        },
      });
      let retryMs = RETRY_MIN_MS;
      try {
        while (!signal.aborted) {
          const refreshAll = refreshAllRequested;
          const hostIds = new Set(requestedHostIds);
          refreshAllRequested = false;
          requestedHostIds.clear();
          const outcome = await refreshCapacities(signal, refreshAll, hostIds);
          if (signal.aborted) break;
          if (refreshAllRequested || requestedHostIds.size > 0) continue;
          const wakeReason = await waitForRefresh(
            signal,
            outcome === "retry" ? retryMs : null,
          );
          if (wakeReason === "retry") {
            refreshAllRequested = true;
            retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
          } else if (outcome === "settled") {
            retryMs = RETRY_MIN_MS;
          }
        }
      } finally {
        unsubscribeRealtime();
        unsubscribeHost();
        wakeWaiter?.();
        wakeWaiter = null;
      }
    },
  });

  for (const event of CAPACITY_FREED_EVENTS) {
    bb.events.on(event, async () => {
      await bb.experimental_hooks.recheck("message.dispatch");
    });
  }

  bb.experimental_hooks.on("message.dispatch", async (context) => {
    if (
      context.attempt === "join-turn" ||
      context.thread.status === "active" ||
      context.thread.status === "starting"
    ) {
      return { action: "proceed" };
    }

    const host = context.host;
    if (configuration.globalLimit === null && host === null) {
      return { action: "proceed" };
    }
    const running = await bb.sdk.threads.listRunning();

    if (
      configuration.globalLimit !== null &&
      running.length >= configuration.globalLimit
    ) {
      return waitDecision(configuration.globalLimit, "all hosts");
    }

    if (host !== null) {
      const resolved = resolveHostLimit(
        configuration,
        host.id,
        capacities.get(host.id) ?? null,
      );
      const onHost = running.filter((thread) => thread.hostId === host.id);
      if (onHost.length >= resolved.limit) {
        const label = host.name.trim() === "" ? host.id : host.name;
        return waitDecision(resolved.limit, `host ${label}`);
      }
    }

    return { action: "proceed" };
  });
}
