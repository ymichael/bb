
import type { JsonValue } from "../serde_json/JsonValue.js";

export type TurnModerationMetadataNotification = { threadId: string, turnId: string, metadata: JsonValue, };
