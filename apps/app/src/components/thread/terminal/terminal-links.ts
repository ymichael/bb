import type { ILinkHandler } from "@xterm/xterm";

export interface TerminalLinkTarget {
  source: "detected-url" | "osc8";
  uri: string;
}

interface CreateTerminalOsc8LinkHandlerArgs {
  onActivate: (target: TerminalLinkTarget) => void;
  onHover: (target: TerminalLinkTarget | null) => void;
}

interface RequestTerminalLinkOpenArgs {
  openLink: (uri: string) => void;
  requestConfirmation: (target: TerminalLinkTarget) => void;
  target: TerminalLinkTarget;
}

export function createTerminalOsc8LinkHandler({
  onActivate,
  onHover,
}: CreateTerminalOsc8LinkHandlerArgs): ILinkHandler {
  return {
    activate: (event, uri) => {
      if (event.button !== 0) {
        return;
      }
      onActivate({ source: "osc8", uri });
    },
    hover: (_event, uri) => {
      onHover({ source: "osc8", uri });
    },
    leave: () => {
      onHover(null);
    },
  };
}

export function requestTerminalLinkOpen({
  openLink,
  requestConfirmation,
  target,
}: RequestTerminalLinkOpenArgs): void {
  if (target.source === "osc8") {
    requestConfirmation(target);
    return;
  }
  openLink(target.uri);
}
