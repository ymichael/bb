import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readBoundedLines } from "./bounded-line-reader.js";

function readAll(
  chunks: (string | Buffer)[],
  maxLineBytes: number,
): Promise<{ lines: string[]; overflows: number[] }> {
  const lines: string[] = [];
  const overflows: number[] = [];
  const input = Readable.from(chunks);
  return new Promise((resolve) => {
    readBoundedLines({
      input,
      maxLineBytes,
      onLine: (line) => lines.push(line),
      onOverflow: (bytes) => overflows.push(bytes),
      onClose: () => resolve({ lines, overflows }),
    });
  });
}

describe("readBoundedLines", () => {
  it("reassembles lines split across chunks and strips CR", async () => {
    const { lines, overflows } = await readAll(
      ['{"a":', '1}\n{"b":2}\r\n', "trailing-without-newline"],
      1024,
    );
    expect(lines).toEqual(['{"a":1}', '{"b":2}', "trailing-without-newline"]);
    expect(overflows).toEqual([]);
  });

  it("discards a line past the cap and resumes at the next one", async () => {
    const { lines, overflows } = await readAll(
      ["ok-1\n", "x".repeat(50), "y".repeat(50), "\nok-2\n"],
      64,
    );
    expect(lines).toEqual(["ok-1", "ok-2"]);
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toBeGreaterThanOrEqual(100);
  });

  it("never emits an unterminated oversized tail at end of stream", async () => {
    const { lines, overflows } = await readAll(["z".repeat(500)], 64);
    expect(lines).toEqual([]);
    expect(overflows).toEqual([]);
  });
});
