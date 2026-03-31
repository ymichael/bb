import { z } from "zod";

export const REALTIME_ENTITIES = ["thread", "project", "environment", "host", "system"] as const;
export type RealtimeEntity = (typeof REALTIME_ENTITIES)[number];
export const realtimeEntitySchema = z.enum(REALTIME_ENTITIES);

export const THREAD_CHANGE_KINDS = [
  "thread-created",
  "thread-deleted",
  "events-appended",
  "status-changed",
  "title-changed",
  "queue-changed",
  "archived-changed",
  "read-state-changed",
] as const;
export type ThreadChangeKind = (typeof THREAD_CHANGE_KINDS)[number];

export const PROJECT_CHANGE_KINDS = [
  "project-created",
  "project-updated",
  "project-deleted",
  "project-sources-changed",
  "threads-changed",
] as const;
export type ProjectChangeKind = (typeof PROJECT_CHANGE_KINDS)[number];

export const ENVIRONMENT_CHANGE_KINDS = [
  "environment-created",
  "environment-deleted",
  "status-changed",
  "work-status-changed",
] as const;
export type EnvironmentChangeKind = (typeof ENVIRONMENT_CHANGE_KINDS)[number];

export const HOST_CHANGE_KINDS = [
  "host-connected",
  "host-disconnected",
] as const;
export type HostChangeKind = (typeof HOST_CHANGE_KINDS)[number];

export const SYSTEM_CHANGE_KINDS = [] as const;
export type SystemChangeKind = (typeof SYSTEM_CHANGE_KINDS)[number];

export const subscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  entity: realtimeEntitySchema,
  id: z.string().optional(),
});
export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;

export const unsubscribeMessageSchema = z.object({
  type: z.literal("unsubscribe"),
  entity: realtimeEntitySchema,
  id: z.string().optional(),
});
export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  subscribeMessageSchema,
  unsubscribeMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export interface ThreadChangedMessage {
  type: "changed";
  entity: "thread";
  id?: string;
  changes: ThreadChangeKind[];
}

export interface ProjectChangedMessage {
  type: "changed";
  entity: "project";
  id?: string;
  changes: ProjectChangeKind[];
}

export interface EnvironmentChangedMessage {
  type: "changed";
  entity: "environment";
  id?: string;
  changes: EnvironmentChangeKind[];
}

export interface HostChangedMessage {
  type: "changed";
  entity: "host";
  changes: HostChangeKind[];
}

export interface SystemChangedMessage {
  type: "changed";
  entity: "system";
  changes: SystemChangeKind[];
}

export type ChangedMessage =
  | ThreadChangedMessage
  | ProjectChangedMessage
  | EnvironmentChangedMessage
  | HostChangedMessage
  | SystemChangedMessage;
export type ServerMessage = ChangedMessage;
