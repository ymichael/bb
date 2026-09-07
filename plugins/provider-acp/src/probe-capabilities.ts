import type { AcpAgentDefinition } from "./agents.js";
import type { AcpProbeResult } from "./contract.js";

export interface AcpProbeApplication {
  agent: AcpAgentDefinition;
  reason: string;
}

export function applyAcpAgentProbe(
  agent: AcpAgentDefinition,
  probe: AcpProbeResult,
): AcpProbeApplication | null {
  if (!probe.reachable) {
    return null;
  }
  const declaredFork = agent.fork ?? "none";
  if (declaredFork === "none" || probe.fork) {
    return null;
  }
  return {
    agent: { ...agent, fork: "none" },
    reason: `the agent does not advertise session/fork, but bb declared fork "${declaredFork}"`,
  };
}
