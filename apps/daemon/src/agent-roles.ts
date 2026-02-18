export interface AgentRoleDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

const BB_CLI_INSTRUCTIONS = `\
How to use the \`bb\` CLI:
- Use \`bb status\` to orient yourself. The command is already setup with the context of your current project, task and thread.
- Use focused status checks when needed:
  - \`bb task status\`
  - \`bb thread status\`
- Some example commands:
  - \`bb thread spawn --prompt "..."\`
  - \`bb thread steer <threadId> "..."\`
  - \`bb thread log <threadId>\`
  - \`bb task create ...\`
- It is not necessary to manually poll/check of completion on threads you spawn. When a child thread you spawned completes a turn, you will be notified automatically.
- \`bb --help\` for more information
`;

const GENERIC_AGENT_INSTRUCTIONS = `\
You're an agent working in the context of beanbag (bb), an integrated agent & task management system. In bb, agents work in threads, on tasks within projects. You can use the \`bb\` cli to interface with beanbag. Please work on this task as instructed.

${BB_CLI_INSTRUCTIONS}`.trim();

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

export function getAgentRoleDefinition(
  roleId: string,
): AgentRoleDefinition | undefined {
  return AGENT_ROLES.find((role) => role.id === roleId);
}

export function getDefaultAgentRole(): AgentRoleDefinition {
  return AGENT_ROLES[0];
}
