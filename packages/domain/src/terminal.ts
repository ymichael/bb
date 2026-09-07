import { z } from "zod";

export const TERMINAL_COLS_MAX = 500;
export const TERMINAL_ROWS_MAX = 200;
export const TERMINAL_DATA_MAX_BYTES = 64 * 1024;
export const TERMINAL_DATA_MAX_BASE64_LENGTH =
  Math.ceil(TERMINAL_DATA_MAX_BYTES / 3) * 4;

const terminalBase64DataPattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const terminalSessionStatusValues = [
  "starting",
  "running",
  "disconnected",
  "exited",
] as const;
export const terminalSessionStatusSchema = z.enum(terminalSessionStatusValues);
export type TerminalSessionStatus = z.infer<typeof terminalSessionStatusSchema>;

export function isActiveTerminalSessionStatus(
  status: TerminalSessionStatus,
): boolean {
  switch (status) {
    case "starting":
    case "running":
      return true;
    case "disconnected":
    case "exited":
      return false;
  }
}

const terminalSessionCloseReasonValues = [
  "user",
  "process-exit",
  "daemon-disconnect",
  "environment-destroyed",
  "thread-archived",
  "thread-deleted",
  "open-timeout",
] as const;
export const terminalSessionCloseReasonSchema = z.enum(
  terminalSessionCloseReasonValues,
);
export type TerminalSessionCloseReason = z.infer<
  typeof terminalSessionCloseReasonSchema
>;

interface TerminalOutputLineReader {
  flush(): string[];
  push(text: string): string[];
}

export function getTerminalBase64DecodedByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function createTerminalOutputLineReader(): TerminalOutputLineReader {
  let currentLine = "";
  let pendingCarriageReturn = false;

  const pushCompletedLine = (lines: string[]): void => {
    if (currentLine.trim().length > 0) {
      lines.push(currentLine);
    }
    currentLine = "";
  };

  return {
    flush(): string[] {
      const lines: string[] = [];
      pendingCarriageReturn = false;
      pushCompletedLine(lines);
      return lines;
    },
    push(text: string): string[] {
      const lines: string[] = [];
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (pendingCarriageReturn) {
          pendingCarriageReturn = false;
          if (character === "\n") {
            pushCompletedLine(lines);
            continue;
          }
          currentLine = "";
        }
        if (character === "\r") {
          pendingCarriageReturn = true;
          continue;
        }
        if (character === "\n") {
          pushCompletedLine(lines);
          continue;
        }
        currentLine += character;
      }
      return lines;
    },
  };
}

export function readTerminalOutputLines(text: string): string[] {
  const reader = createTerminalOutputLineReader();
  return [...reader.push(text), ...reader.flush()];
}

export const terminalColsSchema = z
  .number()
  .int()
  .positive()
  .max(TERMINAL_COLS_MAX);
export const terminalRowsSchema = z
  .number()
  .int()
  .positive()
  .max(TERMINAL_ROWS_MAX);
export const terminalDataBase64Schema = z
  .string()
  .min(1)
  .max(TERMINAL_DATA_MAX_BASE64_LENGTH)
  .regex(terminalBase64DataPattern)
  .refine(
    (value) =>
      getTerminalBase64DecodedByteLength(value) <= TERMINAL_DATA_MAX_BYTES,
    {
      message: `Terminal data must decode to ${TERMINAL_DATA_MAX_BYTES} bytes or less`,
    },
  );
