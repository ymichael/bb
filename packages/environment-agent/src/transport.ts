export interface JsonLineTransportHandlers {
  onLine: (line: string) => void;
  onStderrLine?: (line: string) => void;
  onClose?: (reason?: Error) => void;
}

export interface JsonLineTransport {
  setHandlers(handlers: JsonLineTransportHandlers): void;
  send(line: string): void;
  close(reason?: Error): void;
}
