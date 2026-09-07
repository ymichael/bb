import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError, type ZodType } from "zod";
import type { Endpoint } from "./endpoint.js";
import type {
  EndpointFromRouteDescriptor,
  RouteDefinition,
  RouteMethod,
  RouteParsedInput,
} from "./route-descriptor.js";

type EndpointInput<E> = E extends Endpoint<infer I, any, any, any> ? I : never;

type JsonBody<I> = "json" extends keyof I
  ? I extends { json: infer J }
    ? J
    : never
  : never;

type QueryInput<I> = "query" extends keyof I
  ? I extends { query?: infer Q }
    ? Q
    : never
  : never;

type RouteInputForMethod<MKey extends MethodKey, I> = MKey extends "$get"
  ? QueryInput<I>
  : JsonBody<I>;

type HandlerReturn = Response | Promise<Response>;

type TypedJsonArgs<E> =
  E extends Endpoint<any, infer O, infer S extends ContentfulStatusCode, any>
    ? 200 extends S
      ? [data: O] | [data: O, status: S]
      : [data: O, status: S]
    : never;

type TypedContext<E, Path extends string> = Omit<Context<{}, Path>, "json"> & {
  json: (...args: TypedJsonArgs<E>) => Response;
};

type NoBodyHandler<E, Path extends string> = (
  c: TypedContext<E, Path>,
) => HandlerReturn;

type WithInputHandler<E, Input, Path extends string> = (
  c: TypedContext<E, Path>,
  input: Input,
) => HandlerReturn;

type MethodKey = "$get" | "$post" | "$patch" | "$delete" | "$put";
type HttpMethod = "get" | "post" | "patch" | "delete" | "put";
type InputSource = "json" | "query";
type RuntimeInputSource = InputSource | "none" | "form";

type TypedRegister<Schema, MKey extends MethodKey> = <
  Path extends string & keyof Schema,
  E extends (MKey extends keyof Schema[Path] ? Schema[Path][MKey] : never),
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

type DescriptorHandler<
  Descriptor extends RouteDefinition,
  E extends EndpointFromRouteDescriptor<Descriptor>,
  ParsedInput extends RouteParsedInput<Descriptor["request"]>,
> = [ParsedInput] extends [never]
  ? NoBodyHandler<E, Descriptor["path"]>
  : WithInputHandler<E, ParsedInput, Descriptor["path"]>;

type TypedDescriptorRegister<Method extends RouteMethod> = <
  Descriptor extends RouteDefinition<string, Method>,
  E extends EndpointFromRouteDescriptor<Descriptor>,
  ParsedInput extends RouteParsedInput<Descriptor["request"]>,
>(
  descriptor: Descriptor,
  handler: DescriptorHandler<Descriptor, E, ParsedInput>,
) => void;

type TypedRegisterWithDescriptor<
  Schema,
  MKey extends MethodKey,
  Method extends RouteMethod,
> = TypedRegister<Schema, MKey> & TypedDescriptorRegister<Method>;

interface TypedRoutesOptions {
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
    inputSource: RuntimeInputSource,
    path: string,
    schemaOrHandler: ZodType | Function,
    maybeHandler?: Function,
  ): void {
    if (inputSource === "none" || inputSource === "form") {
      (app as any)[method](path, schemaOrHandler);
    } else if (typeof schemaOrHandler === "function") {
      (app as any)[method](path, schemaOrHandler);
    } else {
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

  function registerDescriptor(
    method: HttpMethod,
    descriptor: RouteDefinition,
    handler: Function,
  ): void {
    if (
      descriptor.request.source === "query" ||
      descriptor.request.source === "json"
    ) {
      register(
        method,
        descriptor.request.source,
        descriptor.path,
        descriptor.request.schema,
        handler,
      );
      return;
    }
    register(method, descriptor.request.source, descriptor.path, handler);
  }

  function registerFromArgs(
    method: HttpMethod,
    inputSource: InputSource,
    args: [string | RouteDefinition, ...any[]],
  ): void {
    const firstArg = args[0];
    if (typeof firstArg === "string") {
      register(method, inputSource, firstArg, args[1], args[2]);
      return;
    }
    registerDescriptor(method, firstArg, args[1]);
  }

  return {
    get: ((...args: [string | RouteDefinition, ...any[]]) =>
      registerFromArgs("get", "query", args)) as TypedRegisterWithDescriptor<
      Schema,
      "$get",
      "get"
    >,
    post: ((...args: [string | RouteDefinition, ...any[]]) =>
      registerFromArgs("post", "json", args)) as TypedRegisterWithDescriptor<
      Schema,
      "$post",
      "post"
    >,
    patch: ((...args: [string | RouteDefinition, ...any[]]) =>
      registerFromArgs("patch", "json", args)) as TypedRegisterWithDescriptor<
      Schema,
      "$patch",
      "patch"
    >,
    del: ((...args: [string | RouteDefinition, ...any[]]) =>
      registerFromArgs("delete", "json", args)) as TypedRegisterWithDescriptor<
      Schema,
      "$delete",
      "delete"
    >,
    put: ((...args: [string | RouteDefinition, ...any[]]) =>
      registerFromArgs("put", "json", args)) as TypedRegisterWithDescriptor<
      Schema,
      "$put",
      "put"
    >,
  };
}
