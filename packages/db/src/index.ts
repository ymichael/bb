export { createConnection } from "./connection.js";
export type { DbConnection } from "./connection.js";

export * from "./schema.js";
export { createProjectId, createThreadId } from "./ids.js";

export {
  ProjectRepository,
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
  ThreadRepository,
  EventRepository,
} from "./repositories.js";
export type {
  ThreadEnvironmentAttachmentRecord,
} from "./repositories.js";
export type {
  EnvironmentDaemonSessionStatus,
  EnvironmentDaemonSessionCloseReason,
  EnvironmentDaemonCursorPosition,
  EnvironmentDaemonSessionRecord,
  EnvironmentDaemonCursorRecord,
  EnvironmentDaemonCursorAdvanceResult,
  EnvironmentDaemonCommandState,
  EnvironmentDaemonCommandRecord,
  CreateEnvironmentDaemonSessionInput,
  ReplaceActiveEnvironmentDaemonSessionInput,
  EnqueueEnvironmentDaemonCommandInput,
} from "./environment-daemon-repositories.js";
export {
  EnvironmentDaemonSessionRepository,
  EnvironmentDaemonCursorRepository,
  EnvironmentDaemonCommandRepository,
} from "./environment-daemon-repositories.js";

export { migrate } from "./migrate.js";
