import type {
  EnvironmentChangeKind,
  HostChangeKind,
  ProjectChangeKind,
  SystemChangeKind,
  ThreadChangeKind,
  ThreadChangeMetadata,
} from "@bb/domain";
import type { DbNotifier } from "@bb/db";

interface BufferedNotification {
  flush(notifier: DbNotifier): void;
}

export class NotificationBuffer implements DbNotifier {
  private readonly notifications: BufferedNotification[] = [];

  notifyThread(
    threadId: string,
    changes: ThreadChangeKind[],
    metadata?: ThreadChangeMetadata,
  ): void {
    this.notifications.push({
      flush: (notifier) =>
        notifier.notifyThread(threadId, [...changes], metadata),
    });
  }

  notifyProject(projectId: string, changes: ProjectChangeKind[]): void {
    this.notifications.push({
      flush: (notifier) => notifier.notifyProject(projectId, [...changes]),
    });
  }

  notifyEnvironment(
    environmentId: string,
    changes: EnvironmentChangeKind[],
  ): void {
    this.notifications.push({
      flush: (notifier) =>
        notifier.notifyEnvironment(environmentId, [...changes]),
    });
  }

  notifyHost(hostId: string, changes: HostChangeKind[]): void {
    this.notifications.push({
      flush: (notifier) => notifier.notifyHost(hostId, [...changes]),
    });
  }

  notifyCommand(hostId: string): void {
    this.notifications.push({
      flush: (notifier) => notifier.notifyCommand(hostId),
    });
  }

  notifySystem(changes: SystemChangeKind[]): void {
    this.notifications.push({
      flush: (notifier) => notifier.notifySystem([...changes]),
    });
  }

  flushInto(notifier: DbNotifier): void {
    for (const notification of this.notifications) {
      notification.flush(notifier);
    }
  }
}
