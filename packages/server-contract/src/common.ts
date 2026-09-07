export type { EmptyInput, Endpoint, Untyped } from "@bb/hono-typed-routes";

export type PathId = { param: { id: string } };
export type PathProjectId = { param: { id: string } };
export type PathThreadAndQueuedMessage = {
  param: { id: string; queuedMessageId: string };
};
export type PathThreadAndFilePath = {
  param: { id: string; filePath: string };
};
export type PathPreviewAndFilePath = {
  param: { id: string; filePath: string };
};
export type PathTerminal = {
  param: { terminalId: string };
};
