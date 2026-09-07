import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import type { RegistryRanking, RegistrySkill } from "@bb/server-contract";
import type { SkillsRegistryArea } from "@bb/sdk";
import { action } from "../action.js";
import { createCliBbSdk } from "../client.js";
import { resolveMachineId } from "./machine.js";
import type { ContextSnapshot } from "../context-env.js";
import { renderBorderlessTable } from "../table.js";
import {
  confirmDestructiveAction,
  outputJson,
  type JsonOutputOptions,
} from "./helpers.js";

interface SkillWorkspaceOptions extends JsonOutputOptions {
  environment?: string;
  project?: string;
}

interface SkillDeleteOptions extends SkillWorkspaceOptions {
  yes?: boolean;
}

interface SkillUpdateOptions extends SkillWorkspaceOptions {
  file: string;
  revision: string;
}

interface SkillInstallCliSkillsOptions extends JsonOutputOptions {
  machine: string[];
}

interface SkillSearchOptions extends JsonOutputOptions {
  page?: string;
  perPage?: string;
}

function projectId(
  options: SkillWorkspaceOptions,
  context: ContextSnapshot,
): string {
  return options.project ?? context.projectId ?? PERSONAL_PROJECT_ID;
}

function environmentId(options: SkillWorkspaceOptions): string | null {
  return options.environment ?? null;
}

function collectMachineTarget(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseNonnegativeInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a nonnegative integer, received "${value}".`);
  }
  return parsed;
}

function addWorkspaceOptions(command: Command): Command {
  return command
    .option(
      "--project <id>",
      "Project ID (defaults to BB_PROJECT_ID or personal)",
    )
    .option("--environment <id>", "Project environment workspace")
    .option("--json", "Print machine-readable JSON output");
}

const REGISTRY_ENRICH_CONCURRENCY = 6;
const REGISTRY_ENRICH_LIMIT = 48;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function enrichRegistryStars(
  registry: SkillsRegistryArea,
  skills: readonly RegistrySkill[],
): Promise<RegistrySkill[]> {
  const sources = [
    ...new Map(
      skills
        .filter((skill) => skill.stars === null)
        .map((skill) => [skill.source.toLowerCase(), skill.source]),
    ).entries(),
  ].slice(0, REGISTRY_ENRICH_LIMIT);
  const starsBySource = new Map(
    await mapWithConcurrency(
      sources,
      REGISTRY_ENRICH_CONCURRENCY,
      async ([sourceKey, source]) => {
        const stars = await registry
          .repositoryStars({ source })
          .then((result) => result.stars)
          .catch(() => null);
        return [sourceKey, stars] as const;
      },
    ),
  );
  return skills.map((skill) => {
    if (skill.stars !== null) return skill;
    const stars = starsBySource.get(skill.source.toLowerCase());
    return stars === null || stars === undefined ? skill : { ...skill, stars };
  });
}

interface EnrichedRegistrySkill extends RegistrySkill {
  lifetimeInstalls: number | null;
}

async function enrichRegistryEntries(
  registry: SkillsRegistryArea,
  skills: readonly RegistrySkill[],
  ranking: RegistryRanking,
): Promise<EnrichedRegistrySkill[]> {
  const needsLifetimeInstalls = ranking === "trending";
  const missing = skills
    .filter((skill) => skill.summary === null || needsLifetimeInstalls)
    .slice(0, REGISTRY_ENRICH_LIMIT);
  const entryById = new Map(
    await mapWithConcurrency(
      missing,
      REGISTRY_ENRICH_CONCURRENCY,
      async (skill) => {
        const entry = await registry
          .get({ registrySkillId: skill.id })
          .catch(() => null);
        return [skill.id, entry] as const;
      },
    ),
  );
  return skills.map((skill) => {
    const entry = entryById.get(skill.id) ?? null;
    return {
      ...skill,
      summary: entry?.summary ?? skill.summary,
      lifetimeInstalls: needsLifetimeInstalls
        ? (entry?.installs ?? null)
        : skill.installs,
    };
  });
}

export function registerSkillCommands(
  program: Command,
  getUrl: () => string,
  getContext: () => ContextSnapshot,
): void {
  const skill = program
    .command("skill")
    .description("List, inspect, edit, install, and remove skills");

  addWorkspaceOptions(skill.command("list"))
    .description("List installed and discovered skills")
    .action(
      action(async (options: SkillWorkspaceOptions) => {
        const result = await createCliBbSdk(getUrl()).skills.list({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
        });
        if (outputJson(options, result)) return;
        console.log(
          renderBorderlessTable(
            {
              head: ["ID", "NAME", "SCOPE", "PROVIDER", "EDITABLE", "PATH"],
              colWidths: [72, 24, 18, 14, 10, 48],
              trimTrailingWhitespace: true,
            },
            result.skills.map((entry) => [
              entry.id,
              entry.name,
              entry.scope,
              entry.provider ?? "bb",
              entry.manageable ? "yes" : "no",
              entry.filePath,
            ]),
          ),
        );
      }),
    );

  addWorkspaceOptions(skill.command("show <skill-id>"))
    .description("Print an installed skill file")
    .option("--path <path>", "Skill-relative file path", "SKILL.md")
    .action(
      action(
        async (
          skillId: string,
          options: SkillWorkspaceOptions & { path: string },
        ) => {
          const result = await createCliBbSdk(getUrl()).skills.getContent({
            projectId: projectId(options, getContext()),
            environmentId: environmentId(options),
            skillId,
            path: options.path,
          });
          if (outputJson(options, result)) return;
          console.error(`Revision: ${result.revision}`);
          process.stdout.write(result.content);
        },
      ),
    );

  addWorkspaceOptions(skill.command("files <skill-id>"))
    .description("List files included in an installed skill")
    .action(
      action(async (skillId: string, options: SkillWorkspaceOptions) => {
        const result = await createCliBbSdk(getUrl()).skills.listFiles({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
          skillId,
        });
        if (outputJson(options, result)) return;
        for (const path of result.files) console.log(path);
        if (result.truncated) console.error("File list truncated.");
      }),
    );

  addWorkspaceOptions(skill.command("update <skill-id>"))
    .description("Replace an editable skill's SKILL.md from a local file")
    .requiredOption("--file <path>", "Local SKILL.md to upload")
    .requiredOption(
      "--revision <sha256>",
      "Revision returned by bb skill show --json",
    )
    .action(
      action(async (skillId: string, options: SkillUpdateOptions) => {
        const result = await createCliBbSdk(getUrl()).skills.update({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
          skillId,
          content: await readFile(options.file, "utf8"),
          revision: options.revision,
        });
        if (outputJson(options, result)) return;
        console.log(`Updated ${result.filePath}`);
      }),
    );

  addWorkspaceOptions(skill.command("delete <skill-id>"))
    .description("Delete an editable user-owned skill")
    .option("--yes", "Skip the confirmation prompt")
    .action(
      action(async (skillId: string, options: SkillDeleteOptions) => {
        if (
          !options.yes &&
          !(await confirmDestructiveAction(
            `Delete ${skillId}? This cannot be undone.`,
          ))
        ) {
          console.log("Aborted.");
          return;
        }
        const result = await createCliBbSdk(getUrl()).skills.remove({
          projectId: projectId(options, getContext()),
          environmentId: environmentId(options),
          skillId,
        });
        if (outputJson(options, result)) return;
        console.log(`Deleted ${result.deletedPath}`);
      }),
    );

  skill
    .command("search [query]")
    .description(
      "Search the skills.sh registry, or list what is trending with no query",
    )
    .option("--page <number>", "Zero-based result page", "0")
    .option(
      "--per-page <number>",
      `Results per page; above ${REGISTRY_ENRICH_LIMIT} leaves lifetime install counts unresolved`,
      "24",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (query: string | undefined, options: SkillSearchOptions) => {
        const registry = createCliBbSdk(getUrl()).skills.registry;
        const result = await registry.search({
          query,
          page: parseNonnegativeInteger(options.page, 0),
          perPage: parseNonnegativeInteger(options.perPage, 24),
        });
        const enrichedSkills = await enrichRegistryEntries(
          registry,
          await enrichRegistryStars(registry, result.skills),
          result.ranking,
        );
        const enrichedResult = { ...result, skills: enrichedSkills };
        const unresolvedCount = enrichedSkills.filter(
          (entry) => entry.lifetimeInstalls === null,
        ).length;
        if (unresolvedCount > 0) {
          console.error(
            `Lifetime install counts unresolved for ${unresolvedCount} of ` +
              `${enrichedSkills.length} skills — a detail page could not be ` +
              `fetched, or the page exceeds the ${REGISTRY_ENRICH_LIMIT}-row ` +
              `enrichment cap. Those rows carry lifetimeInstalls: null and ` +
              `print as "—"; installs still counts the ranking's window.`,
          );
        }
        if (outputJson(options, enrichedResult)) return;
        console.log(
          renderBorderlessTable(
            {
              head: ["ID", "INSTALLS", "STARS", "SUMMARY"],
              colWidths: [48, 12, 10, 48],
              trimTrailingWhitespace: true,
            },
            enrichedResult.skills.map((entry) => [
              entry.id,
              entry.lifetimeInstalls === null
                ? "—"
                : String(entry.lifetimeInstalls),
              entry.stars === null ? "—" : String(entry.stars),
              entry.summary ?? "",
            ]),
          ),
        );
      }),
    );

  skill
    .command("registry")
    .description("Inspect skills.sh registry entries")
    .command("detail <registry-skill-id>")
    .description("Show registry metadata and the bounded file preview")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (registrySkillId: string, options: JsonOutputOptions) => {
        const registry = createCliBbSdk(getUrl()).skills.registry;
        const skillEntry = await registry.get({ registrySkillId });
        const [detail, [enrichedSkillEntry]] = await Promise.all([
          registry.detail({
            source: skillEntry.source,
            skillId: skillEntry.skillId,
          }),
          enrichRegistryStars(registry, [skillEntry]),
        ]);
        const result = { skill: enrichedSkillEntry ?? skillEntry, detail };
        if (outputJson(options, result)) return;
        console.log(`Name: ${result.skill.name}`);
        console.log(`ID: ${result.skill.id}`);
        console.log(`Source: ${result.skill.source}`);
        console.log(`Installs: ${result.skill.installs}`);
        console.log(`Stars: ${result.skill.stars ?? "—"}`);
        console.log(`URL: ${result.skill.url}`);
        if (result.skill.summary)
          console.log(`Summary: ${result.skill.summary}`);
        console.log(`Revision: ${detail.hash ?? "unknown"}`);
        if (detail.files === null) {
          console.log("Files: unavailable");
          return;
        }
        for (const file of detail.files) {
          console.log(`\n--- ${file.path} ---`);
          process.stdout.write(file.contents);
          if (!file.contents.endsWith("\n")) process.stdout.write("\n");
        }
      }),
    );

  skill
    .command("install <registry-skill-id>")
    .description("Install a canonical skills.sh entry into bb user skills")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (registrySkillId: string, options: JsonOutputOptions) => {
        const result = await createCliBbSdk(getUrl()).skills.registry.install({
          registrySkillId,
        });
        if (outputJson(options, result)) return;
        console.log(`Installed ${result.filePath}`);
      }),
    );

  skill
    .command("cli-skills-status")
    .description(
      "Show whether each machine has bb's built-in CLI skills installed",
    )
    .option(
      "--machine <id-or-name>",
      "Machine to report on (repeatable, defaults to every machine)",
      collectMachineTarget,
      [],
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (options: SkillInstallCliSkillsOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hosts = options.machine.length > 0 ? await sdk.hosts.list() : [];
        const hostIds =
          options.machine.length > 0
            ? options.machine.map((target) => resolveMachineId(hosts, target))
            : undefined;
        const result = await sdk.system.cliSkillsStatus(
          hostIds === undefined ? {} : { hostIds },
        );
        if (outputJson(options, result)) return;
        console.log(
          renderBorderlessTable(
            {
              head: ["MACHINE", "STATUS"],
              colWidths: [32, 16],
              trimTrailingWhitespace: true,
            },
            result.machines.map((machine) => [
              machine.hostName,
              machine.status,
            ]),
          ),
        );
      }),
    );

  skill
    .command("install-cli-skills")
    .description(
      "Install bb's built-in CLI skills into ~/.agents/skills and ~/.claude/skills on a machine",
    )
    .option(
      "--machine <id-or-name>",
      "Machine to install onto (repeatable, defaults to every connected machine)",
      collectMachineTarget,
      [],
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (options: SkillInstallCliSkillsOptions) => {
        const sdk = createCliBbSdk(getUrl());
        const hosts = await sdk.hosts.list();
        const hostIds =
          options.machine.length > 0
            ? options.machine.map((target) => resolveMachineId(hosts, target))
            : hosts
                .filter((host) => host.status === "connected")
                .map((host) => host.id);
        if (hostIds.length === 0) {
          throw new Error("No connected machine to install the skills onto.");
        }
        const result = await sdk.system.installCliSkills({ hostIds });
        if (outputJson(options, result)) return;
        for (const entry of result.results) {
          if (!entry.ok) {
            console.error(`${entry.hostName}: ${entry.errorMessage}`);
            continue;
          }
          for (const installation of entry.installations) {
            console.log(
              `${entry.hostName}: installed ${installation.name} to ${installation.path}`,
            );
          }
        }
        if (result.results.some((entry) => !entry.ok)) {
          throw new Error("The install failed on at least one machine.");
        }
      }),
    );
}
