import type { ThreadTimelineResponse, TimelineRow } from "@bb/server-contract";

export const DEFAULT_MAX_INLINE_OUTPUT_CHARS = 32_000;

const TRUNCATION_SUFFIX_TAIL = " more characters truncated]";

function truncationSuffix(dropped: number): string {
  return `\n…[${dropped.toLocaleString("en-US")}${TRUNCATION_SUFFIX_TAIL}`;
}

function truncateString(value: string, max: number): string {
  if (value.length <= max || value.endsWith(TRUNCATION_SUFFIX_TAIL)) {
    return value;
  }
  return `${value.slice(0, max)}${truncationSuffix(value.length - max)}`;
}

function truncateRow(row: TimelineRow, max: number): TimelineRow {
  if (row.kind === "turn") {
    if (!row.children) {
      return row;
    }
    const children = truncateRows(row.children, max);
    return children === row.children ? row : { ...row, children };
  }

  if (row.kind !== "work") {
    return row;
  }

  switch (row.workKind) {
    case "command":
    case "tool": {
      const output = truncateString(row.output, max);
      return output === row.output ? row : { ...row, output };
    }
    case "file-change": {
      const diff =
        row.change.diff === null ? null : truncateString(row.change.diff, max);
      const stdout =
        row.stdout === null ? null : truncateString(row.stdout, max);
      const stderr =
        row.stderr === null ? null : truncateString(row.stderr, max);
      if (
        diff === row.change.diff &&
        stdout === row.stdout &&
        stderr === row.stderr
      ) {
        return row;
      }
      return {
        ...row,
        change: diff === row.change.diff ? row.change : { ...row.change, diff },
        stdout,
        stderr,
      };
    }
    case "delegation": {
      const output = truncateString(row.output, max);
      const childRows = truncateRows(row.childRows, max);
      if (output === row.output && childRows === row.childRows) {
        return row;
      }
      return { ...row, output, childRows };
    }
    default:
      return row;
  }
}

function truncateRows(rows: TimelineRow[], max: number): TimelineRow[] {
  let changed = false;
  const next = rows.map((row) => {
    const truncated = truncateRow(row, max);
    if (truncated !== row) {
      changed = true;
    }
    return truncated;
  });
  return changed ? next : rows;
}

export function truncateTimelineResponseOutputs(
  response: ThreadTimelineResponse,
  max: number = DEFAULT_MAX_INLINE_OUTPUT_CHARS,
): ThreadTimelineResponse {
  const rows = truncateRows(response.rows, max);
  return rows === response.rows ? response : { ...response, rows };
}
