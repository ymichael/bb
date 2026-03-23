declare const __untyped: unique symbol;

export type Untyped = { readonly [__untyped]: never };

export type Endpoint<
  Input,
  Output = Untyped,
  Status extends number = 200,
  Format extends "json" | "text" = "json",
> = {
  input: Input;
  output: Output;
  outputFormat: Format;
  status: Status;
};

export type EmptyInput = Record<never, never>;
