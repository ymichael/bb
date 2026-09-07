/** A JSON-safe path segment reported by a Standard Schema validation issue. */
export type PluginRpcIssuePathSegment = string | number;

/** Validator-neutral validation detail carried by an RPC error envelope. */
export interface PluginRpcValidationIssue {
  message: string;
  path?: PluginRpcIssuePathSegment[];
}

/** Stable wire error categories for plugin RPC. */
export type PluginRpcErrorCode =
  | "invalid_json"
  | "invalid_input"
  | "handler_error"
  | "invalid_output"
  | "non_json_result"
  | "unknown_method";

/** Structured RPC failure returned as `{ ok: false, error }`. */
export interface PluginRpcError {
  code: PluginRpcErrorCode;
  message: string;
  issues?: PluginRpcValidationIssue[];
}

/**
 * The validator-neutral subset of Standard Schema v1 used by plugin contracts.
 * Zod 4 schemas implement this interface directly; other validators can do
 * the same without becoming part of BB's public protocol.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | StandardSchemaV1Result<Output>
      | Promise<StandardSchemaV1Result<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaV1Issue[] };

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?:
    | PropertyKey
    | readonly (PropertyKey | { readonly key: PropertyKey })[];
}

export type StandardSchemaV1InferInput<Schema extends StandardSchemaV1> =
  NonNullable<Schema["~standard"]["types"]>["input"];

export type StandardSchemaV1InferOutput<Schema extends StandardSchemaV1> =
  NonNullable<Schema["~standard"]["types"]>["output"];

export interface PluginRpcMethodContract<
  InputSchema extends StandardSchemaV1 = StandardSchemaV1,
  OutputSchema extends StandardSchemaV1 = StandardSchemaV1,
> {
  readonly input: InputSchema;
  readonly output: OutputSchema;
}

export type PluginRpcContract = Readonly<
  Record<string, PluginRpcMethodContract>
>;

/** Define a shared RPC contract while preserving exact method/schema types. */
export function defineRpcContract<const Contract extends PluginRpcContract>(
  contract: Contract,
): Contract {
  return contract;
}

export type PluginRpcHandlers<Contract extends PluginRpcContract> = {
  [Method in keyof Contract]: (
    input: StandardSchemaV1InferOutput<Contract[Method]["input"]>,
  ) =>
    | StandardSchemaV1InferInput<Contract[Method]["output"]>
    | Promise<StandardSchemaV1InferInput<Contract[Method]["output"]>>;
};

type PluginRpcCallInput<Method extends PluginRpcMethodContract> =
  StandardSchemaV1InferInput<Method["input"]>;

export type PluginRpcCallArgs<Method extends PluginRpcMethodContract> =
  null extends PluginRpcCallInput<Method>
    ? [input?: PluginRpcCallInput<Method>]
    : [input: PluginRpcCallInput<Method>];

export type PluginRpcResult<Method extends PluginRpcMethodContract> =
  StandardSchemaV1InferOutput<Method["output"]>;
