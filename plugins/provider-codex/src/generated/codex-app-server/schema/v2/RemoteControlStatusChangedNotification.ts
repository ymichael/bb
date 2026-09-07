
import type { RemoteControlConnectionStatus } from "./RemoteControlConnectionStatus.js";

export type RemoteControlStatusChangedNotification = { status: RemoteControlConnectionStatus, serverName: string, installationId: string, environmentId: string | null, };
