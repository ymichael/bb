import type {
  BbPluginApi,
  PluginProviderDeclaration,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type AcpAgentDefinition } from "./src/agents.js";
import { resolveConfiguredAcpAgents } from "./src/configured-agents.js";
import { acpHostContract, type AcpProbeResult } from "./src/contract.js";
import { acpProviderDeclaration } from "./src/declaration.js";
import { applyAcpAgentProbe } from "./src/probe-capabilities.js";
import {
  KNOWN_ACP_AGENTS,
  RESERVED_ACP_PROVIDER_IDS,
} from "./src/known-agents.js";
import { readLegacyCustomAcpAgents } from "./src/legacy-config.js";

const CUSTOM_AGENTS_SETTING_DESCRIPTION =
  "A JSON array of ACP agents to add. Each entry needs id, displayName and command; see the guide for the optional fields.";

const PROBEABLE_ACP_AGENTS = KNOWN_ACP_AGENTS.filter(
  (agent) => (agent.fork ?? "none") !== "none",
);

const HOST_POLL_INTERVAL_MS = 5_000;

async function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

export default async function acpProvidersPlugin(
  bb: BbPluginApi,
): Promise<void> {
  const host = bb.hosts.experimental_client({ contract: acpHostContract });
  const settings = bb.settings.define({
    customAgents: {
      type: "string",
      label: "Custom agents",
      description: CUSTOM_AGENTS_SETTING_DESCRIPTION,
      experimental_multiline: true,
      experimental_schema: z.string().superRefine((value, context) => {
        const { warnings } = resolveConfiguredAcpAgents({
          settingValue: value,
          legacyEntries: [],
          reservedProviderIds: RESERVED_ACP_PROVIDER_IDS,
          shippedAgents: KNOWN_ACP_AGENTS,
        });
        const errors = warnings.map((warning) => {
          if (warning.includes("not valid JSON")) {
            return "Custom agents must be valid JSON.";
          }
          if (warning.includes("must be a JSON array")) {
            return "Custom agents must be a JSON array.";
          }
          return warning.replace(/^ACP custom agent setting: /u, "");
        });
        if (errors.length > 0) {
          context.addIssue({ code: "custom", message: errors.join(" ") });
        }
      }),
      default: "",
    },
  });

  const registered = new Map<string, { key: string; dispose(): void }>();

  const narrowed = new Map<string, AcpAgentDefinition>();
  let configuredAgents: readonly AcpAgentDefinition[] = [];

  function desiredAgents(): AcpAgentDefinition[] {
    const configuredIds = new Set(configuredAgents.map((agent) => agent.id));
    return [
      ...KNOWN_ACP_AGENTS.filter((agent) => !configuredIds.has(agent.id)).map(
        (agent) => narrowed.get(agent.id) ?? agent,
      ),
      ...configuredAgents,
    ];
  }

  function register(declaration: PluginProviderDeclaration): void {
    try {
      const { dispose } = bb.providers.register(declaration);
      registered.set(declaration.id, {
        key: JSON.stringify(declaration),
        dispose,
      });
    } catch (error) {
      bb.log.error(
        `Could not register ACP provider "${declaration.id}": ${String(error)}`,
      );
    }
  }

  function reconcile(agents: readonly AcpAgentDefinition[]): void {
    const desired = new Map(
      agents.map((agent) => [agent.id, acpProviderDeclaration(agent)]),
    );
    for (const [id, entry] of [...registered]) {
      const next = desired.get(id);
      if (next !== undefined && JSON.stringify(next) === entry.key) {
        continue;
      }
      entry.dispose();
      registered.delete(id);
    }
    for (const [id, declaration] of desired) {
      if (registered.has(id)) {
        continue;
      }
      register(declaration);
    }
  }

  async function resolveAndReconcile(settingValue: string): Promise<void> {
    const legacy = await readLegacyCustomAcpAgents(
      bb.server.experimental_dataDir,
    );
    const resolved = resolveConfiguredAcpAgents({
      settingValue,
      legacyEntries: legacy.entries,
      ...(legacy.problem === undefined
        ? {}
        : { legacyProblem: legacy.problem }),
      reservedProviderIds: RESERVED_ACP_PROVIDER_IDS,
      shippedAgents: KNOWN_ACP_AGENTS,
    });
    for (const warning of resolved.warnings) {
      bb.log.warn(warning);
    }
    configuredAgents = resolved.agents;
    reconcile(desiredAgents());
    if (resolved.agents.length > 0) {
      bb.log.info(
        `Registered ${resolved.agents.length} configured ACP agent(s).`,
      );
    }
  }

  let pending: Promise<void> = Promise.resolve();
  function queueReconcile(settingValue: string): Promise<void> {
    pending = pending
      .catch(() => undefined)
      .then(() => resolveAndReconcile(settingValue));
    return pending;
  }

  async function probeAgents(
    hostId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const configuredIds = new Set(configuredAgents.map((agent) => agent.id));
    for (const shipped of PROBEABLE_ACP_AGENTS) {
      if (signal.aborted) return;
      if (configuredIds.has(shipped.id)) continue;
      const agent = narrowed.get(shipped.id) ?? shipped;
      if ((agent.fork ?? "none") === "none") continue;
      let probe: AcpProbeResult;
      try {
        probe = await host.call(
          "probeAgent",
          {
            command: agent.launch.command,
            args: agent.launch.args,
            env: agent.launch.env,
          },
          { hostId, signal },
        );
      } catch (error) {
        bb.log.debug(
          `Could not probe ${agent.id} on host ${hostId}: ${String(error)}`,
        );
        continue;
      }
      const applied = applyAcpAgentProbe(agent, probe);
      if (applied === null) {
        continue;
      }
      bb.log.info(
        `${agent.id} on host ${hostId}: ${applied.reason}; re-registering.`,
      );
      narrowed.set(agent.id, applied.agent);
      reconcile(desiredAgents());
    }
  }

  for (const agent of desiredAgents()) {
    register(acpProviderDeclaration(agent));
  }

  const initial = await settings.get();
  await queueReconcile(initial.customAgents);
  settings.onChange((next) => {
    void queueReconcile(next.customAgents).catch((error: unknown) => {
      bb.log.error(
        `Could not re-register the configured ACP agents: ${String(error)}`,
      );
    });
  });

  bb.background.service("acp-capability-probe", {
    async start(signal: AbortSignal): Promise<void> {
      const probed = new Set<string>();
      while (!signal.aborted) {
        const hosts = await bb.sdk.hosts.list();
        const connected = new Set(
          hosts
            .filter((available) => available.status === "connected")
            .map((available) => available.id),
        );
        for (const hostId of [...probed]) {
          if (!connected.has(hostId)) probed.delete(hostId);
        }
        for (const hostId of connected) {
          if (signal.aborted || probed.has(hostId)) continue;
          probed.add(hostId);
          await probeAgents(hostId, signal);
        }
        if (signal.aborted) break;
        await sleepUntilAbort(HOST_POLL_INTERVAL_MS, signal);
      }
    },
  });

  bb.onDispose(() => {
    for (const [, entry] of registered) {
      entry.dispose();
    }
    registered.clear();
  });
}
