export { createConnection } from "./connection.js";
export {
  listThreadsWithPendingInteractionStateForProjectsOffThread,
  listThreadsWithPendingInteractionStateOffThread,
  startSqliteReadWorker,
  stopSqliteReadWorker,
} from "./sqlite-read-queue.js";
export type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
  SlowDbQueryLogger,
  SlowDbQueryLogFields,
} from "./connection.js";

export * from "./schema.js";
export {
  createQueuedThreadMessageId,
  createEnvironmentId,
  createEventId,
  createHostDaemonSessionId,
  createHostId,
  createProjectId,
  createPromptHistoryEntryId,
  createProjectSourceId,
  createThreadId,
  createThreadProvisioningId,
} from "./ids.js";

export { migrate } from "./migrate.js";
export {
  isSqliteForeignKeyConstraint,
  isSqliteUniqueConstraintOnColumns,
} from "./sqlite-errors.js";
export type { MigrationWarningLogger } from "./migrate.js";
export {
  deriveStoredEventItemFields,
  deriveStoredEventItemFieldsFromSource,
} from "./stored-event-item-fields.js";
export { noopNotifier } from "./notifier.js";
export type { DbNotifier } from "./notifier.js";

export * from "./data/index.js";
