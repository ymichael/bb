interface BuildTerminalWebSocketUrlArgs {
  terminalId: string;
  threadId: string;
}

function buildTerminalWebSocketPath({
  terminalId,
  threadId,
}: BuildTerminalWebSocketUrlArgs): string {
  return `/ws/threads/${encodeURIComponent(threadId)}/terminals/${encodeURIComponent(
    terminalId,
  )}`;
}

export function buildTerminalWebSocketUrl(
  args: BuildTerminalWebSocketUrlArgs,
): string {
  const path = buildTerminalWebSocketPath(args);
  if (typeof __BB_DEV_WS_URL__ === "string") {
    const url = new URL(__BB_DEV_WS_URL__);
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}
