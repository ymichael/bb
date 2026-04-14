import { useCallback, useMemo, useState } from "react";
import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../utils.js";
import { ImageLightbox, getWrappedImageIndex } from "./ImageLightbox.js";

interface ConversationMarkdownProps {
  content: string;
  className?: string;
}

function extractMarkdownImageUrls(markdown: string): string[] {
  const imageUrls: string[] = [];
  const markdownImagePattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
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

export function ConversationMarkdown({
  content,
  className,
}: ConversationMarkdownProps) {
  const imageUrls = useMemo(() => extractMarkdownImageUrls(content), [content]);
  const [expandedImageIndex, setExpandedImageIndex] = useState<number | null>(
    null,
  );
  const currentImageUrl =
    expandedImageIndex !== null ? (imageUrls[expandedImageIndex] ?? null) : null;

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
        className={cx(
          "max-w-none break-words text-sm leading-relaxed text-foreground",
          className,
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({
              className: codeClassName,
              children,
              ...props
            }: ComponentPropsWithoutRef<"code"> & ExtraProps) {
              const codeText = String(children ?? "").replace(/\n$/, "");
              const languageMatch = /language-(\w+)/.exec(codeClassName || "");
              const language = languageMatch?.[1];
              const isBlock = codeText.includes("\n");
              if (isBlock) {
                return (
                  <pre className="my-2 overflow-x-auto rounded-md border border-border/70 bg-muted/35 p-3">
                    <code
                      className={cx(
                        "font-mono text-xs",
                        language ? `language-${language}` : "",
                      )}
                      {...props}
                    >
                      {codeText}
                    </code>
                  </pre>
                );
              }
              return (
                <code
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em]"
                  {...props}
                >
                  {children}
                </code>
              );
            },
            pre({ children }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
              return <>{children}</>;
            },
            p({ children }: ComponentPropsWithoutRef<"p"> & ExtraProps) {
              return <p className="mb-2 last:mb-0 text-foreground">{children}</p>;
            },
            ul({ children }: ComponentPropsWithoutRef<"ul"> & ExtraProps) {
              return <ul className="mb-2 list-disc pl-5 text-foreground">{children}</ul>;
            },
            ol({ children }: ComponentPropsWithoutRef<"ol"> & ExtraProps) {
              return (
                <ol className="mb-2 list-decimal pl-5 text-foreground">
                  {children}
                </ol>
              );
            },
            li({ children }: ComponentPropsWithoutRef<"li"> & ExtraProps) {
              return <li className="mb-1 text-foreground">{children}</li>;
            },
            blockquote({
              children,
            }: ComponentPropsWithoutRef<"blockquote"> & ExtraProps) {
              return (
                <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
                  {children}
                </blockquote>
              );
            },
            table({ children }: ComponentPropsWithoutRef<"table"> & ExtraProps) {
              return (
                <div className="my-2 overflow-x-auto">
                  <table className="min-w-full border border-border/80">
                    {children}
                  </table>
                </div>
              );
            },
            thead({ children }: ComponentPropsWithoutRef<"thead"> & ExtraProps) {
              return <thead className="bg-muted/40">{children}</thead>;
            },
            th({ children }: ComponentPropsWithoutRef<"th"> & ExtraProps) {
              return (
                <th className="border border-border/80 px-2 py-1 text-left font-medium">
                  {children}
                </th>
              );
            },
            td({ children }: ComponentPropsWithoutRef<"td"> & ExtraProps) {
              return <td className="border border-border/80 px-2 py-1">{children}</td>;
            },
            a({
              children,
              href,
              ...props
            }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
              return (
                <a
                  href={href}
                  className="underline underline-offset-2 break-all"
                  target="_blank"
                  rel="noopener noreferrer"
                  {...props}
                >
                  {children}
                </a>
              );
            },
            img({ src, alt }: ComponentPropsWithoutRef<"img"> & ExtraProps) {
              const imageUrl = typeof src === "string" ? src : "";
              if (!imageUrl) return null;
              const imageIndex = imageUrls.indexOf(imageUrl);
              return (
                <img
                  src={imageUrl}
                  alt={typeof alt === "string" ? alt : "Image"}
                  className="my-2 max-h-96 max-w-full cursor-zoom-in rounded-md border border-border/60 object-contain"
                  loading="lazy"
                  onClick={() =>
                    setExpandedImageIndex(imageIndex >= 0 ? imageIndex : 0)
                  }
                />
              );
            },
            hr() {
              return <hr className="my-4 border-t border-border/70" />;
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>

      <ImageLightbox
        imageSrc={currentImageUrl}
        imageAlt="Expanded image"
        title="Expanded image preview"
        hasMultipleImages={imageUrls.length > 1}
        onPrevious={showPreviousImage}
        onNext={showNextImage}
        onClose={() => setExpandedImageIndex(null)}
      />
    </>
  );
}
