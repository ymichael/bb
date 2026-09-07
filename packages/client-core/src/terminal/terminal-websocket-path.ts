export interface BuildTerminalWebSocketPathArgs {
  terminalId: string;
}

export function buildTerminalWebSocketPath({
  terminalId,
}: BuildTerminalWebSocketPathArgs): string {
  return `/ws/terminals/${encodeURIComponent(terminalId)}`;
}
