import { stripVTControlCharacters } from "node:util";

interface TerminalOutputLineReader {
  flush(): string[];
  push(text: string): string[];
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
      const strippedText = stripVTControlCharacters(text);
      for (let index = 0; index < strippedText.length; index += 1) {
        const character = strippedText[index];
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
