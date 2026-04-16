import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMatchingThreadIdsSql,
  buildMatchingThreadPreviewSql,
  escapeSqlString,
  parseArchiveTmpBbSessionsArgs,
  parseThreadPreviewRows,
  renderHelpText,
  resolveCodexStateDbPath,
} from "../src/commands/archive-codex-tmp-bb-sessions.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("archive-codex-tmp-bb-sessions", () => {
  it("defaults to archiving /tmp/bb-* sessions from ~/.codex", () => {
    const parsedArgs = parseArchiveTmpBbSessionsArgs(
      [],
      { CODEX_BIN: "/custom/codex" },
      "/Users/tester",
    );

    expect(parsedArgs.help).toBe(false);
    expect(parsedArgs.options).toEqual({
      codexBin: "/custom/codex",
      codexHome: path.join("/Users/tester", ".codex"),
      concurrency: 25,
      dryRun: false,
      pattern: "/tmp/bb-*",
      yes: false,
    });
  });

  it("parses explicit cleanup options", () => {
    const parsedArgs = parseArchiveTmpBbSessionsArgs(
      [
        "--",
        "--dry-run",
        "--yes",
        "--pattern",
        "/tmp/custom-bb-*",
        "--codex-home=~/custom-codex",
        "--codex-bin",
        "~/bin/codex",
        "--concurrency=7",
      ],
      {},
      "/Users/tester",
    );

    expect(parsedArgs.options).toEqual({
      codexBin: path.join("/Users/tester", "bin", "codex"),
      codexHome: path.join("/Users/tester", "custom-codex"),
      concurrency: 7,
      dryRun: true,
      pattern: "/tmp/custom-bb-*",
      yes: true,
    });
  });

  it("rejects unknown or incomplete options", () => {
    expect(() => parseArchiveTmpBbSessionsArgs(["--wat"], {}, "/tmp")).toThrow(
      "Unknown option: --wat",
    );
    expect(() => parseArchiveTmpBbSessionsArgs(["--pattern"], {}, "/tmp")).toThrow(
      "Missing value for --pattern",
    );
    expect(() =>
      parseArchiveTmpBbSessionsArgs(["--concurrency", "0"], {}, "/tmp"),
    ).toThrow("--concurrency must be a positive integer");
  });

  it("documents the command and default pattern", () => {
    expect(renderHelpText()).toContain("pnpm codex:archive-tmp-bb-sessions");
    expect(renderHelpText()).toContain("/tmp/bb-*");
    expect(renderHelpText()).toContain("state_<n>.sqlite");
  });

  it("resolves the highest numbered Codex state DB", () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    tempDirs.push(codexHome);
    writeFileSync(path.join(codexHome, "state_4.sqlite"), "");
    writeFileSync(path.join(codexHome, "state_4.sqlite-wal"), "");
    writeFileSync(path.join(codexHome, "state_5.sqlite"), "");
    writeFileSync(path.join(codexHome, "state_5.sqlite.backup-old"), "");

    expect(resolveCodexStateDbPath(codexHome)).toBe(
      path.join(codexHome, "state_5.sqlite"),
    );
  });

  it("reports when no Codex state DB exists", () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    tempDirs.push(codexHome);

    expect(() => resolveCodexStateDbPath(codexHome)).toThrow(
      `No Codex state DB found in ${codexHome}`,
    );
  });

  it("escapes SQLite string values used in generated queries", () => {
    expect(escapeSqlString("/tmp/bb-o'clock-*")).toBe("/tmp/bb-o''clock-*");
    expect(buildMatchingThreadIdsSql("/tmp/bb-o'clock-*")).toContain(
      "cwd GLOB '/tmp/bb-o''clock-*'",
    );
    expect(buildMatchingThreadPreviewSql("/tmp/bb-*")).toContain(
      "ORDER BY updated_at DESC LIMIT 10",
    );
  });

  it("parses sqlite preview rows", () => {
    const separator = "\u001f";
    const rows = parseThreadPreviewRows(
      [
        ["thr_1", "2026-04-15 13:40:15", "/tmp/bb-integ-one"].join(separator),
        ["thr_2", "2026-04-15 13:39:51", "/tmp/bb-integration-two"].join(separator),
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        cwd: "/tmp/bb-integ-one",
        id: "thr_1",
        updatedAt: "2026-04-15 13:40:15",
      },
      {
        cwd: "/tmp/bb-integration-two",
        id: "thr_2",
        updatedAt: "2026-04-15 13:39:51",
      },
    ]);
  });
});
