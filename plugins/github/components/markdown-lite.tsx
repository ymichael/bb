import { cn } from "@bb/shared-ui/lib/utils";
import { UrlLink as UrlLink } from "@get-bb/plugin-sdk/app";

const INLINE_PATTERN =
  /(!\[[^\]]*\]\([^)\s]+\))|(<img\s[^>]*?\/?>)|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function imgAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return match?.[1];
}

function renderImage(
  key: number,
  src: string | undefined,
  alt: string,
  raw: string,
  width?: string,
  height?: string,
): React.ReactNode {
  if (!src || !/^https?:\/\//.test(src)) return raw;
  return (
    <img
      key={key}
      src={src}
      alt={alt}
      loading="lazy"
      {...(width && /^\d+$/.test(width) ? { width: Number(width) } : {})}
      {...(height && /^\d+$/.test(height) ? { height: Number(height) } : {})}
      className="my-1 inline-block h-auto max-w-full rounded-md border border-border"
    />
  );
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const token = match[0];
    if (token.startsWith("![")) {
      const closeBracket = token.indexOf("](");
      nodes.push(
        renderImage(
          key++,
          token.slice(closeBracket + 2, -1),
          token.slice(2, closeBracket),
          token,
        ),
      );
    } else if (token.startsWith("<img")) {
      nodes.push(
        renderImage(
          key++,
          imgAttribute(token, "src"),
          imgAttribute(token, "alt") ?? "",
          token,
          imgAttribute(token, "width"),
          imgAttribute(token, "height"),
        ),
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key++}
          className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>);
    } else {
      const closeBracket = token.indexOf("](");
      const label = token.slice(1, closeBracket);
      const href = token.slice(closeBracket + 2, -1);
      nodes.push(
        <UrlLink
          key={key++}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          {renderInline(label)}
        </UrlLink>,
      );
    }
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type TableAlignment = "left" | "center" | "right" | null;

interface ParsedTable {
  alignments: TableAlignment[];
  header: string[];
  rows: string[][];
  nextLine: number;
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function hasUnescapedPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "|" && !isEscaped(line, i)) return true;
  }
  return false;
}

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !isEscaped(row, row.length - 1)) {
    row = row.slice(0, -1);
  }

  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < row.length; i++) {
    if (row[i] === "|" && !isEscaped(row, i)) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    if (row[i] === "|" && cell.endsWith("\\")) {
      cell = cell.slice(0, -1);
    }
    cell += row[i];
  }
  cells.push(cell.trim());
  return cells;
}

function parseTableAlignment(cell: string): TableAlignment | undefined {
  if (!/^:?-+:?$/.test(cell)) return undefined;
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function parseTable(lines: string[], startLine: number): ParsedTable | null {
  if (startLine + 1 >= lines.length) return null;
  const headerLine = lines[startLine];
  const delimiterLine = lines[startLine + 1];
  if (!hasUnescapedPipe(headerLine) || !hasUnescapedPipe(delimiterLine)) {
    return null;
  }

  const header = splitTableRow(headerLine);
  const delimiterCells = splitTableRow(delimiterLine);
  if (header.length !== delimiterCells.length) return null;

  const alignments: TableAlignment[] = [];
  for (const cell of delimiterCells) {
    const alignment = parseTableAlignment(cell);
    if (alignment === undefined) return null;
    alignments.push(alignment);
  }

  const rows: string[][] = [];
  let nextLine = startLine + 2;
  while (
    nextLine < lines.length &&
    lines[nextLine].trim() !== "" &&
    hasUnescapedPipe(lines[nextLine])
  ) {
    const cells = splitTableRow(lines[nextLine]).slice(0, header.length);
    while (cells.length < header.length) cells.push("");
    rows.push(cells);
    nextLine++;
  }

  return { alignments, header, rows, nextLine };
}

function tableAlignmentClass(alignment: TableAlignment): string {
  switch (alignment) {
    case "center":
      return "text-center";
    case "right":
      return "text-right";
    default:
      return "text-left";
  }
}

const HEADING_CLASSES = [
  "text-lg font-semibold",
  "text-base font-semibold",
  "text-sm font-semibold",
];

export function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = line.match(/^```/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs"
        >
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      const Tag = `h${heading[1].length <= 3 ? heading[1].length : 4}` as
        | "h1"
        | "h2"
        | "h3"
        | "h4";
      blocks.push(
        <Tag key={key++} className={HEADING_CLASSES[level - 1]}>
          {renderInline(heading[2])}
        </Tag>,
      );
      i++;
      continue;
    }
    const table = parseTable(lines, i);
    if (table) {
      blocks.push(
        <div key={key++} className="overflow-x-auto">
          <table className="w-max min-w-full border-collapse border border-border">
            <thead className="bg-surface-recessed">
              <tr>
                {table.header.map((cell, column) => (
                  <th
                    key={column}
                    className={cn(
                      "border border-border px-2 py-1 font-medium",
                      tableAlignmentClass(table.alignments[column]),
                    )}
                  >
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td
                      key={column}
                      className={cn(
                        "border border-border px-2 py-1",
                        tableAlignmentClass(table.alignments[column]),
                      )}
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = table.nextLine;
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        items.push(
          <li key={key++}>{renderInline(lines[i].replace(/^\s*-\s+/, ""))}</li>,
        );
        i++;
      }
      blocks.push(
        <ul key={key++} className="list-disc space-y-1 pl-5">
          {items}
        </ul>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*-\s+/.test(lines[i]) &&
      parseTable(lines, i) === null
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="whitespace-pre-wrap break-words">
        {renderInline(para.join("\n"))}
      </p>,
    );
  }
  return <div className={cn("space-y-3", className)}>{blocks}</div>;
}
