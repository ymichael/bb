import { StringDecoder } from "node:string_decoder";

export const MAX_JSON_RPC_LINE_BYTES = 64 * 1024 * 1024;

export interface BoundedLineReaderArgs {
  input: NodeJS.ReadableStream;
  onLine: (line: string) => void;
  onOverflow: (bytes: number) => void;
  onClose?: () => void;
  maxLineBytes?: number;
}

export function readBoundedLines(args: BoundedLineReaderArgs): void {
  const maxLineBytes = args.maxLineBytes ?? MAX_JSON_RPC_LINE_BYTES;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  let discardedBytes = 0;

  args.input.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (;;) {
      const newlineIndex = text.indexOf("\n", start);
      if (newlineIndex === -1) {
        break;
      }
      if (discarding) {
        discarding = false;
        args.onOverflow(discardedBytes);
        discardedBytes = 0;
      } else {
        emit(pending + text.slice(start, newlineIndex));
      }
      pending = "";
      start = newlineIndex + 1;
    }
    const tail = text.slice(start);
    if (discarding) {
      discardedBytes += Buffer.byteLength(tail);
      return;
    }
    pending += tail;
    if (Buffer.byteLength(pending) > maxLineBytes) {
      discarding = true;
      discardedBytes = Buffer.byteLength(pending);
      pending = "";
    }
  });

  args.input.on("end", () => {
    if (!discarding && pending.length > 0) {
      emit(pending);
    }
    pending = "";
    args.onClose?.();
  });

  function emit(line: string): void {
    args.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}
