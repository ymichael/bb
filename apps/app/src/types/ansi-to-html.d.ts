declare module "ansi-to-html" {
  export interface AnsiToHtmlOptions {
    bg?: string;
    colors?: string[] | Record<number, string>;
    escapeXML?: boolean;
    fg?: string;
    newline?: boolean;
    stream?: boolean;
  }

  export default class Convert {
    constructor(options?: AnsiToHtmlOptions);
    toHtml(input: string): string;
  }
}
