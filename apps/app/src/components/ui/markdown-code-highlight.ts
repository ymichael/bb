import { highlight, type LanguageName } from "sugar-high";
import { lang } from "sugar-high/lang";

const EXTRA_LANGUAGE_ALIASES: Record<string, LanguageName> = {
  console: "shell",
  shellscript: "shell",
  h: "c",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  less: "css",
};

interface HighlightMarkdownCodeArgs {
  code: string;
  language: string | null;
}

export function highlightMarkdownCode({
  code,
  language,
}: HighlightMarkdownCodeArgs): string {
  const resolved =
    language === null
      ? undefined
      : (lang(language) ?? EXTRA_LANGUAGE_ALIASES[language]);
  return highlight(code, { lang: resolved });
}
