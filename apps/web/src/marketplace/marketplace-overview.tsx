import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, {
  type Components,
  type UrlTransform,
} from "react-markdown";
import remarkGfm from "remark-gfm";

const ALLOWED_ELEMENTS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
];

const REMARK_PLUGINS = [remarkGfm];

function httpsOnly(url: string): string | null {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const overviewUrlTransform: UrlTransform = (url) => httpsOnly(url) ?? "";

function OverviewLink({ children, href }: ComponentPropsWithoutRef<"a">) {
  const safeHref = href === undefined ? null : httpsOnly(href);
  if (safeHref === null) return <span>{children}</span>;
  return (
    <a href={safeHref} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

const OVERVIEW_COMPONENTS: Components = {
  a: OverviewLink,
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h5>{children}</h5>,
  h5: ({ children }) => <h6>{children}</h6>,
};

export function MarketplaceOverview({ markdown }: { markdown: string }) {
  return (
    <div className="marketplace-overview">
      <ReactMarkdown
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        skipHtml
        remarkPlugins={REMARK_PLUGINS}
        components={OVERVIEW_COMPONENTS}
        urlTransform={overviewUrlTransform}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
