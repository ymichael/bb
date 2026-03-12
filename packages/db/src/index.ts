export { createConnection } from "./connection.js";
export type { DbConnection } from "./connection.js";

export * from "./schema.js";

export {
  ProjectRepository,
  ThreadRepository,
  EventRepository,
} from "./repositories.js";
export type {
  EnvironmentAgentSessionStatus,
  EnvironmentAgentSessionCloseReason,
  EnvironmentAgentCursorPosition,
  EnvironmentAgentSessionRecord,
  EnvironmentAgentCursorRecord,
  EnvironmentAgentCursorAdvanceResult,
  EnvironmentAgentCommandState,
  EnvironmentAgentCommandRecord,
  CreateEnvironmentAgentSessionInput,
  ReplaceActiveEnvironmentAgentSessionInput,
  EnqueueEnvironmentAgentCommandInput,
} from "./environment-agent-repositories.js";
export {
  EnvironmentAgentSessionRepository,
  EnvironmentAgentCursorRepository,
  EnvironmentAgentCommandRepository,
} from "./environment-agent-repositories.js";

export { migrate } from "./migrate.js";
