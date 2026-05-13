import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type {
  Components,
  ExtraProps,
  Options as ReactMarkdownOptions,
  UrlTransform,
} from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ImageLightbox, getWrappedImageIndex } from "./image-lightbox.js";
import { CopyButton } from "./copy-button.js";
import { Icon } from "./icon.js";
import {
  buildLocalFileAnchorHref,
  parseLocalFileHref,
  type MarkdownPreviewLocalFileLinkHandler,
} from "./markdown-local-file-link.js";
import { cn } from "@/lib/utils";

export interface MarkdownPreviewProps {
  allowHtml?: boolean;
  className?: string;
  content: string;
  expandedImageAlt?: string;
  imageLightboxTitle?: string;
  onOpenLocalFileLink?: MarkdownPreviewLocalFileLinkHandler;
}

interface MarkdownAnchorProps
  extends ComponentPropsWithoutRef<"a">, ExtraProps {
  onOpenLocalFileLink?: MarkdownPreviewLocalFileLinkHandler;
}

interface BuildMarkdownComponentsArgs {
  imageUrls: readonly string[];
  setExpandedImageIndex: ExpandedImageIndexSetter;
  onOpenLocalFileLink?: MarkdownPreviewLocalFileLinkHandler;
}

interface MarkdownImageRendererArgs {
  alt: ComponentPropsWithoutRef<"img">["alt"];
  imageUrls: readonly string[];
  setExpandedImageIndex: ExpandedImageIndexSetter;
  src: ComponentPropsWithoutRef<"img">["src"];
}

type ExpandedImageIndexSetter = Dispatch<SetStateAction<number | null>>;
type MarkdownAnchorEvent = ReactMouseEvent<HTMLAnchorElement>;
type MarkdownBlockquoteProps = ComponentPropsWithoutRef<"blockquote"> &
  ExtraProps;
type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & ExtraProps;
type MarkdownHeadingProps = ComponentPropsWithoutRef<"h1"> & ExtraProps;
type MarkdownHrProps = ComponentPropsWithoutRef<"hr"> & ExtraProps;
type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & ExtraProps;
type MarkdownListItemProps = ComponentPropsWithoutRef<"li"> & ExtraProps;
type MarkdownOrderedListProps = ComponentPropsWithoutRef<"ol"> & ExtraProps;
type MarkdownParagraphProps = ComponentPropsWithoutRef<"p"> & ExtraProps;
type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & ExtraProps;
type MarkdownTableProps = ComponentPropsWithoutRef<"table"> & ExtraProps;
type MarkdownTableCellProps = ComponentPropsWithoutRef<"td"> & ExtraProps;
type MarkdownTableHeadProps = ComponentPropsWithoutRef<"thead"> & ExtraProps;
type MarkdownTableHeaderProps = ComponentPropsWithoutRef<"th"> & ExtraProps;
type MarkdownUnorderedListProps = ComponentPropsWithoutRef<"ul"> & ExtraProps;
type MarkdownRehypePlugins = NonNullable<
  ReactMarkdownOptions["rehypePlugins"]
>;

const MARKDOWN_TABLE_BREAKOUT_WIDTH = "max(100%, min(1100px, 100cqw - 2rem))";
// Security-critical order: raw HTML must become nodes before sanitization can
// strip unsafe elements, attributes, and URLs.
const MARKDOWN_HTML_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  rehypeRaw,
  rehypeSanitize,
];

const localFileAwareUrlTransform: UrlTransform = (value, key) => {
  if (key === "href" && parseLocalFileHref(value)) {
    return value;
  }

  return defaultUrlTransform(value);
};

function extractMarkdownImageUrls(markdown: string): string[] {
  const imageUrls: string[] = [];
  const markdownImagePattern =
    /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
  let match: RegExpExecArray | null = markdownImagePattern.exec(markdown);
  while (match) {
    const imageUrl = match[1];
    if (imageUrl) {
      imageUrls.push(imageUrl);
    }
    match = markdownImagePattern.exec(markdown);
  }
  return imageUrls;
}

function MarkdownAnchor({
  children,
  href,
  onOpenLocalFileLink,
  ...anchorProps
}: MarkdownAnchorProps) {
  const localFileLink = onOpenLocalFileLink ? parseLocalFileHref(href) : null;
  const anchorHref = buildLocalFileAnchorHref(localFileLink, href);
  const handleLocalFileLinkClick = (event: MarkdownAnchorEvent) => {
    if (!localFileLink || !onOpenLocalFileLink) {
      return;
    }

    if (!onOpenLocalFileLink(localFileLink)) {
      return;
    }

    event.preventDefault();
  };

  return (
    <a
      {...anchorProps}
      href={anchorHref}
      className={cn(
        "break-words underline underline-offset-2",
        localFileLink && "inline-flex items-baseline gap-1",
      )}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleLocalFileLinkClick}
    >
      {children}
      {localFileLink ? (
        <Icon
          name="ExternalLink"
          aria-hidden
          className="size-3 shrink-0 self-center text-muted-foreground/80"
        />
      ) : null}
    </a>
  );
}

function MarkdownCode({
  className: codeClassName,
  children,
  ...props
}: MarkdownCodeProps) {
  const codeText = String(children ?? "").replace(/\n$/, "");
  const languageMatch = /language-(\w+)/u.exec(codeClassName || "");
  const language = languageMatch?.[1];
  const isBlock = language !== undefined || codeText.includes("\n");
  if (isBlock) {
    return (
      <div className="my-2 overflow-hidden rounded-md border border-border/70 bg-muted/35">
        <div className="flex items-center justify-between pl-3 pr-1.5 pt-1.5">
          <span className="font-mono text-xs uppercase text-muted-foreground/60">
            {language ?? ""}
          </span>
          <CopyButton text={codeText} label="Copy code" />
        </div>
        <pre className="overflow-x-auto px-3 pb-3 pt-1">
          <code
            className={cn(
              "font-mono text-xs",
              language ? `language-${language}` : "",
            )}
            {...props}
          >
            {codeText}
          </code>
        </pre>
      </div>
    );
  }
  return (
    <code
      className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
      {...props}
    >
      {children}
    </code>
  );
}

function MarkdownPre({ children }: MarkdownPreProps) {
  return <>{children}</>;
}

function MarkdownH1({ children }: MarkdownHeadingProps) {
  return (
    <h1 className="mb-2 mt-4 text-lg font-semibold text-foreground first:mt-0">
      {children}
    </h1>
  );
}

function MarkdownH2({ children }: MarkdownHeadingProps) {
  return (
    <h2 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">
      {children}
    </h2>
  );
}

function MarkdownH3({ children }: MarkdownHeadingProps) {
  return (
    <h3 className="mb-2 mt-3 text-sm font-semibold text-foreground first:mt-0">
      {children}
    </h3>
  );
}

function MarkdownH4({ children }: MarkdownHeadingProps) {
  return (
    <h4 className="mb-1 mt-3 text-sm font-medium text-foreground first:mt-0">
      {children}
    </h4>
  );
}

function MarkdownH5({ children }: MarkdownHeadingProps) {
  return (
    <h5 className="mb-1 mt-2 text-sm font-semibold uppercase text-muted-foreground first:mt-0">
      {children}
    </h5>
  );
}

function MarkdownH6({ children }: MarkdownHeadingProps) {
  return (
    <h6 className="mb-1 mt-2 text-xs font-semibold uppercase text-muted-foreground first:mt-0">
      {children}
    </h6>
  );
}

function MarkdownParagraph({ children }: MarkdownParagraphProps) {
  return <p className="mb-2 text-foreground last:mb-0">{children}</p>;
}

function MarkdownUnorderedList({ children }: MarkdownUnorderedListProps) {
  return <ul className="mb-2 list-disc pl-5 text-foreground">{children}</ul>;
}

function MarkdownOrderedList({ children }: MarkdownOrderedListProps) {
  return <ol className="mb-2 list-decimal pl-5 text-foreground">{children}</ol>;
}

function MarkdownListItem({ children }: MarkdownListItemProps) {
  return <li className="mb-1 text-foreground">{children}</li>;
}

function MarkdownBlockquote({ children }: MarkdownBlockquoteProps) {
  return (
    <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  );
}

function MarkdownTable({ children }: MarkdownTableProps) {
  return (
    <div
      className="my-2 flex justify-center"
      style={{
        width: MARKDOWN_TABLE_BREAKOUT_WIDTH,
        marginInline: `calc((100% - ${MARKDOWN_TABLE_BREAKOUT_WIDTH}) / 2)`,
      }}
    >
      {/*
        Inner wrapper anchors narrow tables, centers mid-width tables, and
        scrolls overflow for very wide tables. The min-width is clamped by
        100% so it never forces the wrapper wider than the breakout
        container — without that clamp, when the viewport shrinks below
        `--md-content-w` the wrapper extends past the container and the
        scrollbar gets clipped.
      */}
      <div
        className="w-max max-w-full overflow-x-auto"
        style={{ minWidth: "min(var(--md-content-w), 100%)" }}
      >
        <table className="border border-border/80">{children}</table>
      </div>
    </div>
  );
}

function MarkdownTableHead({ children }: MarkdownTableHeadProps) {
  return <thead className="bg-muted/40">{children}</thead>;
}

function MarkdownTableHeader({ children }: MarkdownTableHeaderProps) {
  return (
    <th className="border border-border/80 px-2 py-1 text-left font-medium">
      {children}
    </th>
  );
}

function MarkdownTableCell({ children }: MarkdownTableCellProps) {
  return <td className="border border-border/80 px-2 py-1">{children}</td>;
}

function renderMarkdownImage({
  alt,
  imageUrls,
  setExpandedImageIndex,
  src,
}: MarkdownImageRendererArgs) {
  const imageUrl = typeof src === "string" ? src : "";
  if (!imageUrl) return null;
  const imageIndex = imageUrls.indexOf(imageUrl);
  return (
    <img
      src={imageUrl}
      alt={typeof alt === "string" ? alt : "Image"}
      className="my-2 max-h-96 max-w-full cursor-zoom-in rounded-md border border-border/60 object-contain"
      loading="lazy"
      onClick={() => setExpandedImageIndex(imageIndex >= 0 ? imageIndex : 0)}
    />
  );
}

function MarkdownHr(_props: MarkdownHrProps) {
  return <hr className="my-4 border-t border-border/70" />;
}

function buildMarkdownComponents({
  imageUrls,
  onOpenLocalFileLink,
  setExpandedImageIndex,
}: BuildMarkdownComponentsArgs): Components {
  function MarkdownLink(props: MarkdownAnchorProps) {
    return (
      <MarkdownAnchor {...props} onOpenLocalFileLink={onOpenLocalFileLink} />
    );
  }

  function MarkdownImage({ src, alt }: MarkdownImageProps) {
    return renderMarkdownImage({
      alt,
      imageUrls,
      setExpandedImageIndex,
      src,
    });
  }

  return {
    a: MarkdownLink,
    blockquote: MarkdownBlockquote,
    code: MarkdownCode,
    h1: MarkdownH1,
    h2: MarkdownH2,
    h3: MarkdownH3,
    h4: MarkdownH4,
    h5: MarkdownH5,
    h6: MarkdownH6,
    hr: MarkdownHr,
    img: MarkdownImage,
    li: MarkdownListItem,
    ol: MarkdownOrderedList,
    p: MarkdownParagraph,
    pre: MarkdownPre,
    table: MarkdownTable,
    td: MarkdownTableCell,
    th: MarkdownTableHeader,
    thead: MarkdownTableHead,
    ul: MarkdownUnorderedList,
  };
}

function MarkdownPreviewComponent({
  allowHtml = false,
  className,
  content,
  expandedImageAlt = "Expanded image",
  imageLightboxTitle = "Expanded image preview",
  onOpenLocalFileLink,
}: MarkdownPreviewProps) {
  const imageUrls = useMemo(() => extractMarkdownImageUrls(content), [content]);
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const currentImageUrl =
    expandedImageIndex !== null
      ? (imageUrls[expandedImageIndex] ?? null)
      : null;
  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents({
        imageUrls,
        onOpenLocalFileLink,
        setExpandedImageIndex,
      }),
    [imageUrls, onOpenLocalFileLink, setExpandedImageIndex],
  );

  const showPreviousImage = useCallback(() => {
    setExpandedImageIndex((currentIndex) => {
      if (currentIndex === null || imageUrls.length <= 1) return currentIndex;
      return getWrappedImageIndex({
        currentIndex,
        direction: "previous",
        itemCount: imageUrls.length,
      });
    });
  }, [imageUrls.length]);

  const showNextImage = useCallback(() => {
    setExpandedImageIndex((currentIndex) => {
      if (currentIndex === null || imageUrls.length <= 1) return currentIndex;
      return getWrappedImageIndex({
        currentIndex,
        direction: "next",
        itemCount: imageUrls.length,
      });
    });
  }, [imageUrls.length]);

  return (
    <>
      <div
        className={cn(
          "max-w-none break-words text-sm leading-relaxed text-foreground",
          className,
        )}
      >
        <ReactMarkdown
          rehypePlugins={allowHtml ? MARKDOWN_HTML_REHYPE_PLUGINS : undefined}
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
          urlTransform={
            onOpenLocalFileLink ? localFileAwareUrlTransform : undefined
          }
        >
          {content}
        </ReactMarkdown>
      </div>

      <ImageLightbox
        imageSrc={currentImageUrl}
        imageAlt={expandedImageAlt}
        title={imageLightboxTitle}
        hasMultipleImages={imageUrls.length > 1}
        onPrevious={showPreviousImage}
        onNext={showNextImage}
        onClose={() => setExpandedImageIndex(null)}
      />
    </>
  );
}

export const MarkdownPreview = memo(MarkdownPreviewComponent);
MarkdownPreview.displayName = "MarkdownPreview";
