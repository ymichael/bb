const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  vue: "html",
  svelte: "html",

  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "shell",
  xml: "xml",
  csv: "plaintext",
  tsv: "plaintext",

  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  txt: "plaintext",
  text: "plaintext",
  rst: "plaintext",
  adoc: "plaintext",

  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  rs: "rust",
  go: "go",
  zig: "plaintext",
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",

  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  groovy: "plaintext",
  cs: "csharp",
  fs: "fsharp",

  py: "python",
  pyi: "python",
  rb: "ruby",
  php: "php",
  pl: "perl",
  lua: "lua",
  r: "r",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",

  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "plaintext",

  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  dockerfile: "dockerfile",

  dart: "dart",
  ex: "plaintext",
  exs: "plaintext",
  erl: "plaintext",
  clj: "clojure",
  hs: "plaintext",
  jl: "julia",
  patch: "plaintext",
  diff: "plaintext",
  log: "plaintext",
};

export const CLAIMED_EXTENSIONS: readonly string[] = Object.keys(
  LANGUAGE_BY_EXTENSION,
);

export function languageForPath(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return "plaintext";
  const extension = name.slice(dotIndex + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}
