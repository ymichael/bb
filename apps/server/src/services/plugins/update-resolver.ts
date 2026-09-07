import semver from "semver";
import { z } from "zod";
import { PLUGIN_SDK_VERSION } from "@bb/domain";
import {
  DEFAULT_GIT_REF,
  gitSemverTagName,
  gitSemverTagVersion,
  isCommitSha,
  runInstallCommand,
} from "./install-sources.js";
import {
  isPluginSdkRangeSatisfied,
  pluginSdkRangeProblem,
} from "./sdk-compat.js";

export type NpmSpecKind = "default" | "exact" | "tag" | "range";
export type GitRefKind = "branch" | "tag" | "commit";

export interface CompatibilityProblem {
  engine: "bb" | "bbPluginSdk";
  required: string;
  actual: string;
  message: string;
}

export interface PluginResolvedUpdateVersion {
  version: string;
  display: string;
}

interface ResolutionFlags {
  devMode?: true;
  blocked?: {
    version: PluginResolvedUpdateVersion;
    reasons: CompatibilityProblem[];
  };
  packagedBuildProblems?: CompatibilityProblem[];
}

export type PluginUpdateResolution =
  | ({
      outcome: "current";
      current: PluginResolvedUpdateVersion;
    } & ResolutionFlags)
  | ({
      outcome: "update-available";
      current: PluginResolvedUpdateVersion;
      candidate: PluginResolvedUpdateVersion;
      candidateGitTag?: string;
    } & ResolutionFlags)
  | ({
      outcome: "pinned";
      current: PluginResolvedUpdateVersion;
    } & ResolutionFlags)
  | ({
      outcome: "incompatible";
      current?: PluginResolvedUpdateVersion;
      newest: PluginResolvedUpdateVersion;
      reasons: CompatibilityProblem[];
    } & ResolutionFlags)
  | ({ outcome: "unavailable"; detail: string } & ResolutionFlags);

export interface NpmSourceIntentForResolution {
  packageName: string;
  registry: string;
  requestedSpec: string;
  specKind: NpmSpecKind;
}

export interface NpmResolvedCandidate extends PluginResolvedUpdateVersion {
  integrity: string;
  engines: {
    bb: string | undefined;
    bbPluginSdk: string | undefined;
  };
}

const packumentVersionSchema = z.object({
  version: z.string(),
  engines: z
    .object({
      bb: z.string().optional(),
      bbPluginSdk: z.string().optional(),
    })
    .optional(),
  dist: z
    .object({
      integrity: z.string().optional(),
      tarball: z.string().url().optional(),
    })
    .optional(),
});

const packumentSchema = z.object({
  versions: z.record(z.string(), packumentVersionSchema),
  "dist-tags": z.record(z.string(), z.string()).default({}),
});

type Packument = z.infer<typeof packumentSchema>;

export interface NpmResolverRun {
  getPackument(intent: NpmSourceIntentForResolution): Promise<Packument>;
}

export function createNpmResolverRun(options?: {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readJson?: (response: Response) => Promise<unknown>;
}): NpmResolverRun {
  const fetchImpl = options?.fetch ?? fetch;
  const readJson =
    options?.readJson ?? ((response: Response) => response.json());
  const cache = new Map<string, Promise<Packument>>();
  return {
    getPackument(intent) {
      const registry = intent.registry.replace(/\/+$/, "");
      const key = `${registry}\n${intent.packageName}`;
      const existing = cache.get(key);
      if (existing) return existing;
      const pending = (async () => {
        let response: Response;
        try {
          response = await fetchImpl(
            `${registry}/${encodeURIComponent(intent.packageName)}`,
            {
              headers: {
                accept: "application/vnd.npm.install-v1+json, application/json",
              },
            },
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new NpmPackageUnavailableError(
            `${intent.packageName} registry request failed: ${detail}`,
          );
        }
        if (!response.ok) {
          throw new NpmPackageUnavailableError(
            `${intent.packageName} registry request failed: ${response.status} ${response.statusText}`,
          );
        }
        const json = await readJson(response);
        const parsed = packumentSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error(
            `registry returned malformed metadata for ${intent.packageName}: ${parsed.error.issues[0]?.message ?? "invalid packument"}`,
          );
        }
        return parsed.data;
      })();
      cache.set(key, pending);
      return pending;
    },
  };
}

class NpmPackageUnavailableError extends Error {}

function requestedRangeIncludesPrerelease(spec: string): boolean {
  const range = new semver.Range(spec);
  return range.set.some((comparators) =>
    comparators.some((comparator) => {
      const version: unknown = comparator.semver;
      return version instanceof semver.SemVer && version.prerelease.length > 0;
    }),
  );
}

function allowedNpmVersions(
  packument: Packument,
  intent: NpmSourceIntentForResolution,
): string[] | { unavailable: string } {
  let versions: string[];
  if (intent.specKind === "exact") {
    versions = [intent.requestedSpec];
  } else if (intent.specKind === "tag") {
    const tagged = packument["dist-tags"][intent.requestedSpec];
    if (tagged === undefined) {
      return {
        unavailable: `npm dist-tag "${intent.requestedSpec}" does not exist for ${intent.packageName}`,
      };
    }
    versions = [tagged];
  } else if (intent.specKind === "range") {
    versions = Object.keys(packument.versions).filter((version) =>
      semver.satisfies(version, intent.requestedSpec),
    );
  } else {
    versions = Object.keys(packument.versions).filter(
      (version) => semver.valid(version) !== null,
    );
  }

  const permitsPrerelease =
    (intent.specKind === "exact" &&
      semver.prerelease(intent.requestedSpec) !== null) ||
    (intent.specKind === "range" &&
      requestedRangeIncludesPrerelease(intent.requestedSpec));
  return versions
    .filter((version) => semver.valid(version) !== null)
    .filter(
      (version) => permitsPrerelease || semver.prerelease(version) === null,
    )
    .sort(semver.rcompare);
}

export function evaluateCompatibility(args: {
  bbRange: string | undefined;
  sdkRange: string | undefined;
  appVersion: string;
}): {
  effective: CompatibilityProblem[];
  packaged: CompatibilityProblem[];
  devMode: boolean;
} {
  const appVersion = semver.coerce(args.appVersion);
  if (!appVersion) {
    throw new Error(`cannot parse running bb version "${args.appVersion}"`);
  }
  const devMode = appVersion.version === "0.0.0";
  const bbProblems: CompatibilityProblem[] = [];
  if (args.bbRange !== undefined) {
    if (semver.validRange(args.bbRange) === null) {
      bbProblems.push({
        engine: "bb",
        required: args.bbRange,
        actual: appVersion.version,
        message: `declares invalid engines.bb range ${JSON.stringify(args.bbRange)}`,
      });
    } else if (!semver.satisfies(appVersion, args.bbRange)) {
      bbProblems.push({
        engine: "bb",
        required: args.bbRange,
        actual: appVersion.version,
        message: `requires bb ${args.bbRange}, running bb is ${appVersion.version}`,
      });
    }
  }
  const sdkProblems: CompatibilityProblem[] = [];
  if (args.sdkRange !== undefined) {
    if (semver.validRange(args.sdkRange) === null) {
      sdkProblems.push({
        engine: "bbPluginSdk",
        required: args.sdkRange,
        actual: PLUGIN_SDK_VERSION,
        message: `declares invalid engines.bbPluginSdk range ${JSON.stringify(args.sdkRange)}`,
      });
    } else if (!isPluginSdkRangeSatisfied(args.sdkRange)) {
      sdkProblems.push({
        engine: "bbPluginSdk",
        required: args.sdkRange,
        actual: PLUGIN_SDK_VERSION,
        message: pluginSdkRangeProblem(args.sdkRange),
      });
    }
  }
  return {
    effective: devMode ? sdkProblems : [...bbProblems, ...sdkProblems],
    packaged: bbProblems,
    devMode,
  };
}

function npmDisplay(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

export async function selectNpmCandidate(args: {
  intent: NpmSourceIntentForResolution;
  appVersion: string;
  run: NpmResolverRun;
}): Promise<
  | {
      outcome: "selected";
      candidate: NpmResolvedCandidate;
      blocked?: {
        candidate: NpmResolvedCandidate;
        reasons: CompatibilityProblem[];
      };
      packagedBuildProblems: CompatibilityProblem[];
      devMode: boolean;
    }
  | {
      outcome: "incompatible";
      newest: NpmResolvedCandidate;
      reasons: CompatibilityProblem[];
      devMode: boolean;
    }
  | { outcome: "unavailable"; detail: string; devMode: boolean }
> {
  let packument: Packument;
  try {
    packument = await args.run.getPackument(args.intent);
  } catch (error) {
    if (error instanceof NpmPackageUnavailableError) {
      return {
        outcome: "unavailable",
        detail: error.message,
        devMode: semver.coerce(args.appVersion)?.version === "0.0.0",
      };
    }
    throw error;
  }
  const allowed = allowedNpmVersions(packument, args.intent);
  const devMode = semver.coerce(args.appVersion)?.version === "0.0.0";
  if (!Array.isArray(allowed)) {
    return { outcome: "unavailable", detail: allowed.unavailable, devMode };
  }
  if (allowed.length === 0) {
    return {
      outcome: "unavailable",
      detail: `no published version of ${args.intent.packageName} matches ${args.intent.requestedSpec || "stable releases"}`,
      devMode,
    };
  }

  let newestCandidate: NpmResolvedCandidate | undefined;
  let newestProblems: CompatibilityProblem[] = [];
  let blocked:
    | { candidate: NpmResolvedCandidate; reasons: CompatibilityProblem[] }
    | undefined;
  for (const version of allowed) {
    const metadata = packument.versions[version];
    if (!metadata) continue;
    const candidate: NpmResolvedCandidate = {
      version,
      display: npmDisplay(args.intent.packageName, version),
      integrity: metadata.dist?.integrity ?? "",
      engines: {
        bb: metadata.engines?.bb,
        bbPluginSdk: metadata.engines?.bbPluginSdk,
      },
    };
    const problems = evaluateCompatibility({
      bbRange: candidate.engines.bb,
      sdkRange: candidate.engines.bbPluginSdk,
      appVersion: args.appVersion,
    });
    newestCandidate ??= candidate;
    if (newestCandidate === candidate) newestProblems = problems.effective;
    if (problems.effective.length > 0) {
      blocked ??= { candidate, reasons: problems.effective };
      continue;
    }
    return {
      outcome: "selected",
      candidate,
      ...(blocked ? { blocked } : {}),
      packagedBuildProblems: problems.packaged,
      devMode: problems.devMode,
    };
  }
  if (!newestCandidate) {
    return {
      outcome: "unavailable",
      detail: `registry metadata contains no usable versions for ${args.intent.packageName}`,
      devMode,
    };
  }
  return {
    outcome: "incompatible",
    newest: newestCandidate,
    reasons: newestProblems,
    devMode,
  };
}

export async function resolveNpmUpdate(args: {
  intent: NpmSourceIntentForResolution;
  current: PluginResolvedUpdateVersion;
  appVersion: string;
  run: NpmResolverRun;
}): Promise<PluginUpdateResolution> {
  const devMode = semver.coerce(args.appVersion)?.version === "0.0.0";
  if (args.intent.specKind === "exact") {
    return {
      outcome: "pinned",
      current: args.current,
      ...(devMode ? { devMode: true } : {}),
    };
  }
  const selected = await selectNpmCandidate(args);
  const flags = {
    ...(selected.devMode ? { devMode: true as const } : {}),
  };
  if (selected.outcome === "unavailable") {
    return { outcome: "unavailable", detail: selected.detail, ...flags };
  }
  if (selected.outcome === "incompatible") {
    return {
      outcome: "incompatible",
      current: args.current,
      newest: selected.newest,
      reasons: selected.reasons,
      ...flags,
    };
  }
  const extra = {
    ...flags,
    ...(selected.blocked
      ? {
          blocked: {
            version: selected.blocked.candidate,
            reasons: selected.blocked.reasons,
          },
        }
      : {}),
    ...(selected.packagedBuildProblems.length > 0
      ? { packagedBuildProblems: selected.packagedBuildProblems }
      : {}),
  };
  if (selected.candidate.version === args.current.version) {
    return { outcome: "current", current: args.current, ...extra };
  }
  return {
    outcome: "update-available",
    current: args.current,
    candidate: selected.candidate,
    ...extra,
  };
}

function parseLsRemote(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.trim().length === 0) continue;
    const [commit, ref, extra] = line.trim().split(/\s+/);
    if (extra !== undefined || commit === undefined || ref === undefined) {
      throw new Error(
        `malformed git ls-remote output: ${JSON.stringify(line)}`,
      );
    }
    if (!/^[0-9a-f]{40}$/i.test(commit)) {
      throw new Error(
        `git ls-remote returned invalid object id ${JSON.stringify(commit)}`,
      );
    }
    refs.set(ref, commit.toLowerCase());
  }
  return refs;
}

export async function resolveGitRef(args: {
  url: string;
  ref: string;
}): Promise<
  | { outcome: "resolved"; refKind: GitRefKind; commit: string }
  | { outcome: "unavailable"; detail: string }
> {
  if (isCommitSha(args.ref)) {
    return {
      outcome: "resolved",
      refKind: "commit",
      commit: args.ref.toLowerCase(),
    };
  }
  if (args.ref === DEFAULT_GIT_REF) {
    const output = await runInstallCommand(
      "git",
      ["ls-remote", args.url, DEFAULT_GIT_REF],
      { notFoundHint: GIT_NOT_FOUND_HINT },
    );
    const commit = parseLsRemote(output).get(DEFAULT_GIT_REF);
    return commit === undefined
      ? {
          outcome: "unavailable",
          detail: `git default branch was not found in ${args.url}`,
        }
      : { outcome: "resolved", refKind: "branch", commit };
  }
  const output = await runInstallCommand(
    "git",
    [
      "ls-remote",
      args.url,
      `refs/tags/${args.ref}`,
      `refs/tags/${args.ref}^{}`,
      `refs/heads/${args.ref}`,
    ],
    { notFoundHint: GIT_NOT_FOUND_HINT },
  );
  const refs = parseLsRemote(output);
  const tag =
    refs.get(`refs/tags/${args.ref}^{}`) ?? refs.get(`refs/tags/${args.ref}`);
  if (tag !== undefined) {
    return { outcome: "resolved", refKind: "tag", commit: tag };
  }
  const branch = refs.get(`refs/heads/${args.ref}`);
  if (branch !== undefined) {
    return { outcome: "resolved", refKind: "branch", commit: branch };
  }
  return {
    outcome: "unavailable",
    detail: `git ref "${args.ref}" was not found in ${args.url}`,
  };
}

export function gitResolvedVersion(args: {
  url: string;
  ref: string;
  commit: string;
}): PluginResolvedUpdateVersion {
  return {
    version: args.commit,
    display: `${args.url}@${args.ref} (${args.commit.slice(0, 12)})`,
  };
}

export interface GitSemverTag {
  tag: string;
  version: string;
  commit: string;
}

const MAX_LS_REMOTE_TAG_BYTES = 8 * 1024 * 1024;

const GIT_NOT_FOUND_HINT =
  '"git" was not found on PATH — git plugin updates require git';

export async function listGitSemverTags(args: {
  url: string;
  tagPrefix: string;
}): Promise<GitSemverTag[]> {
  const output = await runInstallCommand(
    "git",
    [
      "ls-remote",
      "--tags",
      args.url,
      `refs/tags/${args.tagPrefix}v*`,
      `refs/tags/${args.tagPrefix}v*^{}`,
    ],
    {
      notFoundHint: GIT_NOT_FOUND_HINT,
      maxStdoutBytes: MAX_LS_REMOTE_TAG_BYTES,
    },
  );
  const refs = parseLsRemote(output);
  const tags: GitSemverTag[] = [];
  for (const [ref, commit] of refs) {
    if (!ref.startsWith("refs/tags/") || ref.endsWith("^{}")) continue;
    const tag = ref.slice("refs/tags/".length);
    const version = gitSemverTagVersion(tag, args.tagPrefix);
    if (version === null) continue;
    tags.push({ tag, version, commit: refs.get(`${ref}^{}`) ?? commit });
  }
  return tags.sort((left, right) =>
    semver.rcompare(left.version, right.version),
  );
}

export function selectGitSemverTag(args: {
  tags: readonly GitSemverTag[];
  range: string;
}): GitSemverTag | null {
  return satisfyingGitSemverTags(args)[0] ?? null;
}

function satisfyingGitSemverTags(args: {
  tags: readonly GitSemverTag[];
  range: string;
}): GitSemverTag[] {
  const permitsPrerelease = requestedRangeIncludesPrerelease(args.range);
  return args.tags
    .filter((tag) => semver.satisfies(tag.version, args.range))
    .filter(
      (tag) => permitsPrerelease || semver.prerelease(tag.version) === null,
    )
    .sort((left, right) => semver.rcompare(left.version, right.version));
}

function movedGitTagDetail(args: {
  url: string;
  tag: string;
  recordedCommit: string;
  currentCommit: string;
}): string | null {
  if (args.currentCommit === args.recordedCommit) return null;
  return (
    `security check failed: git tag "${args.tag}" in ${args.url} moved from ` +
    `${args.recordedCommit} to ${args.currentCommit}; bb will not re-resolve a ` +
    `tag that changed. Remove the plugin and install it again to accept the new commit`
  );
}

type GitUpdateIntent =
  | { kind: "ref"; ref: string; refKind: GitRefKind }
  | {
      kind: "range";
      range: string;
      tagPrefix: string;
      resolvedTag: string;
    };

export type GitCandidateProbeResult =
  | {
      outcome: "compatible";
      devMode: boolean;
      packagedBuildProblems: CompatibilityProblem[];
    }
  | {
      outcome: "incompatible";
      reasons: CompatibilityProblem[];
      devMode: boolean;
    }
  | { outcome: "invalid"; detail: string };

export type GitCandidateProbe = (
  candidate: GitSemverTag,
) => Promise<GitCandidateProbeResult>;

const MAX_GIT_CANDIDATE_PROBES = 10;

async function resolveGitRangeUpdate(args: {
  url: string;
  intent: Extract<GitUpdateIntent, { kind: "range" }>;
  current: PluginResolvedUpdateVersion;
  currentCommit: string;
  probeCandidate?: GitCandidateProbe;
}): Promise<PluginUpdateResolution> {
  const tags = await listGitSemverTags({
    url: args.url,
    tagPrefix: args.intent.tagPrefix,
  });
  const recorded = tags.find((tag) => tag.tag === args.intent.resolvedTag);
  if (recorded === undefined) {
    return {
      outcome: "unavailable",
      detail:
        `security check failed: recorded git tag "${args.intent.resolvedTag}" no longer exists in ${args.url}; ` +
        "bb will not re-resolve a missing release tag. Restore the tag, or remove and install the plugin again",
    };
  }
  const moved = movedGitTagDetail({
    url: args.url,
    tag: recorded.tag,
    recordedCommit: args.currentCommit,
    currentCommit: recorded.commit,
  });
  if (moved !== null) return { outcome: "unavailable", detail: moved };
  const candidates = satisfyingGitSemverTags({
    tags,
    range: args.intent.range,
  });
  if (candidates.length === 0) {
    return {
      outcome: "unavailable",
      detail: `no tag of ${args.url} matches ${args.intent.range} (looking for tags named "${gitSemverTagName(args.intent.tagPrefix, "X.Y.Z")}")`,
    };
  }
  const probeCandidate = args.probeCandidate;
  if (probeCandidate === undefined) {
    const selected = candidates[0];
    if (selected === undefined || selected.commit === args.currentCommit) {
      return { outcome: "current", current: args.current };
    }
    return {
      outcome: "update-available",
      current: args.current,
      candidateGitTag: selected.tag,
      candidate: gitResolvedVersion({
        url: args.url,
        ref: selected.tag,
        commit: selected.commit,
      }),
    };
  }
  let blocked: ResolutionFlags["blocked"] | undefined;
  let invalidDetail: string | undefined;
  let probes = 0;
  for (const candidate of candidates) {
    const version = gitResolvedVersion({
      url: args.url,
      ref: candidate.tag,
      commit: candidate.commit,
    });
    if (candidate.commit === args.currentCommit) {
      return {
        outcome: "current",
        current: args.current,
        ...(blocked ? { blocked } : {}),
      };
    }
    if (probes >= MAX_GIT_CANDIDATE_PROBES) {
      return {
        outcome: "unavailable",
        detail: `no release of ${args.url} matching ${args.intent.range} runs on this bb within the newest ${MAX_GIT_CANDIDATE_PROBES} releases`,
      };
    }
    probes += 1;
    const probed = await probeCandidate(candidate);
    if (probed.outcome === "invalid") {
      invalidDetail ??= probed.detail;
      continue;
    }
    if (probed.outcome === "incompatible") {
      blocked ??= { version, reasons: probed.reasons };
      continue;
    }
    return {
      outcome: "update-available",
      current: args.current,
      candidate: version,
      candidateGitTag: candidate.tag,
      ...(blocked ? { blocked } : {}),
      ...(probed.devMode ? { devMode: true } : {}),
      ...(probed.packagedBuildProblems.length > 0
        ? { packagedBuildProblems: probed.packagedBuildProblems }
        : {}),
    };
  }
  if (blocked !== undefined) {
    return {
      outcome: "incompatible",
      current: args.current,
      newest: blocked.version,
      reasons: blocked.reasons,
    };
  }
  return {
    outcome: "unavailable",
    detail:
      invalidDetail ??
      `no tag of ${args.url} matches ${args.intent.range} (looking for tags named "${gitSemverTagName(args.intent.tagPrefix, "X.Y.Z")}")`,
  };
}

export async function resolveGitUpdate(args: {
  url: string;
  intent: GitUpdateIntent;
  currentCommit: string;
  probeCandidate?: GitCandidateProbe;
}): Promise<PluginUpdateResolution> {
  const current = gitResolvedVersion({
    url: args.url,
    ref:
      args.intent.kind === "range" ? args.intent.resolvedTag : args.intent.ref,
    commit: args.currentCommit,
  });
  if (args.intent.kind === "range") {
    return resolveGitRangeUpdate({
      url: args.url,
      intent: args.intent,
      current,
      currentCommit: args.currentCommit,
      ...(args.probeCandidate === undefined
        ? {}
        : { probeCandidate: args.probeCandidate }),
    });
  }
  if (args.intent.refKind === "commit") return { outcome: "pinned", current };
  const resolved = await resolveGitRef({ url: args.url, ref: args.intent.ref });
  if (resolved.outcome === "unavailable") return resolved;
  if (args.intent.refKind === "tag") {
    const moved = movedGitTagDetail({
      url: args.url,
      tag: args.intent.ref,
      recordedCommit: args.currentCommit,
      currentCommit: resolved.commit,
    });
    return moved === null
      ? { outcome: "pinned", current }
      : { outcome: "unavailable", detail: moved };
  }
  const candidate = gitResolvedVersion({
    url: args.url,
    ref: args.intent.ref,
    commit: resolved.commit,
  });
  if (resolved.commit === args.currentCommit) {
    return { outcome: "current", current };
  }
  return { outcome: "update-available", current, candidate };
}

export async function resolveGitRange(args: {
  url: string;
  range: string;
  tagPrefix: string;
  probeCandidate?: GitCandidateProbe;
}): Promise<
  | { outcome: "resolved"; tag: string; version: string; commit: string }
  | { outcome: "unavailable"; detail: string }
> {
  const tags = await listGitSemverTags({
    url: args.url,
    tagPrefix: args.tagPrefix,
  });
  const candidates = satisfyingGitSemverTags({ tags, range: args.range });
  if (candidates.length === 0) {
    return {
      outcome: "unavailable",
      detail: `no tag of ${args.url} matches ${args.range} (looking for tags named "${gitSemverTagName(args.tagPrefix, "X.Y.Z")}")`,
    };
  }
  if (args.probeCandidate === undefined) {
    const selected = candidates[0];
    return selected === undefined
      ? {
          outcome: "unavailable",
          detail: `no tag of ${args.url} matches ${args.range}`,
        }
      : { outcome: "resolved", ...selected };
  }
  let firstProblem: string | undefined;
  let probes = 0;
  for (const candidate of candidates) {
    if (probes >= MAX_GIT_CANDIDATE_PROBES) {
      return {
        outcome: "unavailable",
        detail: `no release of ${args.url} matching ${args.range} runs on this bb within the newest ${MAX_GIT_CANDIDATE_PROBES} releases`,
      };
    }
    probes += 1;
    const probed = await args.probeCandidate(candidate);
    if (probed.outcome === "compatible") {
      return { outcome: "resolved", ...candidate };
    }
    firstProblem ??=
      probed.outcome === "invalid" ? probed.detail : probed.reasons[0]?.message;
  }
  return {
    outcome: "unavailable",
    detail:
      firstProblem ??
      `no release of ${args.url} matching ${args.range} runs on this bb`,
  };
}
