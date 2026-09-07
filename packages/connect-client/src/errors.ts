type ConnectListErrorCode =
  | "not_paired"
  | "unauthorized"
  | "network"
  | "invalid_response";

export class ConnectListError extends Error {
  constructor(
    readonly code: ConnectListErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectListError";
  }
}
