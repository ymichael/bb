import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useLayoutEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";
import type {
  Components,
  ExtraProps,
  Options as ReactMarkdownOptions,
  UrlTransform,
} from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { ImageLightbox } from "./image-lightbox.js";
import { normalizeMathFences } from "./markdown-math-fences.js";
import {
  markdownMayContainMath,
  useRehypeKatex,
  type RehypeKatex,
} from "./markdown-katex-loader.js";
import { CopyButton } from "./copy-button.js";
import { Icon } from "@bb/shared-ui/icon";
import { RouteAnchor } from "./app-route-anchor.js";
import {
  getMarkdownCodeLanguage,
  isMarkdownCodeBlock,
} from "./markdown-code-block.js";
import { highlightMarkdownCode } from "./markdown-code-highlight.js";
import "./markdown-code-highlight.css";
import { normalizeLocalFileMarkdownLinks } from "./markdown-local-file-link-normalize.js";
import {
  buildLocalFileAnchorHref,
  parseLocalFileHref,
  resolveRelativeLocalFileHref,
  type MarkdownAbsoluteLocalFileLinkRouting,
  type MarkdownPreviewLocalFileLink,
  type MarkdownRelativeLocalFileLinkRouting,
} from "./markdown-local-file-link.js";
import {
  MarkdownLocalFileContextMenuContext,
  type MarkdownLinkRouting,
  type MarkdownLocalFileContextMenuItem,
  type MarkdownLocalFileLinkRouting,
  type MarkdownLocalImageRouting,
} from "./markdown-link-routing.js";
import {
  buildThreadMentionComponent,
  remarkThreadMentions,
  splitRawThreadIdsInText,
} from "./markdown-thread-mentions.js";
import {
  buildPromptMentionComponent,
  remarkPromptMentions,
  substitutePromptMentions,
  type IndexedPromptMention,
  type MarkdownPromptMentions,
} from "./markdown-prompt-mentions.js";
import {
  buildMessageDirectiveComponent,
  remarkMessageDirectives,
  type MarkdownMessageDirectives,
  type MountedMessageDirective,
} from "./markdown-message-directives.js";
import { normalizePromptBlockquoteBoundaries } from "./markdown-prompt-blockquote-boundaries.js";
import { MarkdownMermaidDiagram } from "./markdown-mermaid-diagram.js";
import type { PromptTextMention } from "@bb/domain";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type { TimelineTitleLinkResolver } from "@/components/thread/timeline/TimelineTitleView.js";
import { usePreferredTheme, type Theme } from "@/hooks/useTheme";
import {
  rewriteLocalhostLinkHref,
  useRewriteLocalhostLinksPreference,
} from "@/lib/localhost-link-rewrite-preference";
import { resolveRouteHref } from "@/lib/route-paths";
import { cn } from "@bb/shared-ui/lib/utils";
import remarkDirective from "remark-directive";
import { PromptMentionPill } from "@/components/thread/timeline/ConversationMessageMentions.js";
import {
  RawThreadMentionBatchProvider,
  useRawThreadMentionResources,
} from "@/components/thread/ThreadTitleMentions.js";

interface MarkdownPreviewProps {
  allowHtml?: boolean;
  className?: string;
  content: string;
  imagePolicy?: MarkdownImagePolicy;
  linkRouting?: MarkdownLinkRouting;
  threadMentions?: MarkdownThreadMentions;
  promptMentions?: MarkdownPromptMentions;
  messageDirectives?: MarkdownMessageDirectives;
  urlTransform?: UrlTransform;
}

type MarkdownImagePolicy = "alt-text" | "render";

export interface MarkdownThreadMentions {
  mentions: readonly PromptTextMention[];
  preserveSoftBreaks: boolean;
  resolveLinkHref?: TimelineTitleLinkResolver;
}

interface MarkdownAnchorProps
  extends ComponentPropsWithoutRef<"a">, ExtraProps {
  linkRouting?: MarkdownLinkRouting;
  rewriteLocalhostLinks?: boolean;
}

interface IsMarkdownAppRouteHrefArgs {
  href: string | undefined;
}

interface BuildMarkdownComponentsArgs {
  imagePolicy: MarkdownImagePolicy;
  linkRouting?: MarkdownLinkRouting;
  preferredTheme: Theme;
  rewriteLocalhostLinks: boolean;
  setExpandedImageUrl: ExpandedImageUrlSetter;
  threadMentions?: MarkdownThreadMentions;
  promptMentions?: ResolvedPromptMentions;
  messageDirectives?: ResolvedMessageDirectiveRender;
}

interface ResolvedMessageDirectiveRender {
  mounts: readonly MountedMessageDirective[];
  message: MarkdownMessageDirectives["message"];
  openWorkspaceFile: MarkdownMessageDirectives["openWorkspaceFile"];
  openThreadPanel: MarkdownMessageDirectives["openThreadPanel"];
}

interface ResolvedPromptMentions {
  mentions: readonly IndexedPromptMention[];
  resolveLinkHref?: TimelineTitleLinkResolver;
  resolveMentionLink?: PromptMentionLinkResolver;
}

interface BuildLocalAwareUrlTransformArgs {
  fallbackUrlTransform: UrlTransform | undefined;
  localFileRouting: MarkdownLocalFileLinkRouting | undefined;
  localImageRouting: MarkdownLocalImageRouting | undefined;
}

interface MarkdownImageRendererArgs {
  alt: ComponentPropsWithoutRef<"img">["alt"];
  imageAttributes: MarkdownImageRenderAttributes;
  setExpandedImageUrl: ExpandedImageUrlSetter;
  src: ComponentPropsWithoutRef<"img">["src"];
}

interface ResolveMarkdownSourceMediaArgs {
  media: MarkdownSourceMedia;
  preferredTheme: Theme;
}

interface AreMarkdownAbsoluteLocalFileLinkRoutingsEqualArgs {
  next: MarkdownAbsoluteLocalFileLinkRouting | undefined;
  previous: MarkdownAbsoluteLocalFileLinkRouting | undefined;
}

interface AreMarkdownRelativeLocalFileLinkRoutingsEqualArgs {
  next: MarkdownRelativeLocalFileLinkRouting | undefined;
  previous: MarkdownRelativeLocalFileLinkRouting | undefined;
}

interface AreMarkdownLocalFileLinkRoutingsEqualArgs {
  next: MarkdownLocalFileLinkRouting | undefined;
  previous: MarkdownLocalFileLinkRouting | undefined;
}

interface AreMarkdownLocalImageRoutingsEqualArgs {
  next: MarkdownLocalImageRouting | undefined;
  previous: MarkdownLocalImageRouting | undefined;
}

interface AreMarkdownLinkRoutingsEqualArgs {
  next: MarkdownLinkRouting | undefined;
  previous: MarkdownLinkRouting | undefined;
}

interface AreMarkdownThreadMentionsEqualArgs {
  next: MarkdownThreadMentions | undefined;
  previous: MarkdownThreadMentions | undefined;
}

interface AreMarkdownPromptMentionsEqualArgs {
  next: MarkdownPromptMentions | undefined;
  previous: MarkdownPromptMentions | undefined;
}

interface AreMarkdownMessageDirectivesEqualArgs {
  next: MarkdownMessageDirectives | undefined;
  previous: MarkdownMessageDirectives | undefined;
}

type ExpandedImageUrlSetter = Dispatch<SetStateAction<string | null>>;

interface SetMarkdownContentWidthVariableArgs {
  element: HTMLElement;
  width: number;
}

type MarkdownPreviewPropsEqual = (
  previous: MarkdownPreviewProps,
  next: MarkdownPreviewProps,
) => boolean;
type MarkdownAnchorEvent = ReactMouseEvent<HTMLAnchorElement>;
type MarkdownBlockquoteProps = ComponentPropsWithoutRef<"blockquote"> &
  ExtraProps;
type MarkdownCodeProps = ComponentPropsWithoutRef<"code"> & ExtraProps;
interface MarkdownCodeRendererProps extends MarkdownCodeProps {
  imagePolicy: MarkdownImagePolicy;
  linkRouting?: MarkdownLinkRouting;
  preferredTheme: Theme;
  rewriteLocalhostLinks: boolean;
}
type MarkdownHeadingProps = ComponentPropsWithoutRef<"h1"> & ExtraProps;
type MarkdownHrProps = ComponentPropsWithoutRef<"hr"> & ExtraProps;
type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & ExtraProps;
type MarkdownImageRenderAttributes = Omit<
  MarkdownImageProps,
  "alt" | "children" | "className" | "node" | "src"
>;
type MarkdownListItemProps = ComponentPropsWithoutRef<"li"> & ExtraProps;
type MarkdownOrderedListProps = ComponentPropsWithoutRef<"ol"> & ExtraProps;
type MarkdownParagraphProps = ComponentPropsWithoutRef<"p"> & ExtraProps;
type MarkdownPreProps = ComponentPropsWithoutRef<"pre"> & ExtraProps;
type MarkdownSourceMedia = ComponentPropsWithoutRef<"source">["media"];
type MarkdownSourceProps = ComponentPropsWithoutRef<"source"> & ExtraProps;
type MarkdownTableProps = ComponentPropsWithoutRef<"table"> & ExtraProps;
type MarkdownTableCellProps = ComponentPropsWithoutRef<"td"> & ExtraProps;
type MarkdownTableHeadProps = ComponentPropsWithoutRef<"thead"> & ExtraProps;
type MarkdownTableHeaderProps = ComponentPropsWithoutRef<"th"> & ExtraProps;
type MarkdownUnorderedListProps = ComponentPropsWithoutRef<"ul"> & ExtraProps;
type MarkdownRehypePlugins = NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

const MARKDOWN_TABLE_BREAKOUT_LIMIT_VARIABLE = "--md-table-breakout-max";
const MARKDOWN_TABLE_BREAKOUT_WIDTH = `max(100%, min(1100px, 100cqw - 2rem, var(${MARKDOWN_TABLE_BREAKOUT_LIMIT_VARIABLE}, 100cqw)))`;
const MARKDOWN_CONTENT_WIDTH_VARIABLE = "--md-content-w";
const MARKDOWN_SOURCE_COLOR_SCHEME_MEDIA_PATTERN =
  /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/iu;
const MARKDOWN_HTML_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  rehypeRaw,
  rehypeSanitize,
];

const MARKDOWN_PLAIN_REHYPE_PLUGINS: MarkdownRehypePlugins = [];

function resolveRehypePlugins({
  allowHtml,
  rehypeKatex,
}: {
  allowHtml: boolean;
  rehypeKatex: RehypeKatex | null;
}): MarkdownRehypePlugins {
  const base = allowHtml
    ? MARKDOWN_HTML_REHYPE_PLUGINS
    : MARKDOWN_PLAIN_REHYPE_PLUGINS;
  return rehypeKatex === null ? base : [...base, rehypeKatex];
}

function areMarkdownAbsoluteLocalFileLinkRoutingsEqual({
  next,
  previous,
}: AreMarkdownAbsoluteLocalFileLinkRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "trusted-host" || next.kind === "trusted-host") {
    return true;
  }
  return previous.rootPath === next.rootPath;
}

function areMarkdownRelativeLocalFileLinkRoutingsEqual({
  next,
  previous,
}: AreMarkdownRelativeLocalFileLinkRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.baseDir === next.baseDir && previous.rootPath === next.rootPath
  );
}

function areMarkdownLocalFileLinkRoutingsEqual({
  next,
  previous,
}: AreMarkdownLocalFileLinkRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.onOpenLink === next.onOpenLink &&
    areMarkdownAbsoluteLocalFileLinkRoutingsEqual({
      next: next.absoluteLinks,
      previous: previous.absoluteLinks,
    }) &&
    areMarkdownRelativeLocalFileLinkRoutingsEqual({
      next: next.relativeLinks,
      previous: previous.relativeLinks,
    })
  );
}

function areMarkdownLocalImageRoutingsEqual({
  next,
  previous,
}: AreMarkdownLocalImageRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.resolveSrc === next.resolveSrc &&
    areMarkdownAbsoluteLocalFileLinkRoutingsEqual({
      next: next.absolutePaths,
      previous: previous.absolutePaths,
    }) &&
    areMarkdownRelativeLocalFileLinkRoutingsEqual({
      next: next.relativePaths,
      previous: previous.relativePaths,
    })
  );
}

function areMarkdownLinkRoutingsEqual({
  next,
  previous,
}: AreMarkdownLinkRoutingsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.onOpenLink === next.onOpenLink &&
    areMarkdownLocalFileLinkRoutingsEqual({
      next: next.localFile,
      previous: previous.localFile,
    }) &&
    areMarkdownLocalImageRoutingsEqual({
      next: next.localImage,
      previous: previous.localImage,
    })
  );
}

function areMarkdownThreadMentionsEqual({
  next,
  previous,
}: AreMarkdownThreadMentionsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.mentions === next.mentions &&
    previous.preserveSoftBreaks === next.preserveSoftBreaks &&
    previous.resolveLinkHref === next.resolveLinkHref
  );
}

function areMarkdownPromptMentionsEqual({
  next,
  previous,
}: AreMarkdownPromptMentionsEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.mentions === next.mentions &&
    previous.resolveLinkHref === next.resolveLinkHref &&
    previous.resolveMentionLink === next.resolveMentionLink
  );
}

function areMarkdownMessageDirectivesEqual({
  next,
  previous,
}: AreMarkdownMessageDirectivesEqualArgs): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  return (
    previous.registry === next.registry &&
    previous.openWorkspaceFile === next.openWorkspaceFile &&
    previous.openThreadPanel === next.openThreadPanel &&
    previous.message.id === next.message.id &&
    previous.message.threadId === next.message.threadId &&
    previous.message.turnId === next.message.turnId &&
    previous.message.projectId === next.message.projectId
  );
}

const areMarkdownPreviewPropsEqual: MarkdownPreviewPropsEqual = (
  previous,
  next,
) =>
  (previous.allowHtml ?? false) === (next.allowHtml ?? false) &&
  previous.className === next.className &&
  previous.content === next.content &&
  (previous.imagePolicy ?? "render") === (next.imagePolicy ?? "render") &&
  previous.urlTransform === next.urlTransform &&
  areMarkdownThreadMentionsEqual({
    next: next.threadMentions,
    previous: previous.threadMentions,
  }) &&
  areMarkdownPromptMentionsEqual({
    next: next.promptMentions,
    previous: previous.promptMentions,
  }) &&
  areMarkdownMessageDirectivesEqual({
    next: next.messageDirectives,
    previous: previous.messageDirectives,
  }) &&
  areMarkdownLinkRoutingsEqual({
    next: next.linkRouting,
    previous: previous.linkRouting,
  });

function isMarkdownAppRouteHref({ href }: IsMarkdownAppRouteHrefArgs): boolean {
  if (!href || typeof window === "undefined") {
    return false;
  }

  return (
    resolveRouteHref({
      currentOrigin: window.location.origin,
      href,
    }) !== null
  );
}

function resolveMarkdownLocalPath(
  value: string,
  absolutePaths: MarkdownAbsoluteLocalFileLinkRouting,
  relativePaths: MarkdownRelativeLocalFileLinkRouting | undefined,
): MarkdownPreviewLocalFileLink | null {
  const absolutePath = parseLocalFileHref({
    absoluteLinks: absolutePaths,
    href: value,
  });
  if (absolutePath !== null || relativePaths === undefined) {
    return absolutePath;
  }

  const resolvedHref = resolveRelativeLocalFileHref({
    href: value,
    ...relativePaths,
  });
  return resolvedHref === null
    ? null
    : parseLocalFileHref({
        absoluteLinks: absolutePaths,
        href: resolvedHref,
      });
}

function buildLocalAwareUrlTransform({
  fallbackUrlTransform,
  localFileRouting,
  localImageRouting,
}: BuildLocalAwareUrlTransformArgs): UrlTransform {
  return (value, key, node) => {
    if (key === "href" && localFileRouting !== undefined) {
      if (
        parseLocalFileHref({
          absoluteLinks: localFileRouting.absoluteLinks,
          href: value,
        })
      ) {
        return value;
      }

      if (localFileRouting.relativeLinks !== undefined) {
        const resolvedHref = resolveRelativeLocalFileHref({
          href: value,
          ...localFileRouting.relativeLinks,
        });
        if (
          resolvedHref !== null &&
          parseLocalFileHref({
            absoluteLinks: localFileRouting.absoluteLinks,
            href: resolvedHref,
          })
        ) {
          return resolvedHref;
        }
      }
    }

    if (key === "src" && localImageRouting !== undefined) {
      const localImage = resolveMarkdownLocalPath(
        value,
        localImageRouting.absolutePaths,
        localImageRouting.relativePaths,
      );
      if (localImage !== null) {
        return localImageRouting.resolveSrc(localImage);
      }
    }

    return (fallbackUrlTransform ?? defaultUrlTransform)(value, key, node);
  };
}

function hasMarkdownFileExtension(path: string): boolean {
  return /\.(?:md|markdown)$/iu.test(path);
}

function resolveInlineCodeMarkdownFileHref({
  codeText,
  localFileRouting,
}: {
  codeText: string;
  localFileRouting: MarkdownLocalFileLinkRouting | undefined;
}): string | null {
  if (
    localFileRouting === undefined ||
    codeText.length === 0 ||
    codeText.trim() !== codeText ||
    codeText.includes("\n") ||
    codeText.includes("\r")
  ) {
    return null;
  }

  const absoluteLink = parseLocalFileHref({
    absoluteLinks: localFileRouting.absoluteLinks,
    href: codeText,
  });
  if (absoluteLink !== null) {
    return hasMarkdownFileExtension(absoluteLink.path) ? codeText : null;
  }

  if (localFileRouting.relativeLinks === undefined) {
    return null;
  }

  const resolvedHref = resolveRelativeLocalFileHref({
    href: codeText,
    ...localFileRouting.relativeLinks,
  });
  if (resolvedHref === null) {
    return null;
  }

  const resolvedLink = parseLocalFileHref({
    absoluteLinks: localFileRouting.absoluteLinks,
    href: resolvedHref,
  });
  return resolvedLink !== null && hasMarkdownFileExtension(resolvedLink.path)
    ? resolvedHref
    : null;
}

function MarkdownAnchor({
  children,
  href,
  linkRouting,
  rewriteLocalhostLinks,
  ...anchorProps
}: MarkdownAnchorProps) {
  const localFileRouting = linkRouting?.localFile;
  const onOpenLocalFileLink = localFileRouting?.onOpenLink;
  const rewrittenHref = rewriteLocalhostLinkHref({
    currentHostname:
      typeof window === "undefined" ? undefined : window.location.hostname,
    enabled: rewriteLocalhostLinks ?? false,
    href,
  });
  const isAppRouteHref = isMarkdownAppRouteHref({ href: rewrittenHref });
  const localFileLink =
    !isAppRouteHref && localFileRouting
      ? parseLocalFileHref({
          absoluteLinks: localFileRouting.absoluteLinks,
          href: rewrittenHref,
        })
      : null;
  const anchorHref = buildLocalFileAnchorHref(localFileLink, rewrittenHref);
  const getContextMenuItems = useContext(MarkdownLocalFileContextMenuContext);
  const contextMenuItems =
    localFileLink !== null && getContextMenuItems !== null
      ? getContextMenuItems(localFileLink)
      : null;
  const handleAnchorClick = (event: MarkdownAnchorEvent) => {
    if (localFileLink && onOpenLocalFileLink) {
      if (onOpenLocalFileLink(localFileLink)) {
        event.preventDefault();
      }
      return;
    }

    if (isAppRouteHref) {
      return;
    }

    if (
      linkRouting?.onOpenLink &&
      rewrittenHref &&
      linkRouting.onOpenLink({ href: rewrittenHref })
    ) {
      event.preventDefault();
      return;
    }
  };

  const anchor = (
    <RouteAnchor
      {...anchorProps}
      href={anchorHref}
      className={cn(
        "break-words [overflow-wrap:anywhere] underline underline-offset-2",
      )}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleAnchorClick}
    >
      {children}
      {localFileLink ? (
        <Icon
          name="ExternalLink"
          aria-hidden
          className="ml-1 inline size-3 align-[-0.125em] text-subtle-foreground"
        />
      ) : null}
    </RouteAnchor>
  );
  if (contextMenuItems === null || contextMenuItems.length === 0) {
    return anchor;
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-44">
        {contextMenuItems.map(renderMarkdownLocalFileContextMenuItem)}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function renderMarkdownLocalFileContextMenuItem(
  item: MarkdownLocalFileContextMenuItem,
) {
  if (item.type === "separator") {
    return <ContextMenuSeparator key={item.id} />;
  }
  if (item.type === "submenu") {
    return (
      <ContextMenuSub key={item.id}>
        <ContextMenuSubTrigger>{item.label}</ContextMenuSubTrigger>
        <ContextMenuSubContent className="min-w-44">
          {item.items.map(renderMarkdownLocalFileContextMenuItem)}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  }
  return (
    <ContextMenuItem key={item.id} onSelect={item.onSelect}>
      {item.label}
    </ContextMenuItem>
  );
}

function MarkdownCode({
  className: codeClassName,
  children,
  imagePolicy,
  linkRouting,
  node: _node,
  preferredTheme,
  rewriteLocalhostLinks,
  ...props
}: MarkdownCodeRendererProps) {
  const codeText = String(children ?? "").replace(/\n$/, "");
  const language = getMarkdownCodeLanguage({ className: codeClassName });
  const isBlock = isMarkdownCodeBlock({ codeText, language });
  const [softWrap, setSoftWrap] = useState(false);
  const highlightedHtml = useMemo(
    () =>
      isBlock && language !== "mermaid"
        ? highlightMarkdownCode({ code: codeText, language })
        : null,
    [isBlock, language, codeText],
  );
  if (isBlock) {
    if (language === "mermaid" && imagePolicy === "render") {
      return (
        <MarkdownMermaidDiagram
          preferredTheme={preferredTheme}
          source={codeText}
        />
      );
    }

    return (
      <div className="my-2 overflow-hidden rounded-md border border-border bg-surface-recessed">
        <div className="flex items-center justify-between pl-3 pr-1.5 pt-1.5">
          <span className="font-mono text-xs uppercase text-muted-foreground">
            {language ?? ""}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-pressed={softWrap}
              aria-label={softWrap ? "Disable line wrap" : "Wrap long lines"}
              onClick={() => {
                setSoftWrap((value) => !value);
              }}
              className="inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground aria-pressed:text-foreground"
            >
              <Icon name="TextWrap" className="size-3" />
            </button>
            <CopyButton text={codeText} label="Copy code" />
          </div>
        </div>
        <pre
          className={cn(
            "bb-code-highlight px-3 pb-3 pt-1",
            softWrap
              ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
              : "overflow-x-auto",
          )}
        >
          {highlightedHtml === null ? (
            <code className="font-mono text-xs" {...props}>
              {codeText}
            </code>
          ) : (
            <code
              className={cn(
                "font-mono text-xs",
                language ? `language-${language}` : "",
              )}
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              {...props}
            />
          )}
        </pre>
      </div>
    );
  }

  const markdownFileHref = resolveInlineCodeMarkdownFileHref({
    codeText,
    localFileRouting: linkRouting?.localFile,
  });
  if (markdownFileHref !== null) {
    return (
      <MarkdownAnchor
        href={markdownFileHref}
        linkRouting={linkRouting}
        rewriteLocalhostLinks={rewriteLocalhostLinks}
      >
        {codeText}
      </MarkdownAnchor>
    );
  }

  return (
    <code
      className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs"
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

function MarkdownParagraph({
  children,
  className: _className,
  node: _node,
  ...paragraphProps
}: MarkdownParagraphProps) {
  return (
    <p {...paragraphProps} className="mb-2 text-foreground last:mb-0">
      {children}
    </p>
  );
}

function MarkdownUnorderedList({ children }: MarkdownUnorderedListProps) {
  return <ul className="mb-2 list-disc pl-5 text-foreground">{children}</ul>;
}

function MarkdownOrderedList({
  children,
  className: _className,
  node: _node,
  ...orderedListProps
}: MarkdownOrderedListProps) {
  return (
    <ol
      {...orderedListProps}
      className="mb-2 list-decimal pl-5 text-foreground"
    >
      {children}
    </ol>
  );
}

function MarkdownListItem({ children }: MarkdownListItemProps) {
  return <li className="mb-1 text-foreground">{children}</li>;
}

function MarkdownBlockquote({ children }: MarkdownBlockquoteProps) {
  return (
    <blockquote className="my-2 border-l-2 border-surface-selected-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  );
}

function MarkdownTable({ children }: MarkdownTableProps) {
  const breakoutRef = useMarkdownTableContentWidthVariable();

  return (
    <div
      ref={breakoutRef}
      className="my-2 flex justify-center"
      style={{
        width: MARKDOWN_TABLE_BREAKOUT_WIDTH,
        marginInline: `calc((100% - ${MARKDOWN_TABLE_BREAKOUT_WIDTH}) / 2)`,
      }}
    >
      {}
      <div
        className="w-max max-w-full overflow-x-auto"
        style={{
          minWidth: `min(var(${MARKDOWN_CONTENT_WIDTH_VARIABLE}, 100%), 100%)`,
        }}
      >
        <table className="border border-border">{children}</table>
      </div>
    </div>
  );
}

function MarkdownTableHead({ children }: MarkdownTableHeadProps) {
  return <thead className="bg-surface-recessed">{children}</thead>;
}

function MarkdownTableHeader({ children }: MarkdownTableHeaderProps) {
  return (
    <th className="border border-border px-2 py-1 text-left font-medium">
      {children}
    </th>
  );
}

function MarkdownTableCell({ children }: MarkdownTableCellProps) {
  return <td className="border border-border px-2 py-1">{children}</td>;
}

function renderMarkdownImage({
  alt,
  imageAttributes,
  setExpandedImageUrl,
  src,
}: MarkdownImageRendererArgs) {
  const imageUrl = typeof src === "string" ? src : "";
  if (!imageUrl) return null;
  return (
    <img
      {...imageAttributes}
      src={imageUrl}
      alt={typeof alt === "string" ? alt : "Image"}
      className="my-2 max-h-96 max-w-full cursor-zoom-in object-contain"
      loading="lazy"
      onClick={() => setExpandedImageUrl(imageUrl)}
    />
  );
}

function MarkdownHr(_props: MarkdownHrProps) {
  return <hr className="my-4 border-t border-border" />;
}

function parseMarkdownSourceColorScheme(media: string): Theme | null {
  const match = MARKDOWN_SOURCE_COLOR_SCHEME_MEDIA_PATTERN.exec(media);
  const colorScheme = match?.[1];
  if (colorScheme === "dark" || colorScheme === "light") {
    return colorScheme;
  }
  return null;
}

function resolveMarkdownSourceMedia({
  media,
  preferredTheme,
}: ResolveMarkdownSourceMediaArgs): MarkdownSourceMedia {
  if (!media) return media;

  const colorScheme = parseMarkdownSourceColorScheme(media);
  if (!colorScheme) return media;

  return colorScheme === preferredTheme ? "all" : "not all";
}

function buildMarkdownComponents({
  imagePolicy,
  linkRouting,
  preferredTheme,
  rewriteLocalhostLinks,
  setExpandedImageUrl,
  threadMentions,
  promptMentions,
  messageDirectives,
}: BuildMarkdownComponentsArgs): Components {
  interface RawThreadIdLabelCandidate {
    end: number;
    start: number;
    threadId: string;
  }

  function flattenMarkdownLinkLabel(node: ReactNode): {
    codeRanges: ReadonlyArray<{ end: number; start: number }>;
    text: string;
  } {
    const codeRanges: Array<{ end: number; start: number }> = [];
    let text = "";
    const append = (child: ReactNode): void => {
      if (typeof child === "string" || typeof child === "number") {
        text += String(child);
        return;
      }
      if (!isValidElement(child)) {
        Children.forEach(child, append);
        return;
      }
      const element = child as ReactElement<{ children?: ReactNode }>;
      const isCode =
        element.type === "code" || element.type === MarkdownCodeRenderer;
      const start = text.length;
      append(element.props.children);
      if (isCode && text.length > start) {
        codeRanges.push({ start, end: text.length });
      }
    };
    append(node);
    return { codeRanges, text };
  }

  function rawThreadIdLabelCandidates(
    node: ReactNode,
  ): RawThreadIdLabelCandidate[] {
    const flattened = flattenMarkdownLinkLabel(node);
    const candidates: RawThreadIdLabelCandidate[] = [];
    let offset = 0;
    for (const segment of splitRawThreadIdsInText(flattened.text)) {
      const start = offset;
      const end = start + segment.text.length;
      offset = end;
      if (
        segment.rawThreadId === null ||
        flattened.codeRanges.some(
          (range) => start < range.end && end > range.start,
        )
      ) {
        continue;
      }
      candidates.push({ start, end, threadId: segment.rawThreadId });
    }
    return candidates;
  }

  function renderLiftedMarkdownLinkLabel(
    node: ReactNode,
    anchorProps: Omit<MarkdownAnchorProps, "children">,
    candidates: readonly RawThreadIdLabelCandidate[],
    resourceById: ReadonlyMap<string, PromptTextMention["resource"]>,
    cursor: { value: number },
  ): ReactNode {
    if (typeof node === "string" || typeof node === "number") {
      const text = String(node);
      const start = cursor.value;
      const end = start + text.length;
      cursor.value = end;
      const containedCandidates = candidates.filter(
        (candidate) => candidate.start >= start && candidate.end <= end,
      );
      if (containedCandidates.length === 0) {
        return (
          <MarkdownAnchor
            {...anchorProps}
            linkRouting={linkRouting}
            rewriteLocalhostLinks={rewriteLocalhostLinks}
          >
            {text}
          </MarkdownAnchor>
        );
      }
      const rendered: ReactNode[] = [];
      let localCursor = 0;
      for (const candidate of containedCandidates) {
        const candidateStart = candidate.start - start;
        const candidateEnd = candidate.end - start;
        if (candidateStart > localCursor) {
          rendered.push(
            <MarkdownAnchor
              key={`text:${localCursor}`}
              {...anchorProps}
              linkRouting={linkRouting}
              rewriteLocalhostLinks={rewriteLocalhostLinks}
            >
              {text.slice(localCursor, candidateStart)}
            </MarkdownAnchor>,
          );
        }
        const resource = resourceById.get(candidate.threadId);
        if (resource !== undefined) {
          rendered.push(
            <PromptMentionPill
              key={`${candidate.threadId}:${candidateStart}`}
              resource={resource}
              serializedText={candidate.threadId}
            />,
          );
        }
        localCursor = candidateEnd;
      }
      if (localCursor < text.length) {
        rendered.push(
          <MarkdownAnchor
            key={`text:${localCursor}`}
            {...anchorProps}
            linkRouting={linkRouting}
            rewriteLocalhostLinks={rewriteLocalhostLinks}
          >
            {text.slice(localCursor)}
          </MarkdownAnchor>,
        );
      }
      return rendered;
    }
    if (!isValidElement(node)) {
      return Children.map(node, (child) =>
        renderLiftedMarkdownLinkLabel(
          child,
          anchorProps,
          candidates,
          resourceById,
          cursor,
        ),
      );
    }
    if (node.type === "code" || node.type === MarkdownCodeRenderer) {
      cursor.value += flattenMarkdownLinkLabel(node).text.length;
      return (
        <MarkdownAnchor
          {...anchorProps}
          linkRouting={linkRouting}
          rewriteLocalhostLinks={rewriteLocalhostLinks}
        >
          {node}
        </MarkdownAnchor>
      );
    }
    const element = node as ReactElement<{ children?: ReactNode }>;
    return cloneElement(
      element,
      undefined,
      renderLiftedMarkdownLinkLabel(
        element.props.children,
        anchorProps,
        candidates,
        resourceById,
        cursor,
      ),
    );
  }

  function MarkdownLink(props: MarkdownAnchorProps) {
    const { children, ...anchorProps } = props;
    const candidates = useMemo(
      () =>
        threadMentions === undefined
          ? []
          : rawThreadIdLabelCandidates(children),
      [children],
    );
    const candidateThreadIds = useMemo(
      () => [...new Set(candidates.map((candidate) => candidate.threadId))],
      [candidates],
    );
    const resourceById = useRawThreadMentionResources(candidateThreadIds);
    const resolvedCandidates = candidates.filter((candidate) =>
      resourceById.has(candidate.threadId),
    );
    if (resolvedCandidates.length > 0) {
      return (
        <>
          {renderLiftedMarkdownLinkLabel(
            children,
            anchorProps,
            resolvedCandidates,
            resourceById,
            { value: 0 },
          )}
        </>
      );
    }
    return (
      <MarkdownAnchor
        {...anchorProps}
        linkRouting={linkRouting}
        rewriteLocalhostLinks={rewriteLocalhostLinks}
      >
        {children}
      </MarkdownAnchor>
    );
  }

  function MarkdownCodeRenderer(props: MarkdownCodeProps) {
    return (
      <MarkdownCode
        {...props}
        imagePolicy={imagePolicy}
        linkRouting={linkRouting}
        preferredTheme={preferredTheme}
        rewriteLocalhostLinks={rewriteLocalhostLinks}
      />
    );
  }

  function MarkdownImage({
    src,
    alt,
    className: _className,
    node: _node,
    ...imageAttributes
  }: MarkdownImageProps) {
    if (imagePolicy === "alt-text") {
      return (
        <span data-markdown-image-fallback="">
          [Image: {typeof alt === "string" && alt.length > 0 ? alt : "image"}]
        </span>
      );
    }
    return renderMarkdownImage({
      alt,
      imageAttributes,
      setExpandedImageUrl,
      src,
    });
  }

  function MarkdownSource({
    media,
    node: _node,
    ...sourceProps
  }: MarkdownSourceProps) {
    if (imagePolicy === "alt-text") {
      return null;
    }
    return (
      <source
        {...sourceProps}
        media={resolveMarkdownSourceMedia({ media, preferredTheme })}
      />
    );
  }

  const components: Components = {
    a: MarkdownLink,
    blockquote: MarkdownBlockquote,
    code: MarkdownCodeRenderer,
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
    source: MarkdownSource,
    table: MarkdownTable,
    td: MarkdownTableCell,
    th: MarkdownTableHeader,
    thead: MarkdownTableHead,
    ul: MarkdownUnorderedList,
  };

  if (threadMentions !== undefined) {
    components["bb-thread-mention"] = buildThreadMentionComponent({
      mentions: threadMentions.mentions,
      resolveSegmentLinkHref: threadMentions.resolveLinkHref,
    });
  }

  if (promptMentions !== undefined) {
    components["bb-prompt-mention"] = buildPromptMentionComponent({
      mentions: promptMentions.mentions,
      resolveLinkHref: promptMentions.resolveLinkHref,
      resolveMentionLink: promptMentions.resolveMentionLink,
    });
  }

  if (messageDirectives !== undefined) {
    components["bb-message-directive"] = buildMessageDirectiveComponent({
      mounts: messageDirectives.mounts,
      message: messageDirectives.message,
      openWorkspaceFile: messageDirectives.openWorkspaceFile,
      openThreadPanel: messageDirectives.openThreadPanel,
    });
  }

  return components;
}

function setMarkdownContentWidthVariable({
  element,
  width,
}: SetMarkdownContentWidthVariableArgs): void {
  if (width <= 0) {
    return;
  }
  element.style.setProperty(MARKDOWN_CONTENT_WIDTH_VARIABLE, `${width}px`);
}

interface MarkdownTableGeometryRegistration {
  breakout: HTMLElement;
  clip: HTMLElement | null;
  content: HTMLElement;
  lastClipWidth: number;
  lastContentWidth: number;
}

type MarkdownTableBreakoutLimitMeasurement =
  | { kind: "remove" }
  | { kind: "set"; value: string }
  | { kind: "unchanged" };

interface MarkdownTableGeometryMeasurement {
  breakout: HTMLElement;
  breakoutLimit: MarkdownTableBreakoutLimitMeasurement;
  contentWidth: number;
}

const markdownTableRegistrationsByElement = new Map<
  HTMLElement,
  Set<MarkdownTableGeometryRegistration>
>();
let sharedMarkdownTableResizeObserver: ResizeObserver | null = null;

function measureMarkdownTableGeometry(
  registrations: Iterable<MarkdownTableGeometryRegistration>,
): void {
  const measurements: MarkdownTableGeometryMeasurement[] = [];
  for (const registration of registrations) {
    const { breakout, clip, content } = registration;
    const contentWidth = content.getBoundingClientRect().width;
    const clipWidth = clip?.clientWidth ?? -1;
    if (
      contentWidth === registration.lastContentWidth &&
      clipWidth === registration.lastClipWidth
    ) {
      continue;
    }
    registration.lastContentWidth = contentWidth;
    registration.lastClipWidth = clipWidth;
    measurements.push({
      breakout,
      breakoutLimit: readMarkdownTableBreakoutLimit({ breakout, clip }),
      contentWidth,
    });
  }

  for (const { breakout, breakoutLimit, contentWidth } of measurements) {
    setMarkdownContentWidthVariable({
      element: breakout,
      width: contentWidth,
    });
    applyMarkdownTableBreakoutLimit({ breakout, measurement: breakoutLimit });
  }
}

function getSharedMarkdownTableResizeObserver(): ResizeObserver {
  sharedMarkdownTableResizeObserver ??= new ResizeObserver((entries) => {
    const registrations = new Set<MarkdownTableGeometryRegistration>();
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement)) continue;
      for (const registration of markdownTableRegistrationsByElement.get(
        entry.target,
      ) ?? []) {
        registrations.add(registration);
      }
    }
    measureMarkdownTableGeometry(registrations);
  });
  return sharedMarkdownTableResizeObserver;
}

function observeMarkdownTableGeometry(
  registration: MarkdownTableGeometryRegistration,
): () => void {
  const elements =
    registration.clip === null || registration.clip === registration.content
      ? [registration.content]
      : [registration.content, registration.clip];
  const observer = getSharedMarkdownTableResizeObserver();
  for (const element of elements) {
    let registrations = markdownTableRegistrationsByElement.get(element);
    if (!registrations) {
      registrations = new Set();
      markdownTableRegistrationsByElement.set(element, registrations);
      observer.observe(element);
    }
    registrations.add(registration);
  }

  return () => {
    for (const element of elements) {
      const registrations = markdownTableRegistrationsByElement.get(element);
      registrations?.delete(registration);
      if (registrations?.size === 0) {
        markdownTableRegistrationsByElement.delete(element);
        sharedMarkdownTableResizeObserver?.unobserve(element);
      }
    }
    if (markdownTableRegistrationsByElement.size === 0) {
      sharedMarkdownTableResizeObserver?.disconnect();
      sharedMarkdownTableResizeObserver = null;
    }
  };
}

function useMarkdownTableContentWidthVariable() {
  const breakoutRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const breakout = breakoutRef.current;
    const content = breakout?.closest<HTMLElement>("[data-markdown-preview]");
    if (!breakout || !content) {
      return;
    }
    const clip = findHorizontalClipAncestor(content);
    const registration: MarkdownTableGeometryRegistration = {
      breakout,
      clip,
      content,
      lastClipWidth: -1,
      lastContentWidth: -1,
    };

    if (typeof ResizeObserver === "undefined") {
      measureMarkdownTableGeometry([registration]);
      return;
    }

    return observeMarkdownTableGeometry(registration);
  }, []);

  return breakoutRef;
}

const HORIZONTAL_CLIP_OVERFLOW_VALUES = new Set([
  "hidden",
  "clip",
  "auto",
  "scroll",
]);

function findHorizontalClipAncestor(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current && current !== document.body) {
    if (
      HORIZONTAL_CLIP_OVERFLOW_VALUES.has(getComputedStyle(current).overflowX)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function readMarkdownTableBreakoutLimit({
  breakout,
  clip,
}: {
  breakout: HTMLElement;
  clip: HTMLElement | null;
}): MarkdownTableBreakoutLimitMeasurement {
  const parent = breakout.parentElement;
  if (!clip || !parent) {
    return { kind: "remove" };
  }
  const parentStyle = getComputedStyle(parent);
  const parentPaddingLeft =
    parent.getBoundingClientRect().left + parent.clientLeft + clip.scrollLeft;
  const parentLeft = parentPaddingLeft + cssPixels(parentStyle.paddingLeft);
  const parentRight =
    parentPaddingLeft +
    parent.clientWidth -
    cssPixels(parentStyle.paddingRight);
  const parentWidth = parentRight - parentLeft;
  if (parentWidth <= 0) {
    return { kind: "unchanged" };
  }
  const clipLeft = clip.getBoundingClientRect().left + clip.clientLeft;
  const clipRight = clipLeft + clip.clientWidth;
  const room = Math.max(
    0,
    Math.min(parentLeft - clipLeft, clipRight - parentRight),
  );
  return { kind: "set", value: `${parentWidth + 2 * room}px` };
}

function applyMarkdownTableBreakoutLimit({
  breakout,
  measurement,
}: {
  breakout: HTMLElement;
  measurement: MarkdownTableBreakoutLimitMeasurement;
}): void {
  if (measurement.kind === "remove") {
    breakout.style.removeProperty(MARKDOWN_TABLE_BREAKOUT_LIMIT_VARIABLE);
  } else if (measurement.kind === "set") {
    breakout.style.setProperty(
      MARKDOWN_TABLE_BREAKOUT_LIMIT_VARIABLE,
      measurement.value,
    );
  }
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const FRONTMATTER_PATTERN =
  /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function splitMarkdownFrontmatter(markdown: string): {
  frontmatter: string | null;
  body: string;
} {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (match === null) {
    return { frontmatter: null, body: markdown };
  }
  return { frontmatter: match[1], body: markdown.slice(match[0].length) };
}

function MarkdownFrontmatter({ source }: { source: string }) {
  const lines = source.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
      {lines.map((line, index) => {
        const separator = line.indexOf(":");
        if (separator > 0 && !/^[\s-]/.test(line)) {
          const key = line.slice(0, separator).trim();
          const value = line.slice(separator + 1).trim();
          return (
            <div key={index} className="contents">
              <span className="font-medium text-muted-foreground/70">
                {key}
              </span>
              <span className="min-w-0 break-words">{value}</span>
            </div>
          );
        }
        return (
          <div
            key={index}
            className="col-span-2 whitespace-pre-wrap break-words text-muted-foreground/80"
          >
            {line}
          </div>
        );
      })}
    </div>
  );
}

function MarkdownPreviewComponent({
  allowHtml = false,
  className,
  content,
  imagePolicy = "render",
  linkRouting,
  threadMentions,
  promptMentions,
  messageDirectives,
  urlTransform,
}: MarkdownPreviewProps) {
  const preferredTheme = usePreferredTheme();
  const [rewriteLocalhostLinks] = useRewriteLocalhostLinksPreference();
  const [expandedImageUrl, setExpandedImageUrl] = useState<string | null>(null);
  const localFileRouting = linkRouting?.localFile;
  const localImageRouting = linkRouting?.localImage;
  const normalizeLocalFileLinks =
    localFileRouting !== undefined || localImageRouting !== undefined;
  const promptMentionSubstitution = useMemo(
    () =>
      promptMentions
        ? substitutePromptMentions(content, promptMentions.mentions)
        : null,
    [content, promptMentions],
  );
  const resolvedPromptMentions = useMemo<ResolvedPromptMentions | undefined>(
    () =>
      promptMentions && promptMentionSubstitution
        ? {
            mentions: promptMentionSubstitution.mentions,
            resolveLinkHref: promptMentions.resolveLinkHref,
            resolveMentionLink: promptMentions.resolveMentionLink,
          }
        : undefined,
    [promptMentions, promptMentionSubstitution],
  );
  const substitutedContent = promptMentionSubstitution?.content ?? content;
  const markdownContent = useMemo(
    () =>
      normalizeLocalFileLinks
        ? normalizeLocalFileMarkdownLinks(substitutedContent)
        : substitutedContent,
    [substitutedContent, normalizeLocalFileLinks],
  );
  const promptMarkdownContent = useMemo(
    () =>
      promptMentions !== undefined
        ? normalizePromptBlockquoteBoundaries(markdownContent)
        : markdownContent,
    [markdownContent, promptMentions],
  );
  const { frontmatter, body } = useMemo(() => {
    const split = splitMarkdownFrontmatter(promptMarkdownContent);
    return {
      frontmatter: split.frontmatter,
      body: normalizeMathFences(split.body),
    };
  }, [promptMarkdownContent]);
  const messageDirectiveMounts = useMemo(() => {
    if (messageDirectives === undefined) {
      return null;
    }
    const mounts: MountedMessageDirective[] = [];
    return {
      mounts,
      message: messageDirectives.message,
      openWorkspaceFile: messageDirectives.openWorkspaceFile,
      openThreadPanel: messageDirectives.openThreadPanel,
      registry: messageDirectives.registry,
    };
  }, [messageDirectives]);
  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents({
        imagePolicy,
        linkRouting,
        preferredTheme,
        rewriteLocalhostLinks,
        setExpandedImageUrl,
        threadMentions,
        promptMentions: resolvedPromptMentions,
        messageDirectives:
          messageDirectiveMounts === null
            ? undefined
            : {
                mounts: messageDirectiveMounts.mounts,
                message: messageDirectiveMounts.message,
                openWorkspaceFile: messageDirectiveMounts.openWorkspaceFile,
                openThreadPanel: messageDirectiveMounts.openThreadPanel,
              },
      }),
    [
      linkRouting,
      imagePolicy,
      preferredTheme,
      rewriteLocalhostLinks,
      threadMentions,
      resolvedPromptMentions,
      messageDirectiveMounts,
    ],
  );
  const remarkPlugins = useMemo((): NonNullable<
    ReactMarkdownOptions["remarkPlugins"]
  > => {
    const plugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [
      remarkGfm,
      [remarkMath, { singleDollarTextMath: false }],
    ];
    if (
      threadMentions?.preserveSoftBreaks === true ||
      promptMentions !== undefined
    ) {
      plugins.push(remarkBreaks);
    }
    if (threadMentions !== undefined) {
      plugins.push(remarkThreadMentions);
    }
    if (promptMentions !== undefined) {
      plugins.push(remarkPromptMentions);
    }
    if (messageDirectiveMounts !== null) {
      plugins.push(remarkDirective);
      plugins.push([
        remarkMessageDirectives,
        {
          mounts: messageDirectiveMounts.mounts,
          registry: messageDirectiveMounts.registry,
        },
      ]);
    }
    return plugins;
  }, [threadMentions, promptMentions, messageDirectiveMounts]);
  const resolvedUrlTransform = useMemo(
    () =>
      localFileRouting || localImageRouting
        ? buildLocalAwareUrlTransform({
            fallbackUrlTransform: urlTransform,
            localFileRouting,
            localImageRouting,
          })
        : urlTransform,
    [localFileRouting, localImageRouting, urlTransform],
  );

  const rehypeKatex = useRehypeKatex(markdownMayContainMath(body));
  const rehypePlugins = useMemo(
    () => resolveRehypePlugins({ allowHtml, rehypeKatex }),
    [allowHtml, rehypeKatex],
  );

  const renderedMarkdown = (
    <ReactMarkdown
      rehypePlugins={rehypePlugins}
      remarkPlugins={remarkPlugins}
      components={markdownComponents}
      urlTransform={resolvedUrlTransform}
    >
      {body}
    </ReactMarkdown>
  );

  return (
    <>
      <div
        data-markdown-preview=""
        className={cn(
          "max-w-none break-words text-sm leading-relaxed text-foreground",
          className,
        )}
      >
        {frontmatter !== null ? (
          <MarkdownFrontmatter source={frontmatter} />
        ) : null}
        {threadMentions === undefined ? (
          renderedMarkdown
        ) : (
          <RawThreadMentionBatchProvider>
            {renderedMarkdown}
          </RawThreadMentionBatchProvider>
        )}
      </div>

      <ImageLightbox
        imageSrc={expandedImageUrl}
        imageAlt="Expanded image"
        title="Expanded image preview"
        onClose={() => setExpandedImageUrl(null)}
      />
    </>
  );
}

export const MarkdownPreview = memo(
  MarkdownPreviewComponent,
  areMarkdownPreviewPropsEqual,
);
MarkdownPreview.displayName = "MarkdownPreview";
