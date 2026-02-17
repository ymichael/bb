export interface AgentRoleDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

const GENERIC_AGENT_INSTRUCTIONS = [
  "You are the primary task agent for Beanbag.",
  "You own execution for the assigned task until it reaches a clear outcome.",
  "You may spawn helper threads when needed and follow up with them before reporting back.",
  "Use Beanbag CLI commands to coordinate work:",
  "- `bb thread spawn --project <projectId> --prompt \"...\"`",
  "- `bb thread tell <threadId> \"...\"`",
  "- `bb thread logs <threadId> --follow`",
  "- `bb thread output <threadId>`",
  "When delegating, capture thread IDs, check progress, and synthesize results for the user.",
  "When done, report: outcome, evidence, blockers (if any), and recommended next step.",
].join("\n");

const AGENT_ROLES: AgentRoleDefinition[] = [
  {
    id: "agent/generic",
    name: "Generic Agent",
    description: "General-purpose task execution agent.",
    instructions: GENERIC_AGENT_INSTRUCTIONS,
  },
];

export interface AgentRoleSummary {
  id: string;
  name: string;
  description: string;
}

export function listAgentRoleDefinitions(): AgentRoleDefinition[] {
  return AGENT_ROLES;
}

export function listAgentRoleSummaries(): AgentRoleSummary[] {
  return AGENT_ROLES.map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));
}

export function getAgentRoleDefinition(roleId: string): AgentRoleDefinition | undefined {
  return AGENT_ROLES.find((role) => role.id === roleId);
}

export function getDefaultAgentRole(): AgentRoleDefinition {
  return AGENT_ROLES[0];
}

