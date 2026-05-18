import fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const journalPath = resolve(
  __dirname,
  "..",
  "drizzle",
  "meta",
  "_journal.json",
);

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

const latestSquashedMigrationWhen = 1778891867195;
const baselineTag = "0000_baseline";
const publishedMigrationWhens = new Map<string, number>([
  ["0000_baseline", 1778891867195],
  ["0001_terminal_session_user_input", 1779139400000],
  ["0002_closed_session_prune_indexes", 1779139400001],
]);

function readJournal(): Journal {
  return JSON.parse(fs.readFileSync(journalPath, "utf-8")) as Journal;
}

describe("migration journal integrity", () => {
  it("has strictly increasing `when` timestamps", () => {
    const { entries } = readJournal();

    const violations: string[] = [];
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].when <= entries[i - 1].when) {
        violations.push(
          `entries[${i}] ${entries[i].tag} (when=${entries[i].when}) <= ` +
            `entries[${i - 1}] ${entries[i - 1].tag} (when=${entries[i - 1].when})`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("has `idx` values matching array position", () => {
    const { entries } = readJournal();

    const mismatches: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].idx !== i) {
        mismatches.push(
          `entries[${i}] ${entries[i].tag} has idx=${entries[i].idx}, expected ${i}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it("has a matching .sql file for every journal entry", () => {
    const { entries } = readJournal();
    const drizzleDir = resolve(__dirname, "..", "drizzle");

    const missing: string[] = [];
    for (const entry of entries) {
      const sqlPath = resolve(drizzleDir, `${entry.tag}.sql`);
      if (!fs.existsSync(sqlPath)) {
        missing.push(entry.tag);
      }
    }

    expect(missing).toEqual([]);
  });

  it("preserves published migration timestamps", () => {
    const { entries } = readJournal();

    const violations: string[] = [];
    for (const entry of entries) {
      const expectedWhen = publishedMigrationWhens.get(entry.tag);
      if (expectedWhen !== undefined && entry.when !== expectedWhen) {
        violations.push(
          `${entry.tag} has when=${entry.when}, expected published when=${expectedWhen}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps post-baseline migrations after the squashed migration history", () => {
    const { entries } = readJournal();
    const baseline = entries.find((entry) => entry.tag === baselineTag);

    expect(baseline).toBeDefined();

    const violations = entries
      .filter((entry) => entry.tag !== baselineTag)
      .filter((entry) => entry.when <= latestSquashedMigrationWhen)
      .map(
        (entry) =>
          `${entry.tag} has when=${entry.when}, expected > ${latestSquashedMigrationWhen}`,
      );

    expect(violations).toEqual([]);
  });
});
