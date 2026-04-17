/**
 * Contract-enforced route registration for Hono.
 *
 * Hono's built-in `.get()` / `.post()` methods infer the schema from the
 * handler (bottom-up). They never constrain the handler against a pre-declared
 * schema. These helpers close that gap: given a schema type like
 * `PublicApiSchema`, they extract the expected `Input` and `Output` for each
 * route and enforce both at compile time.
 *
 * **Output**: the handler's `c.json()` argument must match the contract's
 * declared Output type.
 *
 * **Input**:
 * - if the contract declares `{ json: T }`, the registration call requires a
 *   `ZodType<T>` schema. The wrapper validates the request body automatically
 *   and passes the parsed value to the handler.
 * - if the contract declares `{ query: T }`, the registration call requires a
 *   `ZodType<T>` schema. The wrapper validates the query parameters and passes
 *   the parsed value to the handler.
 *
 * @example
 * ```ts
 * const { get, post } = typedRoutes<PublicApiSchema>(app);
 *
 * // GET with query validation:
 * get("/threads", threadListQuerySchema, (c, query) => c.json([]));
 *
 * // POST — schema required, body pre-validated, output type-checked:
 * post("/projects", createProjectRequestSchema, async (c, body) => {
 *   const project = createProject(deps.db, body);
 *   return c.json(project, 201);
 * });
 * ```
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodType } from "zod";
import type { Endpoint } from "./endpoint.js";

// ---------------------------------------------------------------------------
// Type-level extraction
// ---------------------------------------------------------------------------

type EndpointInput<E> = E extends Endpoint<infer I, any, any, any> ? I : never;

/** Extract `T` from `{ json: T }` in the Endpoint's Input, or `never`. */
type JsonBody<I> = "json" extends keyof I
  ? I extends { json: infer J }
    ? J
    : never
  : never;

/** Extract `T` from `{ query: T }` in the Endpoint's Input, or `never`. */
type QueryInput<I> = "query" extends keyof I
  ? I extends { query?: infer Q }
    ? Q
    : never
  : never;

type RouteInputForMethod<MKey extends MethodKey, I> = MKey extends "$get"
  ? QueryInput<I>
  : JsonBody<I>;

// ---------------------------------------------------------------------------
// Constrained context & handler types
// ---------------------------------------------------------------------------

type HandlerReturn = Response | Promise<Response>;

/**
 * Build the valid argument tuples for `json()` from an Endpoint (or union).
 *
 * Each union member produces its own `[data, status]` or `[data]` tuple.
 * The result is a union of tuples, so `c.json(A, 200)` and `c.json(B, 409)`
 * are both legal but `c.json(A, 409)` is not — TypeScript checks the tuple
 * as a whole, preserving the output↔status pairing.
 */
type TypedJsonArgs<E> =
  E extends Endpoint<any, infer O, infer S extends ContentfulStatusCode, any>
    ? 200 extends S
      ? [data: O] | [data: O, status: S]
      : [data: O, status: S]
    : never;

/**
 * A Context with a constrained `json()` method.
 *
 * For union endpoints, `json()` accepts a union of argument tuples —
 * one per Endpoint member — so the output↔status pairing is preserved.
 */
type TypedContext<E, Path extends string> = Omit<Context<{}, Path>, "json"> & {
  json: (...args: TypedJsonArgs<E>) => Response;
};

/** Handler that receives context only (no request body). */
type NoBodyHandler<E, Path extends string> = (
  c: TypedContext<E, Path>,
) => HandlerReturn;

/** Handler that receives context + pre-validated request input. */
type WithInputHandler<E, Input, Path extends string> = (
  c: TypedContext<E, Path>,
  input: Input,
) => HandlerReturn;

// ---------------------------------------------------------------------------
// Registration overloads
// ---------------------------------------------------------------------------

type MethodKey = "$get" | "$post" | "$patch" | "$delete" | "$put";
type HttpMethod = "get" | "post" | "patch" | "delete" | "put";
type InputSource = "json" | "query";

/**
 * Typed route registration.
 *
 * - If the endpoint declares `{ json: T }` or `{ query: T }` input
 *   → requires `(path, schema, handler)`
 * - Otherwise → requires `(path, handler)`
 */
type TypedRegister<Schema, MKey extends MethodKey> = <
  Path extends string & keyof Schema,
  E extends MKey extends keyof Schema[Path] ? Schema[Path][MKey] : never,
  Input extends RouteInputForMethod<MKey, EndpointInput<E>>,
>(
  ...args: [Input] extends [never]
    ? [path: Path, handler: NoBodyHandler<E, Path>]
    : [
        path: Path,
        schema: ZodType<Input>,
        handler: WithInputHandler<E, Input, Path>,
      ]
) => void;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface TypedRoutesOptions {
  /** Factory for validation errors. Receives the Zod issue message. */
  onValidationError?: (message: string) => Error;
}

type ValidationMessageFromZodError = (error: ZodError) => string;

const zodV4MissingInputMessagePrefix = "Invalid input: expected ";
const zodV4MissingInputMessageSuffix = ", received undefined";

const validationMessageFromZodError: ValidationMessageFromZodError = (
  error,
) => {
  const issue = error.issues[0];
  if (!issue) {
    return "Invalid request";
  }
  if (
    issue.code === "invalid_type" &&
    issue.input === undefined &&
    issue.message.startsWith(zodV4MissingInputMessagePrefix) &&
    issue.message.endsWith(zodV4MissingInputMessageSuffix)
  ) {
    return "Required";
  }
  return issue.message;
};

export function typedRoutes<Schema>(
  app: Hono<any, any, any>,
  options?: TypedRoutesOptions,
) {
  const makeError =
    options?.onValidationError ?? ((msg: string) => new Error(msg));

  function register(
    method: HttpMethod,
    inputSource: InputSource,
    path: string,
    schemaOrHandler: ZodType | Function,
    maybeHandler?: Function,
  ): void {
    if (typeof schemaOrHandler === "function") {
      // No body — just (path, handler)
      (app as any)[method](path, schemaOrHandler);
    } else {
      // With validated input — (path, schema, handler)
      const schema = schemaOrHandler;
      const handler = maybeHandler!;
      (app as any)[method](path, async (c: Context) => {
        let input: unknown;
        if (inputSource === "query") {
          input = c.req.query();
        } else {
          try {
            input = await c.req.json();
          } catch {
            throw makeError("Invalid JSON request body");
          }
        }
        let parsed: unknown;
        try {
          parsed = schema.parse(input);
        } catch (error) {
          if (error instanceof ZodError) {
            throw makeError(validationMessageFromZodError(error));
          }
          throw error;
        }
        return handler(c, parsed);
      });
    }
  }

  return {
    get: ((...args: [string, ...any[]]) =>
      register("get", "query", args[0], args[1], args[2])) as TypedRegister<
      Schema,
      "$get"
    >,
    post: ((...args: [string, ...any[]]) =>
      register("post", "json", args[0], args[1], args[2])) as TypedRegister<
      Schema,
      "$post"
    >,
    patch: ((...args: [string, ...any[]]) =>
      register("patch", "json", args[0], args[1], args[2])) as TypedRegister<
      Schema,
      "$patch"
    >,
    del: ((...args: [string, ...any[]]) =>
      register("delete", "json", args[0], args[1], args[2])) as TypedRegister<
      Schema,
      "$delete"
    >,
    put: ((...args: [string, ...any[]]) =>
      register("put", "json", args[0], args[1], args[2])) as TypedRegister<
      Schema,
      "$put"
    >,
  };
}
