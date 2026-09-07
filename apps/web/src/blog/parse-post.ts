export type PostBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; items: string[] }
  | {
      kind: "image";
      src: string;
      alt: string;
      href?: string;
      caption?: string;
    }
  | { kind: "quote"; lines: string[] }
  | { kind: "tweet"; href: string; id: string };

export type Post = {
  slug: string;
  title: string;
  date: string;
  dateIso: string;
  lede: string;
  sourceLabel?: string;
  sourceHref?: string;
  cover?: { src: string; alt: string };
  blocks: PostBlock[];
};

export function isRenderableHref(href: string): boolean {
  return (
    href.startsWith("https://") ||
    href.startsWith("http://") ||
    href.startsWith("/") ||
    href.startsWith("#")
  );
}

function formatDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Post date must be YYYY-MM-DD, got ${JSON.stringify(iso)}`);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

function parseFrontMatter(source: string): {
  fields: Record<string, string>;
  body: string;
} {
  if (!source.startsWith("---\n")) {
    throw new Error("Post must start with --- front matter");
  }
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("Post front matter is not closed");
  }
  const fields: Record<string, string> = {};
  for (const line of source.slice(4, end).split("\n")) {
    if (!line) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`Invalid front matter line: ${JSON.stringify(line)}`);
    }
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fields, body: source.slice(end + 5) };
}

const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/;
const LINKED_IMAGE_RE = /^\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)$/;
const CAPTION_RE = /^\*(.+)\*$/;
const TWEET_RE =
  /^tweet:(https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/(\d+)(?:\?.*)?)$/;

function parseImage(
  line: string,
): Extract<PostBlock, { kind: "image" }> | null {
  const linked = LINKED_IMAGE_RE.exec(line);
  if (linked) {
    const src = linked[2];
    const href = linked[3];
    if (!isRenderableHref(src) || !isRenderableHref(href)) {
      return null;
    }
    return { kind: "image", alt: linked[1], src, href };
  }
  const image = IMAGE_RE.exec(line);
  if (!image) {
    return null;
  }
  const src = image[2];
  if (!isRenderableHref(src)) {
    return null;
  }
  return { kind: "image", alt: image[1], src };
}

export function parsePost(slug: string, source: string): Post {
  const { fields, body } = parseFrontMatter(source);
  const title = fields.title;
  const dateIso = fields.date;
  const lede = fields.lede;
  if (!title || !dateIso || !lede) {
    throw new Error(`Post ${slug} is missing title, date, or lede`);
  }
  if (fields.sourceHref && !isRenderableHref(fields.sourceHref)) {
    throw new Error(`Post ${slug} has a non-renderable sourceHref`);
  }

  const blocks: PostBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) {
      return;
    }
    blocks.push({ kind: "list", items: list });
    list = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) {
      return;
    }
    blocks.push({ kind: "quote", lines: quote });
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) {
      flushAll();
      continue;
    }

    if (line.startsWith("## ")) {
      flushAll();
      blocks.push({ kind: "heading", text: line.slice(3) });
      continue;
    }

    const tweet = TWEET_RE.exec(line);
    if (tweet) {
      flushAll();
      blocks.push({ kind: "tweet", href: tweet[1], id: tweet[2] });
      continue;
    }

    const caption = CAPTION_RE.exec(line);
    const last = blocks.at(-1);
    if (
      caption &&
      last?.kind === "image" &&
      paragraph.length === 0 &&
      list.length === 0 &&
      quote.length === 0
    ) {
      last.caption = caption[1];
      continue;
    }

    if (line.startsWith("- ")) {
      flushParagraph();
      flushQuote();
      list.push(line.slice(2));
      continue;
    }

    if (list.length > 0 && /^\s{2,}\S/.test(line)) {
      list[list.length - 1] += ` ${line.trim()}`;
      continue;
    }

    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      const quoted = line.startsWith("> ") ? line.slice(2) : line.slice(1);
      if (quoted) {
        quote.push(quoted);
      }
      continue;
    }

    const image = parseImage(line);
    if (image) {
      flushAll();
      blocks.push(image);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }
  flushAll();

  const firstImage = blocks.find((block) => block.kind === "image");
  const coverFromField =
    fields.coverSrc && isRenderableHref(fields.coverSrc)
      ? { src: fields.coverSrc, alt: fields.coverAlt ?? title }
      : undefined;
  return {
    slug,
    title,
    dateIso,
    date: formatDate(dateIso),
    lede,
    sourceLabel: fields.sourceLabel,
    sourceHref: fields.sourceHref,
    cover:
      coverFromField ??
      (firstImage ? { src: firstImage.src, alt: firstImage.alt } : undefined),
    blocks,
  };
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}
