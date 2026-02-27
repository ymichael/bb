import { toUIMessages, type ThreadEvent } from "@beanbag/agent-core";

export interface ThreadAttributedDiff {
  changedFiles: number;
  insertions: number;
  deletions: number;
  files: Array<{ path: string; status: string }>;
}

function countDiffLines(diff: string | undefined): { insertions: number; deletions: number } {
  if (!diff) return { insertions: 0, deletions: 0 };
  let insertions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { insertions, deletions };
}

function toStatus(kind: string | undefined): string {
  switch (kind) {
    case "add":
      return "A";
    case "delete":
      return "D";
    case "update":
      return "M";
    default:
      return "M";
  }
}

export class ThreadAttributedDiffService {
  compute(events: ThreadEvent[]): ThreadAttributedDiff {
    const messages = toUIMessages(events, {
      includeDebugRawEvents: false,
      includeOptionalOperations: false,
    });

    const byPath = new Map<string, { status: string; insertions: number; deletions: number }>();

    for (const message of messages) {
      if (message.kind !== "file-edit") continue;
      for (const change of message.changes) {
        const current = byPath.get(change.path) ?? {
          status: toStatus(change.kind),
          insertions: 0,
          deletions: 0,
        };
        const nextCount = countDiffLines(change.diff);
        byPath.set(change.path, {
          status: toStatus(change.kind),
          insertions: Math.max(current.insertions, nextCount.insertions),
          deletions: Math.max(current.deletions, nextCount.deletions),
        });
      }
    }

    const files = [...byPath.entries()]
      .map(([path, value]) => ({ path, status: value.status }))
      .sort((a, b) => a.path.localeCompare(b.path));

    let insertions = 0;
    let deletions = 0;
    for (const value of byPath.values()) {
      insertions += value.insertions;
      deletions += value.deletions;
    }

    return {
      changedFiles: files.length,
      insertions,
      deletions,
      files,
    };
  }
}
