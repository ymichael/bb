
import type { RealtimeConversationVersion } from "../RealtimeConversationVersion.js";

export type ThreadRealtimeStartedNotification = { threadId: string, realtimeSessionId: string | null, version: RealtimeConversationVersion, };
