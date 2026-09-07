/**
 * `@get-bb/plugin-sdk/provider-bridge/acp` — the published ACP bridge kit.
 *
 * The Agent Client Protocol (https://agentclientprotocol.com) is one wire
 * protocol spoken by many agents, so bb runs all of them through one generic
 * bridge: the agent to launch arrives per command in the provider options,
 * and nothing in the bridge is bb-first-party. A plugin that wants to add an
 * ACP agent re-exports the bridge from its `bb.host` artifact and registers
 * its providers as any other plugin does:
 *
 * ```ts
 * // host.ts (the plugin's `bb.host` entry)
 * export { experimental_acpProviderBridge as experimental_providerBridge }
 *   from "@get-bb/plugin-sdk/provider-bridge/acp";
 *
 * // server.ts
 * bb.providers.register({
 *   id: "amp",
 *   displayName: "Amp",
 *   experimental_bridgeOptions: {
 *     acpLaunchSpec: { displayName: "Amp", command: "amp", args: ["acp"], env: {} },
 *     acpDialect: "generic",
 *   },
 *   // …the rest of the declaration
 * })
 * ```
 *
 * **Dialects.** Version 1 of the protocol has no sub-agent concept and
 * standardizes nothing about `rawInput`, so what most distinguishes one
 * agent from another lives beside the protocol: grok stamps
 * `_meta["x.ai/tool"]` on every tool event, Cursor reports sub-agents
 * through a vendor `cursor/task` request. A dialect is a small module that
 * reads those channels; the bridge ships `generic`, `cursor` and `grok`,
 * named by id in the registration's bridge options (`acpDialect`). The
 * dialect registry itself is not public yet: no plugin has needed to supply
 * one, and its shape (process-global, unversioned hooks) is still open — see
 * docs/api_to_audit.md.
 *
 * Curated by hand — named exports only, never `export *`. Value exports
 * carry the `experimental_` prefix every new plugin API member ships with
 * (see docs/api_to_audit.md); types are unprefixed. Exports no plugin
 * consumes are not published: the surface grows with a consumer, not ahead
 * of one.
 */
import type { AcpLaunchSpec } from "@bb/provider-bridge-acp";

export { acpProviderBridge as experimental_acpProviderBridge } from "@bb/provider-bridge-acp";
export type {
  AcpClassifiedToolCall,
  AcpClientRequestOutcome,
  AcpDelegationReport,
  AcpDialect,
  AcpToolIdentity,
} from "@bb/provider-bridge-acp";

export {
  acpAgentProbeSchema as experimental_acpAgentProbeSchema,
  probeAcpAgent as experimental_probeAcpAgent,
} from "@bb/provider-bridge-acp";
export type {
  AcpAgentProbe,
  AcpAgentProbeRequest,
} from "@bb/provider-bridge-acp";

export { acpLaunchSpecSchema as experimental_acpLaunchSpecSchema } from "@bb/provider-bridge-acp";
export type { AcpLaunchSpec } from "@bb/provider-bridge-acp";
/**
 * @deprecated The bridge reads the parsed `AcpLaunchSpec` directly; the
 * profile it used to derive from the spec carried the same fields under
 * other names, and nothing outside the bridge produced or consumed it. Kept
 * as an alias because 0.4.x published the name; scheduled for removal at the
 * next major (docs/api_to_audit.md).
 */
export type AcpAgentProfile = AcpLaunchSpec;

export type {
  AcpToolCallContent,
  AcpToolCallStatus,
  AcpToolCallUpdateEvent,
  AcpToolKind,
} from "@bb/provider-bridge-acp";
export type { AgentModelCatalog as AcpAgentModelCatalog } from "@bb/provider-bridge-acp";
