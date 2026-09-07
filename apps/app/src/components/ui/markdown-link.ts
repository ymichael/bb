interface MarkdownPreviewLink {
  href: string;
}

export type MarkdownPreviewLinkHandler = (link: MarkdownPreviewLink) => boolean;
