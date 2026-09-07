import changelogSource from "../../../../../CHANGELOG.md?raw";
export { RELEASE_META } from "../../../../../changelog-metadata";

const LATEST_CHANGELOG_SOURCE_URL =
  "https://raw.githubusercontent.com/get-bb/bb/main/CHANGELOG.md";

export type ChangelogBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

interface ChangelogSection {
  title: string;
  blocks: ChangelogBlock[];
}

interface ChangelogEntry {
  version: string;
  lede: ChangelogBlock[];
  sections: ChangelogSection[];
}

export function parseChangelogEntries(source: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let entry: ChangelogEntry | null = null;
  let section: ChangelogSection | null = null;
  let paragraph: string[] = [];

  const blocksInScope = (): ChangelogBlock[] | null => {
    if (entry === null) {
      return null;
    }
    return section === null ? entry.lede : section.blocks;
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const text = paragraph.join(" ").trim();
    paragraph = [];
    const blocks = blocksInScope();
    if (text !== "" && blocks !== null) {
      blocks.push({ kind: "paragraph", text });
    }
  };

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trimEnd();

    if (line.startsWith("## ") && !line.startsWith("### ")) {
      flushParagraph();
      section = null;
      entry = { version: line.slice(3).trim(), lede: [], sections: [] };
      entries.push(entry);
      continue;
    }
    if (entry === null) {
      continue;
    }
    if (line.startsWith("### ")) {
      flushParagraph();
      section = { title: line.slice(4).trim(), blocks: [] };
      entry.sections.push(section);
      continue;
    }
    if (line.startsWith("- ")) {
      flushParagraph();
      const blocks = blocksInScope();
      if (blocks === null) {
        continue;
      }
      const last = blocks.at(-1);
      const list =
        last?.kind === "list" ? last : { kind: "list" as const, items: [] };
      if (last !== list) {
        blocks.push(list);
      }
      list.items.push(line.slice(2).trim());
      continue;
    }
    if (line.startsWith("  ") && line.trim() !== "") {
      const last = blocksInScope()?.at(-1);
      if (last?.kind === "list" && last.items.length > 0) {
        last.items[last.items.length - 1] += ` ${line.trim()}`;
        continue;
      }
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();

  return entries;
}

export const CHANGELOG_ENTRIES = parseChangelogEntries(changelogSource);

export const LATEST_CHANGELOG_ENTRY: ChangelogEntry | null =
  CHANGELOG_ENTRIES[0] ?? null;

export async function fetchLatestChangelogEntry(
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<ChangelogEntry> {
  const response = await fetchFn(LATEST_CHANGELOG_SOURCE_URL, { signal });
  if (!response.ok) {
    throw new Error(`Changelog request failed (${response.status})`);
  }
  const [entry] = parseChangelogEntries(await response.text());
  if (entry === undefined) {
    throw new Error("The changelog has no releases");
  }
  return entry;
}
