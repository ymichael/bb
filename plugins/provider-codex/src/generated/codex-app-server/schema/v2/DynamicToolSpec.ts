
import type { DynamicToolFunctionSpec } from "./DynamicToolFunctionSpec.js";
import type { DynamicToolNamespaceSpec } from "./DynamicToolNamespaceSpec.js";

export type DynamicToolSpec = { "type": "function" } & DynamicToolFunctionSpec | { "type": "namespace" } & DynamicToolNamespaceSpec;
