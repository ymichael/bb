#!/usr/bin/env node
/**
 * Provider-literal ratchet (guardrail G1 of the provider-plugin migration).
 *
 * The migration's north star is that core (everything outside the provider
 * plugins) never branches on a specific provider id. Today it does so in many
 * places. This guard freezes that surface as a per-file count and lets it move
 * in one direction only: down. A change that adds a provider-id reference to a
 * core file, or introduces a new core file that carries one, fails. A change
 * that removes references must regenerate the committed baseline (`--write`) so
 * the win is a visible diff. When the baseline reaches zero the file and the
 * guard are deleted.
 *
 * Scope: provider-*id* references only — quoted id literals (`"codex"`,
 * `"claude-code"`, `"pi"`, `"acp-…"`, `"cursor"`) and the named id
 * constants/helpers (`isAcpProviderId`, `CODEX_PROVIDER_ID`,
 * `RESERVED_PROVIDER_ID_OWNERS`, …). Tool-name keying (thread-view's
 * Read/Task/TodoWrite tables) is retired by its own workstream and would add
 * false positives here, so it is not counted.
 *
 * The scanner is a pure function (`scanTree`) so it is covered by fixture
 * tests rather than by scanning the live repo. `provider-model-catalog.ts`
 * once put two ids on one line; this counts every occurrence, not matched
 * lines, so a second reference on an existing line still moves the number.
 *
 * Usage:
 *   node scripts/check-provider-literal-ratchet.mjs                 # check live vs committed baseline (exact)
 *   node scripts/check-provider-literal-ratchet.mjs --base origin/main  # also reject any increase vs the base branch (CI)
 *   node scripts/check-provider-literal-ratchet.mjs --write         # regenerate baseline (refuses to raise the total)
 *   node scripts/check-provider-literal-ratchet.mjs --list          # print every occurrence
 *
 * `BB_RATCHET_ROOT=<dir>` points the CLI at another tree (its baseline at
 * `<dir>/scripts/provider-literal-baseline.json`, its git history for
 * `--base`); the fixture tests drive the refusal paths through it.
 *
 * Allowlist: once the migration has moved every provider-id branch it can,
 * what remains in core is listed in the baseline's `allowlist` block with a
 * reason, an owner and when it dies. The check then requires every counted
 * file to be on that list (delete the reference or allowlist it) and every
 * entry to still match the live count (stale entries are removed, not kept).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SCAN_ROOTS = ["apps", "packages", "plugins"];

const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "generated",
  "bundled-types",
  "__fixtures__",
  "__snapshots__",
  "test",
  "tests",
  "testing",
  "e2e",
  ".turbo",
  ".ladle",
  ".storybook",
  "stories",
  "dev", // dev-only fixture screens (apps/mobile/src/screens/dev)
]);
/**
 * Provider implementations are allowed to name their own provider; the
 * ratchet exists to keep provider ids out of CORE. `plugins/provider-*` is
 * one such implementation, and so is the published ACP bridge kit — the same
 * code, moved into `packages/` so the plugin SDK can re-export it
 * (`@get-bb/plugin-sdk/provider-bridge/acp`). It carries no bb provider id
 * today: it selects behavior by the agent's dialect, never by a provider id.
 */
const EXCLUDED_PREFIXES = [
  join("plugins", "provider-"),
  // Account Pool proxies one named provider's traffic; it is provider-side
  // code like plugins/provider-*, not core.
  join("plugins", "account-pool"),
  join("packages", "provider-bridge-acp"),
  // Test-only helpers: they name providers so tests can pick a model.
  join("packages", "test-helpers"),
  join("examples", ""),
];
const EXCLUDED_FILE_RE =
  /\.(test|spec|stories)\.[cm]?[jt]sx?$|\.snap$|\.d\.ts$/;
const INCLUDED_FILE_RE = /\.[cm]?[jt]sx?$/; // ts tsx js jsx mjs cjs mts cts

/**
 * One global regex of every provider-id reference. Global + non-overlapping so
 * each textual occurrence is counted once. Quoted-id alternatives already
 * cover `providerId === "codex"` and `startsWith("acp-…")`, so those forms are
 * NOT listed separately — that would double-count the same line. Only the
 * named constants/helpers that are themselves the carve-out are added.
 */
export function providerLiteralRegex() {
  return new RegExp(
    [
      // quoted provider-id literals (acp-* allows the bare `"acp-"` of
      // startsWith). The Cursor agent's id is `acp-cursor`; a bare `"cursor"`
      // is an editor id or a pagination cursor, never a provider.
      String.raw`["'](?:codex|claude-code|pi|acp-[a-z0-9-]*)["']`,
      // named id constants / helpers
      String.raw`\bisAcpProviderId\b`,
      String.raw`\bACP_ID_PREFIX\b`,
      String.raw`\bCODEX_PROVIDER_ID\b`,
      String.raw`\bCLAUDE_CODE_PROVIDER_ID\b`,
      String.raw`\bRESERVED_PROVIDER_ID_OWNERS\b`,
      String.raw`\bPRODUCT_PROVIDER_ORDER\b`,
      String.raw`\bPRODUCT_DEFAULT_PROVIDER_ID\b`,
    ].join("|"),
    "g",
  );
}

function isIncluded(rel) {
  const parts = rel.split(sep);
  if (parts.some((p) => EXCLUDED_SEGMENTS.has(p))) return false;
  const name = parts[parts.length - 1];
  if (!INCLUDED_FILE_RE.test(name)) return false;
  if (EXCLUDED_FILE_RE.test(name)) return false;
  const posix = parts.join("/");
  if (EXCLUDED_PREFIXES.some((p) => posix.startsWith(p.split(sep).join("/")))) {
    return false;
  }
  return true;
}

function walk(dir, root, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
      walk(abs, root, out);
    } else if (entry.isFile()) {
      const rel = relative(root, abs);
      if (isIncluded(rel)) out.push({ abs, rel: rel.split(sep).join("/") });
    }
  }
}

/**
 * Pure scan of a tree. `roots` defaults to the migration scope; pass a subset
 * (or a fixture root's subdirs) in tests.
 * @returns {{files: Record<string, number>, total: number, hits: Array}}
 */
/**
 * Compare the live per-file counts with the baseline's allowlist. Returns
 * the problems as strings; an empty array means every counted file is
 * allowlisted at its current count and no entry is stale.
 */
export function checkAllowlist(scan, allowlist) {
  const problems = [];
  const entries = allowlist ?? {};
  for (const [rel, n] of Object.entries(scan.files)) {
    const entry = entries[rel];
    if (entry === undefined) {
      problems.push(
        `  ? ${rel}: ${n} reference(s) with no allowlist entry — delete them or allowlist the file with a reason, an owner and when it dies`,
      );
      continue;
    }
    if (entry.count !== n) {
      problems.push(
        `  ≠ ${rel}: allowlisted at ${entry.count}, live ${n} — update the entry`,
      );
    }
    for (const field of ["reason", "owner", "diesAt"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        problems.push(`  ! ${rel}: allowlist entry has no ${field}`);
      }
    }
  }
  for (const rel of Object.keys(entries)) {
    if (!(rel in scan.files)) {
      problems.push(`  − ${rel}: allowlisted but has no reference left — remove the entry`);
    }
  }
  return problems;
}

export function scanTree(root, roots = SCAN_ROOTS) {
  const files = [];
  for (const r of roots) walk(join(root, r), root, files);
  const counts = {};
  const hits = [];
  for (const { abs, rel } of files) {
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].match(providerLiteralRegex());
      if (matches) {
        count += matches.length;
        for (const m of matches) hits.push({ rel, line: i + 1, match: m });
      }
    }
    if (count > 0) counts[rel] = count;
  }
  const sorted = Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { files: sorted, total, hits };
}

function baselineFromGit(root, ref) {
  const raw = execFileSync(
    "git",
    ["show", `${ref}:scripts/provider-literal-baseline.json`],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  return JSON.parse(raw);
}

// --- CLI ---------------------------------------------------------------------
function main() {
  const ROOT =
    process.env.BB_RATCHET_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
  const BASELINE_PATH = join(ROOT, "scripts", "provider-literal-baseline.json");
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const baseIdx = argv.indexOf("--base");
  const baseRef = baseIdx >= 0 ? argv[baseIdx + 1] : null;

  const scan = scanTree(ROOT);

  if (flags.has("--list")) {
    for (const h of scan.hits) console.log(`${h.rel}:${h.line}  ${h.match}`);
    console.log(
      `\n${scan.total} provider-id references across ${Object.keys(scan.files).length} core files`,
    );
    return 0;
  }

  let committed = null;
  try {
    committed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    if (!flags.has("--write")) {
      console.error(
        "No baseline. Run: node scripts/check-provider-literal-ratchet.mjs --write",
      );
      return 2;
    }
  }

  if (flags.has("--write")) {
    if (
      committed &&
      scan.total > committed.total &&
      process.env.BB_RATCHET_ALLOW_INCREASE !== "1"
    ) {
      console.error(
        `Refusing to raise the baseline (${committed.total} → ${scan.total}). The ratchet only goes down.`,
      );
      console.error(
        "If a new core provider-id reference is genuinely unavoidable this layer, set BB_RATCHET_ALLOW_INCREASE=1 AND open a follow-up task to remove it.",
      );
      return 1;
    }
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          _comment:
            "Provider-literal ratchet (G1). Per-file occurrence count of provider-ID references in core. May only go DOWN. Regenerate: node scripts/check-provider-literal-ratchet.mjs --write. Every counted file must have an `allowlist` entry (count, reason, owner, diesAt); the entries are authored by hand and survive --write. Delete this file and the guard when empty.",
          total: scan.total,
          files: scan.files,
          allowlist: committed?.allowlist ?? {},
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      `Wrote baseline: ${scan.total} references across ${Object.keys(scan.files).length} files.`,
    );
    return 0;
  }

  // Base-branch guard: reject any increase vs the base branch, so an author
  // cannot add a reference, run --write, and pass CI on the raised baseline.
  if (baseRef) {
    let base;
    try {
      base = baselineFromGit(ROOT, baseRef);
    } catch {
      // Bootstrap or unreachable base: no committed baseline on the base ref
      // yet, so there is nothing to ratchet against. The exact committed-vs-live
      // check below still guards this run.
      console.log(
        `No baseline on ${baseRef}; skipping the base-branch comparison.`,
      );
      base = null;
    }
    if (base) {
      const bad = [];
      for (const [rel, n] of Object.entries(scan.files)) {
        const was = base.files[rel] ?? 0;
        if (n > was) bad.push(`  ↑ ${rel}: ${was} → ${n}`);
      }
      if (bad.length) {
        console.error(
          `Provider-literal ratchet FAILED vs ${baseRef} — core gained provider-id references:\n${bad.join("\n")}`,
        );
        console.error(
          "The migration only removes these. Regenerating the committed baseline does not bypass this check.",
        );
        return 1;
      }
    }
  }

  // Committed baseline must match live exactly, so reductions are recorded and
  // additions on unchanged files are caught even without --base.
  const increased = [],
    newFiles = [],
    decreased = [],
    removed = [];
  for (const [rel, n] of Object.entries(scan.files)) {
    if (!(rel in committed.files)) newFiles.push(`  + ${rel}: ${n}`);
    else if (n > committed.files[rel])
      increased.push(`  ↑ ${rel}: ${committed.files[rel]} → ${n}`);
    else if (n < committed.files[rel])
      decreased.push(`  ↓ ${rel}: ${committed.files[rel]} → ${n}`);
  }
  for (const rel of Object.keys(committed.files))
    if (!(rel in scan.files)) removed.push(`  − ${rel}`);

  if (increased.length || newFiles.length) {
    console.error(
      "Provider-literal ratchet FAILED — core gained provider-id references.\n" +
        [...increased, ...newFiles].join("\n"),
    );
    console.error("\nDo not add a provider-id branch to core.");
    return 1;
  }
  if (decreased.length || removed.length) {
    console.error(
      "Provider-literal ratchet: references DECREASED but the committed baseline was not regenerated.\n" +
        [...decreased, ...removed].join("\n"),
    );
    console.error(
      "\nGood — lock it in: node scripts/check-provider-literal-ratchet.mjs --write, then commit the baseline.",
    );
    return 1;
  }
  const allowlistProblems = checkAllowlist(scan, committed.allowlist);
  if (allowlistProblems.length) {
    console.error(
      "Provider-literal ratchet FAILED — core references outside the allowlist.\n" +
        allowlistProblems.join("\n"),
    );
    return 1;
  }
  console.log(
    `Provider-literal ratchet OK: ${scan.total} references across ${Object.keys(scan.files).length} core files, all allowlisted.`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
