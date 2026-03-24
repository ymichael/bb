import type { ThreadChangeKind, ProjectChangeKind, EnvironmentChangeKind, SystemChangeKind } from "@bb/domain";

export interface DbNotifier {
  notifyThread(threadId: string, changes: ThreadChangeKind[]): void;
  notifyProject(projectId: string, changes: ProjectChangeKind[]): void;
  notifyEnvironment(environmentId: string, changes: EnvironmentChangeKind[]): void;
  notifyCommand(hostId: string): void;
  notifySystem(changes: SystemChangeKind[]): void;
}

export const noopNotifier: DbNotifier = {
  notifyThread() {},
  notifyProject() {},
  notifyEnvironment() {},
  notifyCommand() {},
  notifySystem() {},
};
