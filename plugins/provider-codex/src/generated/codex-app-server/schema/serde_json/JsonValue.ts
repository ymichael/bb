

export type JsonValue = number | string | boolean | Array<JsonValue> | { [key in string]?: JsonValue } | null;
