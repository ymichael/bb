declare const __untyped: unique symbol;

/** Sentinel type for endpoints whose output is not yet explicitly typed.
 *  Any consumer that tries to use the output without explicitly typing the
 *  route gets a tsc error — no lint rules needed. */
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
export type PathId = { param: { id: string } };
export type PathProjectId = { param: { id: string } };
export type PathThreadAndDraft = { param: { id: string; draftId: string } };
