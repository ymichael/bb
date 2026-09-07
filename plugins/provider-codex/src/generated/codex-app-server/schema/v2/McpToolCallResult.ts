
import type { JsonValue } from "../serde_json/JsonValue.js";

export type McpToolCallResult = { content: Array<JsonValue>, structuredContent: JsonValue | null, _meta: JsonValue | null, };
