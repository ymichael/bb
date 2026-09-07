import { ApiError } from "../../errors.js";
import type {
  RegistrySkill,
  RegistrySkillDetail,
  RegistrySkillFile,
} from "@bb/server-contract";

export const SKILLS_BASE_URL = "https://www.skills.sh";
const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE = 100_000;
const MAX_PAGE_SIZE = 100;
const REGISTRY_DETAIL_FILE_LIMIT = 200;
export const REGISTRY_DETAIL_FILE_SIZE_LIMIT = 1_000_000;
const REGISTRY_DETAIL_TOTAL_SIZE_LIMIT = 5_000_000;
export const REGISTRY_SKILL_NAME_PATTERN =
  /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const REGISTRY_SOURCE_PATTERN = /^(?!-)\S+$/u;

export function hasUnsafePathSegment(value: string): boolean {
  return value
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

interface SkillsApiSkill {
  id: string;
  slug: string;
  name: string;
  source: string;
  installs: number;
  installUrl: string | null;
  url: string;
}

export interface SkillsApiPage {
  skills: SkillsApiSkill[];
  total: number;
  hasMore: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'");
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function renderedSkillHtmlToMarkdown(value: string): string {
  return decodeHtml(
    value
      .replace(/<br\s*\/?\s*>/giu, "\n")
      .replace(
        /<h([1-6])[^>]*>/giu,
        (_, level: string) => `${"#".repeat(Number(level))} `,
      )
      .replace(/<\/h[1-6]>/giu, "\n\n")
      .replace(/<li[^>]*>/giu, "- ")
      .replace(/<\/li>/giu, "\n")
      .replace(/<\/?(?:ul|ol)[^>]*>/giu, "\n")
      .replace(/<p[^>]*>/giu, "")
      .replace(/<\/p>/giu, "\n\n")
      .replace(/<code[^>]*>/giu, "`")
      .replace(/<\/code>/giu, "`")
      .replace(/<(?:strong|b)[^>]*>/giu, "**")
      .replace(/<\/(?:strong|b)>/giu, "**")
      .replace(/<(?:em|i)[^>]*>/giu, "_")
      .replace(/<\/(?:em|i)>/giu, "_")
      .replace(/<[^>]*>/gu, ""),
  )
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function extractFirstDivContentsAfter(
  html: string,
  marker: string,
): string | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;

  const divStart = html.indexOf('<div class="prose', markerIndex);
  if (divStart < 0) return null;
  const contentsStart = html.indexOf(">", divStart) + 1;
  if (contentsStart === 0) return null;

  let depth = 1;
  const divPattern = /<\/?div\b[^>]*>/gu;
  divPattern.lastIndex = contentsStart;
  for (const match of html.matchAll(divPattern)) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return html.slice(contentsStart, match.index);
    } else {
      depth += 1;
    }
  }
  return null;
}

export function parsePublicSkillMarkdown(
  html: string,
): RegistrySkillFile[] | null {
  const rendered = extractFirstDivContentsAfter(html, "<span>SKILL.md</span>");
  if (!rendered) return null;
  const contents = renderedSkillHtmlToMarkdown(rendered);
  if (
    contents.length === 0 ||
    contents.length > REGISTRY_DETAIL_FILE_SIZE_LIMIT
  ) {
    return null;
  }
  return [{ path: "SKILL.md", contents }];
}

export function registrySkillUrl(id: string): string {
  return `${SKILLS_BASE_URL}/${id
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function parsePublicDirectorySkills(html: string): RegistrySkill[] {
  const byId = new Map<string, RegistrySkill>();
  const pattern =
    /\\"source\\":\\"([^"\\]+)\\",\\"skillId\\":\\"([^"\\]+)\\",\\"name\\":\\"([^"\\]+)\\",\\"installs\\":(\d+)/gu;
  for (const match of html.matchAll(pattern)) {
    const source = match[1];
    const skillId = match[2];
    const name = match[3];
    const installs = Number(match[4]);
    if (!source || !skillId || !name || !Number.isFinite(installs)) continue;
    const id = `${source}/${skillId}`;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      source,
      skillId,
      name,
      installs,
      stars: null,
      installUrl: source.includes(".")
        ? `https://${source}`
        : `https://github.com/${source}`,
      url: registrySkillUrl(id),
      topic: null,
      summary: null,
    });
  }
  return [...byId.values()];
}

export function parsePublicDetail(
  html: string,
): Pick<RegistrySkill, "topic" | "summary"> {
  const topic = html.match(/href="\/topic\/[^"]+">([^<]+)</u)?.[1] ?? null;
  const summarySection = html.match(
    /Summary<\/div>(?<summary>[\s\S]*?)SKILL\.md/u,
  )?.groups?.summary;
  const summary =
    summarySection === undefined
      ? null
      : stripTags(summarySection)
          .replace(/\bShow more\b$/u, "")
          .trim();
  return {
    topic: topic === null ? null : decodeHtml(topic),
    summary: summary && summary.length > 0 ? summary.slice(0, 280) : null,
  };
}

export function parsePublicDetailSkill(
  html: string,
  id: string,
  source: string,
  skillId: string,
): RegistrySkill | null {
  const scripts = html.matchAll(
    /<script type="application\/ld\+json">(?<json>[\s\S]*?)<\/script>/gu,
  );
  for (const match of scripts) {
    let body: unknown;
    try {
      body = JSON.parse(match.groups?.json ?? "null");
    } catch {
      continue;
    }
    if (
      !isRecord(body) ||
      body["@type"] !== "SoftwareApplication" ||
      body.url !== registrySkillUrl(id) ||
      typeof body.name !== "string" ||
      !isRecord(body.interactionStatistic) ||
      typeof body.interactionStatistic.userInteractionCount !== "number"
    ) {
      continue;
    }
    const detail = parsePublicDetail(html);
    return {
      id,
      source,
      skillId,
      name: body.name,
      installs: body.interactionStatistic.userInteractionCount,
      stars: null,
      installUrl: null,
      url: registrySkillUrl(id),
      topic: detail.topic,
      summary:
        detail.summary ??
        (typeof body.description === "string"
          ? body.description.slice(0, 280)
          : null),
    };
  }
  return null;
}

export function isApiSkill(value: unknown): value is SkillsApiSkill {
  if (typeof value !== "object" || value === null) return false;
  const skill = value as Record<string, unknown>;
  return (
    typeof skill.id === "string" &&
    typeof skill.slug === "string" &&
    typeof skill.name === "string" &&
    typeof skill.source === "string" &&
    typeof skill.installs === "number" &&
    (skill.installUrl === null || typeof skill.installUrl === "string") &&
    typeof skill.url === "string"
  );
}

export function parseRegistryDetailFiles(
  value: unknown,
): RegistrySkillFile[] | null {
  if (!Array.isArray(value) || value.length > REGISTRY_DETAIL_FILE_LIMIT) {
    return null;
  }
  let totalSize = 0;
  const files: RegistrySkillFile[] = [];
  for (const file of value) {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      typeof file.contents !== "string" ||
      file.contents.length > REGISTRY_DETAIL_FILE_SIZE_LIMIT
    ) {
      return null;
    }
    totalSize += file.contents.length;
    if (totalSize > REGISTRY_DETAIL_TOTAL_SIZE_LIMIT) return null;
    files.push({ path: file.path, contents: file.contents });
  }
  return files;
}

export function hasLoadableSkillContent(detail: RegistrySkillDetail): boolean {
  return (
    detail.files?.some((file) => {
      const normalizedPath = file.path.replaceAll("\\", "/").toLowerCase();
      return (
        (normalizedPath === "skill.md" ||
          normalizedPath.endsWith("/skill.md")) &&
        file.contents.trim().length > 0
      );
    }) === true
  );
}

export function githubRepoForSource(source: string): string | null {
  const githubHostPrefix = "github.com/";
  const githubUrlPrefix = "https://github.com/";
  const normalized = source.startsWith(githubUrlPrefix)
    ? source.slice(githubUrlPrefix.length)
    : source.startsWith(githubHostPrefix)
      ? source.slice(githubHostPrefix.length)
      : source;
  if (normalized.includes(".")) return null;

  const [owner, repo] = normalized.split("/");
  if (!owner || !repo) return null;
  const safeSegment = /^[A-Za-z0-9_.-]+$/u;
  if (!safeSegment.test(owner) || !safeSegment.test(repo)) return null;
  return `${owner}/${repo}`;
}

export function parseRegistrySkillId(id: string): {
  source: string;
  skillId: string;
} {
  const separatorIndex = id.lastIndexOf("/");
  const source = id.slice(0, separatorIndex);
  const skillId = id.slice(separatorIndex + 1);
  if (
    id.length === 0 ||
    id.length > 2_048 ||
    separatorIndex < 1 ||
    source.length > 2_048 ||
    !REGISTRY_SOURCE_PATTERN.test(source) ||
    hasUnsafePathSegment(source) ||
    !REGISTRY_SKILL_NAME_PATTERN.test(skillId)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "Expected a valid registry skill ID",
    );
  }
  return { source, skillId };
}

export function packageRefForSource(source: string): string {
  const githubPrefix = "github.com/";
  const ref = source.startsWith(githubPrefix)
    ? source.slice(githubPrefix.length)
    : source.includes(".")
      ? `https://${source}`
      : source;
  if (ref.startsWith("-") || hasUnsafePathSegment(ref)) {
    throw new ApiError(
      400,
      "invalid_registry_source",
      "Invalid registry source",
    );
  }
  return ref;
}

export function parsePageParameter(value: string | undefined): number {
  if (value === undefined) return 0;
  const page = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(page) || page > MAX_PAGE) {
    throw new ApiError(
      400,
      "invalid_request",
      `page must be a nonnegative integer no greater than ${MAX_PAGE}`,
    );
  }
  return page;
}

export function parsePerPageParameter(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!/^\d+$/u.test(value)) {
    throw new ApiError(
      400,
      "invalid_request",
      "perPage must be a positive integer",
    );
  }
  const perPage = Number(value);
  if (
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > MAX_PAGE_SIZE
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      `perPage must be between 1 and ${MAX_PAGE_SIZE}`,
    );
  }
  return perPage;
}
