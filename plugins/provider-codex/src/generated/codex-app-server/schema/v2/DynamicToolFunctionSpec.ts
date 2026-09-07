
import type { JsonValue } from "../serde_json/JsonValue.js";

export type DynamicToolFunctionSpec = { name: string, description: string, inputSchema: JsonValue, deferLoading?: boolean, };
