
import type { ThreadRealtimeAudioChunk } from "./ThreadRealtimeAudioChunk.js";

export type ThreadRealtimeOutputAudioDeltaNotification = { threadId: string, audio: ThreadRealtimeAudioChunk, };
