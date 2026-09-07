
import type { JsonValue } from "./serde_json/JsonValue.js";
import type { WebSearchAction } from "./v2/WebSearchAction.js";

export type WebSearchItem = { id: string, query: string, action: WebSearchAction | null,
results: Array<JsonValue> | null, };
