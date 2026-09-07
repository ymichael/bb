import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "docs");

const USAGE = [
  "Usage:",
  "  bb docs search <query...>   Search the bundled docs and print matching lines",
  "  bb docs last                Show the cached last search",
].join("\n");

const DOC_FILE_PATTERN = /^[a-z0-9-]+\.md$/;

interface LastSearch {
  query: string;
  matchCount: number;
  at: number;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    caseSensitive: {
      type: "boolean",
      label: "Case-sensitive search",
      description:
        "Match docs search queries exactly instead of ignoring case.",
      default: false,
    },
  });

  async function search(query: string): Promise<string[]> {
    const { caseSensitive } = await settings.get();
    const needle = caseSensitive ? query : query.toLowerCase();
    const excerpts: string[] = [];
    const files = (await readdir(docsDir))
      .filter((file) => file.endsWith(".md"))
      .sort();
    for (const file of files) {
      const lines = (await readFile(join(docsDir, file), "utf8")).split("\n");
      lines.forEach((line, index) => {
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) {
          excerpts.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    await bb.storage.kv.set("last-search", {
      query,
      matchCount: excerpts.length,
      at: Date.now(),
    } satisfies LastSearch);
    return excerpts;
  }

  async function listDocs(): Promise<Array<{ file: string; title: string }>> {
    const files = (await readdir(docsDir))
      .filter((file) => file.endsWith(".md"))
      .sort();
    const docs: Array<{ file: string; title: string }> = [];
    for (const file of files) {
      const firstLine =
        (await readFile(join(docsDir, file), "utf8")).split("\n")[0] ?? "";
      docs.push({
        file,
        title: firstLine.replace(/^#+\s*/, "").trim() || file,
      });
    }
    return docs;
  }

  bb.cli.register({
    name: "docs",
    summary: "Search this plugin's bundled docs",
    commands: [
      {
        name: "search",
        summary: "Search the docs and print matching lines",
        usage: "bb docs search <query...>",
      },
      {
        name: "last",
        summary: "Show the cached last search",
        usage: "bb docs last",
      },
    ],
    async run(argv) {
      const [sub, ...rest] = argv;
      if (sub === undefined || sub === "help" || sub === "--help") {
        return { exitCode: 0, stdout: USAGE };
      }
      if (sub === "search") {
        const query = rest.join(" ").trim();
        if (query.length === 0) {
          return { exitCode: 1, stderr: `Missing query.\n${USAGE}` };
        }
        const excerpts = await search(query);
        if (excerpts.length === 0) {
          return { exitCode: 0, stdout: `No matches for "${query}".` };
        }
        return { exitCode: 0, stdout: excerpts.join("\n") };
      }
      if (sub === "last") {
        const last = await bb.storage.kv.get<LastSearch>("last-search");
        if (!last) return { exitCode: 0, stdout: "No searches yet." };
        return {
          exitCode: 0,
          stdout: `Last search: "${last.query}" (${last.matchCount} matches)`,
        };
      }
      return { exitCode: 1, stderr: `Unknown subcommand "${sub}".\n${USAGE}` };
    },
  });

  bb.agents.registerTool({
    name: "docs_search",
    description:
      "Search this repository's bundled docs (conventions, testing rules) and return matching lines.",
    instructions:
      "Use the docs_search tool to look up repo conventions and testing rules instead of guessing.",
    parameters: z.object({
      query: z.string().min(1).describe("Text to search for in the docs"),
    }),
    async execute({ query }) {
      const excerpts = await search(query);
      if (excerpts.length === 0) return `No matches for "${query}".`;
      return excerpts.join("\n");
    },
  });

  bb.agents.configure((context) => {
    if (context.project.kind === "personal") {
      return { tools: [], skills: [] };
    }
    return {
      tools: ["docs_search"],
      skills: ["repo-conventions"],
      instructions: `Repository docs enrichment is active for ${context.project.name} on ${context.host.name}.`,
    };
  });

  bb.ui.registerMentionProvider({
    id: "docs",
    label: "Plugin docs",
    async search({ query }) {
      const needle = query.toLowerCase();
      return (await listDocs())
        .filter(
          (doc) =>
            doc.title.toLowerCase().includes(needle) ||
            doc.file.toLowerCase().includes(needle),
        )
        .map((doc) => ({ id: doc.file, title: doc.title, subtitle: doc.file }));
    },
    async resolve(itemId) {
      if (!DOC_FILE_PATTERN.test(itemId)) {
        throw new Error(`unknown doc "${itemId}"`);
      }
      const body = await readFile(join(docsDir, itemId), "utf8");
      return { context: body };
    },
  });
}
