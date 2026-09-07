import { z } from "zod";
import { pluginCatalogCategoryIdSchema } from "./plugin-catalog-category.js";

const MARKETPLACE_MAX_SCREENSHOTS = 6;
export const MARKETPLACE_OVERVIEW_MAX_CHARS = 4000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/u;
const HOST_ICON_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;
const HTTPS_URL_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]:\/\//u;
const ICON_URL_PATTERN =
  /^(?:(?![A-Za-z][A-Za-z0-9+.-]*:)|(?=[Hh][Tt][Tt][Pp][Ss]:))[^\s]*\.(?:[Ss][Vv][Gg]|[Pp][Nn][Gg]|[Ww][Ee][Bb][Pp])(?:[?#][^\s]*)?$/u;
const V2_ICON_URL_PATTERN =
  /^(?!http:)(?:[Hh][Tt][Tt][Pp][Ss]:\/\/)?[^\s]+\.(?:[Ss][Vv][Gg]|[Pp][Nn][Gg]|[Ww][Ee][Bb][Pp])$/u;
const SCREENSHOT_URL_PATTERN =
  /^(?:[Hh][Tt][Tt][Pp][Ss]:\/\/[^\s]+\.(?:[Pp][Nn][Gg]|[Jj][Pp][Ee]?[Gg]|[Ww][Ee][Bb][Pp])|\.\/screenshots\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:[Pp][Nn][Gg]|[Jj][Pp][Ee]?[Gg]|[Ww][Ee][Bb][Pp]))$/u;
const NPM_PACKAGE_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const GIT_SUBDIR_PATTERN =
  /^(?![A-Za-z]:)(?!\/)(?!(?:[^/]+\/)*(?:\.|\.\.|\.git)(?:\/|$))[^/\\]+(?:\/[^/\\]+)*$/u;
const GIT_REF_PATTERN =
  /^(?!-)(?![\s\S]*\.\.)(?![\s\S]*@)(?![\s\S]*:)[\s\S]+$/u;
const GIT_TAG_PREFIX_PATTERN =
  /^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?![^/]*\.lock(?:\/|$))(?!.*\/[^/]*\.lock(?:\/|$))(?!.*\.$)[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const DATE_TIME_SEPARATOR_PATTERN = /t|\s/iu;
const TIME_WITH_OFFSET_PATTERN =
  /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)$/iu;

const SEMVER_NUMBER = String.raw`(?:0|[1-9]\d*|[xX*])`;
const SEMVER_PRERELEASE = String.raw`(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const SEMVER_BUILD = String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const SEMVER_VERSION = String.raw`v?${SEMVER_NUMBER}(?:\.${SEMVER_NUMBER}(?:\.${SEMVER_NUMBER})?)?${SEMVER_PRERELEASE}${SEMVER_BUILD}`;
const SEMVER_COMPARATOR = String.raw`(?:[<>]=?|==?|~>?|\^)?\s*${SEMVER_VERSION}`;
const SEMVER_SET = String.raw`(?:\*|${SEMVER_VERSION}\s+-\s+${SEMVER_VERSION}|${SEMVER_COMPARATOR}(?:\s+${SEMVER_COMPARATOR})*|)`;

const MARKETPLACE_SEMVER_RANGE_PATTERN = new RegExp(
  String.raw`^\s*${SEMVER_SET}(?:\s*\|\|\s*${SEMVER_SET})*\s*$`,
  "u",
);

const semverRangeSchema = z
  .string()
  .min(1)
  .regex(MARKETPLACE_SEMVER_RANGE_PATTERN);
const semverRangeV2Schema = z.string().min(1);
const httpsUrlSchema = z.string().regex(HTTPS_URL_PATTERN);
const isoDateSchema = z.iso.date();
const marketplaceDateTimeSchema = z.string().refine((value) => {
  const parts = value.split(DATE_TIME_SEPARATOR_PATTERN);
  if (parts.length !== 2 || !isoDateSchema.safeParse(parts[0]).success) {
    return false;
  }
  const match = TIME_WITH_OFFSET_PATTERN.exec(parts[1] ?? "");
  if (match === null) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const offsetSign = match[5] === "-" ? -1 : 1;
  const offsetHour = Number(match[6] ?? 0);
  const offsetMinute = Number(match[7] ?? 0);
  if (offsetHour > 23 || offsetMinute > 59) return false;
  if (hour <= 23 && minute <= 59 && second < 60) return true;
  const utcMinute = minute - offsetMinute * offsetSign;
  const utcHour = hour - offsetHour * offsetSign - (utcMinute < 0 ? 1 : 0);
  return (
    (utcHour === 23 || utcHour === -1) &&
    (utcMinute === 59 || utcMinute === -1) &&
    second < 61
  );
});
const marketplaceScreenshotSchema = z
  .string()
  .min(1)
  .regex(
    SCREENSHOT_URL_PATTERN,
    "must be an https URL or relative .png, .jpg, .jpeg, or .webp asset",
  );

function marketplaceIconSchema(strict: boolean) {
  const url = z
    .string()
    .min(1)
    .regex(
      strict ? ICON_URL_PATTERN : V2_ICON_URL_PATTERN,
      "must be an https URL or relative .svg, .png, or .webp asset",
    );
  const object = z.object({ url });
  return z.union([
    z.string().regex(HOST_ICON_PATTERN),
    strict ? object.strict() : object,
  ]);
}

function marketplaceAuthorSchema(strict: boolean) {
  const object = z.object({
    name: z.string().min(1),
    github: z.string().regex(GITHUB_LOGIN_PATTERN).optional(),
    url: httpsUrlSchema.optional(),
  });
  return strict ? object.strict() : object;
}

function marketplaceNpmSourceSchema(strict: boolean) {
  const npm = z
    .object({
      package: z
        .string()
        .regex(NPM_PACKAGE_PATTERN, "must be an unambiguous npm package name"),
      range: (strict ? semverRangeSchema : semverRangeV2Schema).optional(),
      tag: z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9._-]*$/u)
        .optional(),
      registry: httpsUrlSchema.optional(),
    })
    .refine((value) => value.range === undefined || value.tag === undefined, {
      message: "range and tag are mutually exclusive",
    });
  const nested = npm.strict();
  const object = z.object({ npm: nested });
  return object.strict();
}

function marketplaceGitSourceSchema(strict: boolean) {
  const base = {
    url: httpsUrlSchema,
    subdir: z.string().regex(GIT_SUBDIR_PATTERN).optional(),
  };
  const ref = z.object({
    ...base,
    ref: z
      .string()
      .regex(GIT_REF_PATTERN, "git ref must round-trip through install syntax"),
  });
  const range = z.object({
    ...base,
    range: strict ? semverRangeSchema : semverRangeV2Schema,
    tagPrefix: z.string().max(128).regex(GIT_TAG_PREFIX_PATTERN).optional(),
  });
  const refObject = z.object({ git: ref.strict() }).strict();
  const rangeObject = z.object({ git: range.strict() }).strict();
  return z.union([refObject, rangeObject]);
}

function marketplaceBundledSourceSchema() {
  return z
    .object({
      bundled: z
        .object({
          plugin: z.string().regex(NAME_PATTERN),
        })
        .strict(),
    })
    .strict();
}

function marketplaceSourceSchema(strict: boolean) {
  const npm = marketplaceNpmSourceSchema(strict);
  const git = marketplaceGitSourceSchema(strict);
  return strict
    ? z.union([npm, git])
    : z.union([npm, git, marketplaceBundledSourceSchema()]);
}

const marketplaceEntryIdentityShape = (strict: boolean) => ({
  id: z.string().regex(NAME_PATTERN),
  displayName: z.string().min(1),
  description: z.string().min(1),
  icon: marketplaceIconSchema(strict),
});

const marketplaceEntryMetadataShape = (strict: boolean) => ({
  tags: z.array(z.string().max(32).regex(TAG_PATTERN)).max(10).optional(),
  author: marketplaceAuthorSchema(strict),
  source: marketplaceSourceSchema(strict),
});

export const marketplaceEntryV1Schema = z
  .object({
    ...marketplaceEntryIdentityShape(true),
    ...marketplaceEntryMetadataShape(true),
  })
  .strict();

export const marketplaceEntryV2Schema = z.object({
  ...marketplaceEntryIdentityShape(false),
  category: pluginCatalogCategoryIdSchema.optional(),
  screenshots: z
    .array(marketplaceScreenshotSchema)
    .max(MARKETPLACE_MAX_SCREENSHOTS)
    .optional(),
  overview: z.string().min(1).optional(),
  publishedAt: marketplaceDateTimeSchema.optional(),
  updatedAt: marketplaceDateTimeSchema.optional(),
  ...marketplaceEntryMetadataShape(false),
});

export type MarketplaceEntryV1 = z.infer<typeof marketplaceEntryV1Schema>;
export type MarketplaceEntryV2 = z.infer<typeof marketplaceEntryV2Schema>;
export type MarketplaceEntrySource = MarketplaceEntryV2["source"];
