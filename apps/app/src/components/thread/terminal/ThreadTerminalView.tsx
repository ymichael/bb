import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import type { Terminal as XTermTerminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { TerminalServerMessage, TerminalSession } from "@bb/server-contract";
import { terminalServerMessageSchema } from "@bb/server-contract";
import { buildTerminalWebSocketUrl } from "./terminal-websocket-url";

const TERMINAL_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace";

interface ThreadTerminalViewProps {
  session: TerminalSession;
  threadId: string;
}

interface SendTerminalResizeArgs {
  socket: WebSocket;
  terminal: XTermTerminal;
}

interface WriteTerminalStatusArgs {
  terminal: XTermTerminal;
  text: string;
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeUtf8Base64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function sendTerminalResize({
  socket,
  terminal,
}: SendTerminalResizeArgs): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(
    JSON.stringify({
      type: "resize",
      cols: terminal.cols,
      rows: terminal.rows,
    }),
  );
}

function writeTerminalStatus({ terminal, text }: WriteTerminalStatusArgs): void {
  terminal.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
}

function handleTerminalServerMessage(
  terminal: XTermTerminal,
  message: TerminalServerMessage,
): void {
  switch (message.type) {
    case "attached":
    case "pong":
    case "session-updated":
      return;
    case "output":
      terminal.write(decodeUtf8Base64(message.chunk.dataBase64));
      return;
    case "error":
      writeTerminalStatus({
        terminal,
        text: `Terminal error: ${message.message}`,
      });
      return;
    case "exited":
      writeTerminalStatus({
        terminal,
        text:
          message.session.exitCode === null
            ? "Terminal exited"
            : `Terminal exited with code ${message.session.exitCode}`,
      });
      return;
  }
}

export function ThreadTerminalView({
  session,
  threadId,
}: ThreadTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let terminal: XTermTerminal | null = null;
    let fitAddon: FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function mountTerminal(containerElement: HTMLDivElement): Promise<void> {
      const [
        { Terminal },
        { FitAddon: LoadedFitAddon },
        { WebLinksAddon },
      ] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed) {
        return;
      }

      terminal = new Terminal({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: true,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: 12,
        scrollback: 10_000,
        theme: {
          background: "#0b0d10",
          foreground: "#e5e7eb",
          cursor: "#f8fafc",
          selectionBackground: "#334155",
        },
      });
      fitAddon = new LoadedFitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(containerElement);
      fitAddon.fit();

      socket = new WebSocket(
        buildTerminalWebSocketUrl({
          terminalId: session.id,
          threadId,
        }),
      );
      const activeSocket = socket;
      const activeTerminal = terminal;

      activeSocket.onopen = () => {
        sendTerminalResize({
          socket: activeSocket,
          terminal: activeTerminal,
        });
      };
      activeSocket.onmessage = (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        let parsedMessage: unknown;
        try {
          parsedMessage = JSON.parse(event.data);
        } catch {
          return;
        }
        const result = terminalServerMessageSchema.safeParse(parsedMessage);
        if (!result.success) {
          return;
        }
        handleTerminalServerMessage(activeTerminal, result.data);
      };
      activeSocket.onclose = () => {
        if (!disposed) {
          writeTerminalStatus({
            terminal: activeTerminal,
            text: "Terminal connection closed",
          });
        }
      };
      activeTerminal.onData((data) => {
        if (activeSocket.readyState !== WebSocket.OPEN) {
          return;
        }
        activeSocket.send(
          JSON.stringify({
            type: "input",
            dataBase64: encodeUtf8Base64(data),
          }),
        );
      });

      resizeObserver = new ResizeObserver(() => {
        if (!fitAddon || !terminal || !socket) {
          return;
        }
        fitAddon.fit();
        sendTerminalResize({
          socket,
          terminal,
        });
      });
      resizeObserver.observe(containerElement);
    }

    void mountTerminal(container).catch((error) => {
      if (!disposed) {
        container.textContent =
          error instanceof Error ? error.message : String(error);
      }
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      socket?.close();
      terminal?.dispose();
    };
  }, [session.id, threadId]);

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 w-full overflow-hidden bg-[#0b0d10] p-2"
    />
  );
}
