export type ReleaseBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

type ReleaseSection = {
  title: string;
  blocks: ReleaseBlock[];
};

export type Release = {
  version: string;
  lede: ReleaseBlock[];
  sections: ReleaseSection[];
};

export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let section: ReleaseSection | null = null;
  let paragraph: string[] = [];

  const blocksInScope = (): ReleaseBlock[] | null => {
    if (!release) {
      return null;
    }
    return section ? section.blocks : release.lede;
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    const text = paragraph.join(" ").trim();
    paragraph = [];
    const blocks = blocksInScope();
    if (text && blocks) {
      blocks.push({ kind: "paragraph", text });
    }
  };

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trimEnd();

    if (line.startsWith("## ") && !line.startsWith("### ")) {
      flushParagraph();
      section = null;
      release = { version: line.slice(3).trim(), lede: [], sections: [] };
      releases.push(release);
      continue;
    }
    if (!release) {
      continue;
    }
    if (line.startsWith("### ")) {
      flushParagraph();
      section = { title: line.slice(4).trim(), blocks: [] };
      release.sections.push(section);
      continue;
    }
    if (line.startsWith("- ")) {
      flushParagraph();
      const blocks = blocksInScope();
      if (!blocks) {
        continue;
      }
      const last = blocks.at(-1);
      let list = last?.kind === "list" ? last : null;
      if (!list) {
        list = { kind: "list", items: [] };
        blocks.push(list);
      }
      list.items.push(line.slice(2).trim());
      continue;
    }
    if (line.startsWith("  ") && line.trim()) {
      const last = blocksInScope()?.at(-1);
      if (last?.kind === "list" && last.items.length > 0) {
        last.items[last.items.length - 1] += ` ${line.trim()}`;
        continue;
      }
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();

  return releases;
}
