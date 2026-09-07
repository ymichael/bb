
import type { JsonValue } from "../serde_json/JsonValue.js";

export type ThreadRealtimeItemAddedNotification = { threadId: string, item: JsonValue, };
