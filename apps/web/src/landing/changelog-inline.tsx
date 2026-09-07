import { Fragment } from "react";
import type { ReactNode } from "react";
import { isRenderableHref } from "../blog/parse-post";

type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: InlineToken[] }
  | { kind: "link"; href: string; children: InlineToken[] };

function appendText(tokens: InlineToken[], text: string): void {
  if (!text) {
    return;
  }
  const previous = tokens.at(-1);
  if (previous?.kind === "text") {
    previous.text += text;
    return;
  }
  tokens.push({ kind: "text", text });
}

function parseInline(
  text: string,
  allowStrong: boolean,
  allowLink: boolean,
): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const codeStart = text.indexOf("`", cursor);
    const strongStart = allowStrong ? text.indexOf("**", cursor) : -1;
    const linkStart = allowLink ? text.indexOf("[", cursor) : -1;
    const tokenStart = [codeStart, strongStart, linkStart]
      .filter((index) => index !== -1)
      .reduce((lowest, index) => Math.min(lowest, index), text.length);

    if (tokenStart === text.length) {
      appendText(tokens, text.slice(cursor));
      break;
    }

    if (tokenStart === linkStart) {
      appendText(tokens, text.slice(cursor, tokenStart));
      const labelEnd = text.indexOf("](", tokenStart);
      const hrefEnd = labelEnd === -1 ? -1 : text.indexOf(")", labelEnd + 2);
      const href = hrefEnd === -1 ? "" : text.slice(labelEnd + 2, hrefEnd);

      if (hrefEnd === -1 || !isRenderableHref(href)) {
        appendText(tokens, "[");
        cursor = tokenStart + 1;
        continue;
      }

      tokens.push({
        kind: "link",
        href,
        children: parseInline(
          text.slice(tokenStart + 1, labelEnd),
          allowStrong,
          false,
        ),
      });
      cursor = hrefEnd + 1;
      continue;
    }

    appendText(tokens, text.slice(cursor, tokenStart));
    const isCode = tokenStart === codeStart;
    const delimiter = isCode ? "`" : "**";
    const contentStart = tokenStart + delimiter.length;
    const tokenEnd = text.indexOf(delimiter, contentStart);

    if (tokenEnd === -1) {
      appendText(tokens, delimiter);
      cursor = contentStart;
      continue;
    }

    const content = text.slice(contentStart, tokenEnd);
    if (isCode) {
      tokens.push({ kind: "code", text: content });
    } else {
      tokens.push({
        kind: "strong",
        children: parseInline(content, false, allowLink),
      });
    }
    cursor = tokenEnd + delimiter.length;
  }

  return tokens;
}

function renderTokens(tokens: InlineToken[]): ReactNode {
  return tokens.map((token, index) => {
    switch (token.kind) {
      case "code":
        return <code key={index}>{token.text}</code>;
      case "strong":
        return <strong key={index}>{renderTokens(token.children)}</strong>;
      case "link":
        return (
          <a
            key={index}
            href={token.href}
            target="_blank"
            rel="noreferrer"
            className="release-link"
          >
            {renderTokens(token.children)}
          </a>
        );
      case "text":
        return <Fragment key={index}>{token.text}</Fragment>;
    }
  });
}

export function ChangelogInline({ text }: { text: string }): ReactNode {
  return renderTokens(parseInline(text, true, true));
}
